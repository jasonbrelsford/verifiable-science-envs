"""
Pinned-release loader for the IPD-IMGT/HLA nomenclature files.

Reads the eight public text files published by the IPD team on the ANHIG/IMGTHLA
GitHub mirror at a specific git tag (e.g. ``v3.65.0-alpha``), verifies them
against the release's own ``md5checksum.txt``, and exposes the queries the
family-A task generator and grader need (see docs/TASK_SPEC.md §2, §9.1).

Licensing posture (docs/research-04): IPD-IMGT/HLA is CC-BY-ND. This module
FETCHES the files at runtime into a local cache; nothing here rewrites or
redistributes them. Attribution: Barker DJ et al., Nucleic Acids Research 2025.

No third-party dependencies. Python 3.10+.
"""

from __future__ import annotations

import hashlib
import re
import urllib.request
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Iterable, Optional

RAW_BASE = "https://raw.githubusercontent.com/ANHIG/IMGTHLA/{tag}/{path}"

ROOT_FILES = [
    "Allelelist.txt",
    "Allelelist_history.txt",
    "Deleted_alleles.txt",
    "Allele_status.txt",
    "md5checksum.txt",
]
WMDA_FILES = [
    "wmda/hla_nom_g.txt",
    "wmda/hla_nom_p.txt",
    "wmda/rel_dna_ser.txt",
    "wmda/rel_ser_ser.txt",
    "wmda/md5checksum.txt",
]
ALL_FILES = ROOT_FILES + WMDA_FILES

# Loci in scope for family A (TASK_SPEC §2).
LOCI_IN_SCOPE = ("A", "B", "C", "DRB1", "DRB3", "DRB4", "DRB5", "DQA1", "DQB1", "DPA1", "DPB1")
CLASS_I = {"A", "B", "C"}

# Current-style allele name: LOCUS*dd[:dd[:dd[:dd]]][suffix]
ALLELE_RE = re.compile(r"^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,3})([NLSCAQ]?)$")
# Legacy 4-digit style without colons (A*0101, A*020120, Cw*0702)
LEGACY_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{4,})([NLSCAQ]?)$")
# Loose grammar used for hallucination extraction from free text (GRADER_SPEC §3.4)
ALLELE_TOKEN_RE = re.compile(r"(?:HLA-)?[A-Z]+[0-9]*\*\d{2,}(?::\d{2,}){0,3}[NLSCAQGP]?(?![\w:])")
GROUP_RE = re.compile(r"^([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,2})([GP])$")

_SUCCESSOR_RE = re.compile(
    r"(?:identical to|renamed(?: as| to)?|renamed and extended to|is identical to)\s+([A-Z]+[0-9]*\*[0-9:]+[NLSCAQ]?)"
)


class ImgtError(Exception):
    pass


class ReleaseMismatch(ImgtError):
    pass


@dataclass(frozen=True)
class Serology:
    allele: str
    unambiguous: tuple[str, ...]
    possible: tuple[str, ...]
    assumed: tuple[str, ...]
    expert: tuple[str, ...]

    @property
    def best(self) -> tuple[str, ...]:
        """The most confident non-empty assignment, in WMDA column order."""
        for col in (self.unambiguous, self.possible, self.assumed, self.expert):
            if col:
                return col
        return ()

    @property
    def certain(self) -> bool:
        return bool(self.unambiguous)


@dataclass(frozen=True)
class DeletedAllele:
    hla_id: str
    name: str
    description: str

    @property
    def successor(self) -> Optional[str]:
        m = _SUCCESSOR_RE.search(self.description)
        return m.group(1) if m else None

    @property
    def reason(self) -> str:
        """Categorical reason per TASK_SPEC Tier 3 ``deleted_reason``."""
        d = self.description.lower()
        if "low levels" in d or "low expression" in d:
            return "low_expression_renamed"
        if "identical" in d:
            return "identical_sequence"
        if "in error" in d and "renamed" in d:
            return "named_in_error"
        if "extended" in d and "renamed" in d:
            return "renamed_extended"
        if "renamed" in d:
            return "renamed_extended"
        return "other"


@dataclass(frozen=True)
class AlleleStatus:
    allele: str
    cells: int
    groups: int
    confirmed: bool
    start: int
    end: int
    partial: bool
    type: str


def release_code_to_str(code: str) -> str:
    """'3650' -> '3.65.0'; '1050' -> '1.05.0'; '327' -> '3.27.0'."""
    code = code.strip()
    if len(code) == 3:
        return f"{code[0]}.{code[1:]}.0"
    if len(code) == 4:
        return f"{code[0]}.{code[1:3]}.{code[3]}"
    raise ImgtError(f"unrecognised release code {code!r}")


def release_str_to_code(rel: str) -> str:
    """'3.65.0' -> '3650'."""
    m = re.fullmatch(r"(\d)\.(\d{2})\.(\d)", rel.strip())
    if not m:
        raise ImgtError(f"unrecognised release string {rel!r}")
    return f"{m.group(1)}{m.group(2)}{m.group(3)}"


def _release_key(rel: str) -> tuple[int, int, int]:
    a, b, c = rel.split(".")
    return int(a), int(b), int(c)


def split_allele(name: str) -> tuple[str, list[str], str]:
    """'A*01:01:01:02N' -> ('A', ['01','01','01','02'], 'N'). Raises on legacy/invalid."""
    if is_legacy_name(name):
        raise ImgtError(f"legacy (pre-2010, colon-less) allele name: {name!r}")
    m = ALLELE_RE.match(name.strip())
    if not m:
        raise ImgtError(f"not a current-style allele name: {name!r}")
    locus, fields, suffix = m.group(1), m.group(2).split(":"), m.group(3)
    return locus, fields, suffix


def is_legacy_name(name: str) -> bool:
    """Colon-less names with 4+ digits (A*0101, Cw*0702, A*020120) are the
    pre-2010 nomenclature. No current name is colon-less with 4+ digits."""
    n = name.strip()
    return ":" not in n and bool(LEGACY_RE.match(n))


def locus_of(name: str) -> str:
    return split_allele(name)[0]


def is_class_I(locus: str) -> bool:
    return locus in CLASS_I


def fields_of(name: str) -> int:
    return len(split_allele(name)[1])


def truncate(name: str, n: int, keep_suffix: bool = True) -> str:
    """Reduce to the first n fields. Suffix handling is the caller's job (see
    ImgtReference.reduce for the release-aware rule)."""
    locus, fields, suffix = split_allele(name)
    if n < 1 or n > len(fields):
        raise ImgtError(f"cannot truncate {name} to {n} fields")
    out = f"{locus}*{':'.join(fields[:n])}"
    if keep_suffix and suffix and n == len(fields):
        out += suffix
    return out


class ImgtReference:
    """All queries against one pinned IPD-IMGT/HLA release."""

    def __init__(self, tag: str, root: Path):
        self.tag = tag
        self.root = Path(root)
        self._cache: dict = {}

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, tag: str, cache_dir: str | Path = "~/.cache/sci_envs/imgt", fetch: bool = True,
             verify: bool = True) -> "ImgtReference":
        root = Path(cache_dir).expanduser() / tag
        missing = [f for f in ALL_FILES if not (root / f).exists()]
        if missing:
            if not fetch:
                raise ImgtError(f"missing files for {tag} and fetch=False: {missing}")
            for f in missing:
                (root / f).parent.mkdir(parents=True, exist_ok=True)
                url = RAW_BASE.format(tag=tag, path=f)
                with urllib.request.urlopen(url, timeout=60) as r, open(root / f, "wb") as out:
                    out.write(r.read())
        ref = cls(tag, root)
        if verify:
            ref.verify()
        return ref

    def _read(self, rel_path: str) -> list[str]:
        key = ("lines", rel_path)
        if key not in self._cache:
            with open(self.root / rel_path, encoding="utf-8") as fh:
                self._cache[key] = [ln.rstrip("\n") for ln in fh if not ln.startswith("#")]
        return self._cache[key]

    def _header(self, rel_path: str) -> dict[str, str]:
        out = {}
        with open(self.root / rel_path, encoding="utf-8") as fh:
            for ln in fh:
                if not ln.startswith("#"):
                    break
                if ":" in ln:
                    k, v = ln[1:].split(":", 1)
                    out[k.strip()] = v.strip()
        return out

    def md5(self, rel_path: str) -> str:
        h = hashlib.md5()
        with open(self.root / rel_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    @cached_property
    def expected_md5s(self) -> dict[str, str]:
        out = {}
        for sumfile, prefix in (("md5checksum.txt", ""), ("wmda/md5checksum.txt", "wmda/")):
            for ln in self._read(sumfile):
                m = re.match(r"MD5 \((.+?)\) = ([0-9a-f]{32})", ln)
                if m:
                    out[prefix + m.group(1)] = m.group(2)
        return out

    def verify(self) -> dict[str, str]:
        """Check every loaded data file against the release's md5checksum.txt."""
        actual = {}
        for f in ALL_FILES:
            if f.endswith("md5checksum.txt"):
                continue
            exp = self.expected_md5s.get(f)
            got = self.md5(f)
            actual[f] = got
            if exp and exp != got:
                raise ImgtError(f"md5 mismatch for {f} at {self.tag}: expected {exp}, got {got}")
        return actual

    @cached_property
    def release(self) -> str:
        v = self._header("Allelelist.txt").get("version", "")
        m = re.search(r"(\d+\.\d+\.\d+)", v)
        if not m:
            raise ImgtError(f"could not read release from Allelelist.txt header: {v!r}")
        return m.group(1)

    @cached_property
    def manifest(self) -> dict:
        return {
            "db": "IPD-IMGT/HLA",
            "release": self.release,
            "tag": self.tag,
            "md5": {f: self.md5(f) for f in ALL_FILES if not f.endswith("md5checksum.txt")},
            "attribution": "Barker DJ et al., Nucleic Acids Research 2025 (IPD-IMGT/HLA); CC-BY-ND",
        }

    # ------------------------------------------------------------ allele list
    @cached_property
    def _allele_rows(self) -> list[tuple[str, str]]:
        rows = []
        for ln in self._read("Allelelist.txt"):
            if ln.startswith("AlleleID") or not ln:
                continue
            hid, name = ln.split(",", 1)
            rows.append((hid, name))
        return rows

    @cached_property
    def name_to_id(self) -> dict[str, str]:
        return {n: h for h, n in self._allele_rows}

    @cached_property
    def id_to_name(self) -> dict[str, str]:
        return {h: n for h, n in self._allele_rows}

    def alleles(self, locus: Optional[str] = None) -> list[str]:
        if locus is None:
            return [n for _, n in self._allele_rows]
        pfx = f"{locus}*"
        return [n for _, n in self._allele_rows if n.startswith(pfx)]

    def exists(self, name: str) -> bool:
        return name in self.name_to_id

    def hla_id(self, name: str) -> str:
        try:
            return self.name_to_id[name]
        except KeyError:
            raise ImgtError(f"{name} is not an allele in release {self.release}") from None

    def expand(self, prefix: str) -> list[str]:
        """All full allele names under a 1–3 field prefix, matched at field
        boundaries (so 'A*01:01' does not match 'A*01:010')."""
        locus, fields, suffix = split_allele(prefix)
        if suffix:
            raise ImgtError("expand() takes a prefix without expression suffix")
        head = f"{locus}*{':'.join(fields)}"
        out = []
        for n in self.alleles(locus):
            if n == head or n.startswith(head + ":"):
                out.append(n)
            elif n.startswith(head) and n[len(head):] and n[len(head):] in "NLSCAQ":
                out.append(n)  # exact prefix with only a suffix appended
        return out

    def reduce(self, name: str, n: int) -> str:
        """Release-aware truncation with the expression-suffix rule from
        TASK_SPEC T1 ``truncate``: the reduced name keeps a suffix only if
        every allele under the reduced prefix carries that same suffix."""
        locus, fields, suffix = split_allele(name)
        base = truncate(name, n, keep_suffix=False)
        if not suffix:
            return base
        members = self.expand(base)
        if members and all(split_allele(m)[2] == suffix for m in members):
            return base + suffix
        return base

    # ---------------------------------------------------------------- history
    @cached_property
    def _history(self) -> tuple[list[str], dict[str, list[Optional[str]]]]:
        lines = self._read("Allelelist_history.txt")
        header = lines[0].split(",")
        releases = [release_code_to_str(c) for c in header[1:]]
        table: dict[str, list[Optional[str]]] = {}
        for ln in lines[1:]:
            if not ln:
                continue
            parts = ln.split(",")
            table[parts[0]] = [None if p == "NA" or p == "" else p for p in parts[1:]]
        return releases, table

    @property
    def releases(self) -> list[str]:
        """All releases covered by the history file, newest first."""
        return list(self._history[0])

    def _rel_index(self, release: str) -> int:
        try:
            return self._history[0].index(release)
        except ValueError:
            raise ImgtError(f"release {release} not in history for {self.tag}") from None

    def name_at(self, hla_id: str, release: str) -> Optional[str]:
        rels, table = self._history
        row = table.get(hla_id)
        if row is None:
            raise ImgtError(f"unknown HLA ID {hla_id}")
        return row[self._rel_index(release)]

    def history(self, hla_id: str) -> dict[str, Optional[str]]:
        rels, table = self._history
        return dict(zip(rels, table[hla_id]))

    @cached_property
    def _name_index(self) -> dict[str, list[tuple[str, int]]]:
        """name -> [(hla_id, release_index)] for every name ever used."""
        idx: dict[str, list[tuple[str, int]]] = {}
        _, table = self._history
        for hid, row in table.items():
            for i, nm in enumerate(row):
                if nm:
                    idx.setdefault(nm, []).append((hid, i))
        return idx

    def exists_at(self, name: str, release: str) -> bool:
        ri = self._rel_index(release)
        return any(i == ri for _, i in self._name_index.get(name, ()))

    def first_release(self, name: str) -> Optional[str]:
        """Earliest release in which this exact name appears (any HLA ID)."""
        hits = self._name_index.get(name)
        if not hits:
            return None
        rels = self._history[0]
        return rels[max(i for _, i in hits)]  # columns are newest-first

    def ids_for_name_ever(self, name: str) -> set[str]:
        return {h for h, _ in self._name_index.get(name, ())}

    def added_between(self, older: str, newer: str, locus: Optional[str] = None) -> int:
        """Count of HLA IDs that have a name at `newer` but not at `older`."""
        io, inew = self._rel_index(older), self._rel_index(newer)
        _, table = self._history
        n = 0
        for row in table.values():
            nm = row[inew]
            if nm and not row[io] and (locus is None or nm.startswith(f"{locus}*")):
                n += 1
        return n

    # ---------------------------------------------------------------- deleted
    @cached_property
    def deleted(self) -> dict[str, DeletedAllele]:
        out = {}
        for ln in self._read("Deleted_alleles.txt"):
            if not ln or ln.startswith("AlleleID"):
                continue
            hid, name, desc = ln.split(",", 2)
            out[name] = DeletedAllele(hid, name, desc)
        return out

    def is_deleted(self, name: str) -> bool:
        return name in self.deleted

    def renamed_to(self, name: str) -> Optional[str]:
        """Current name for a deleted/old name, or None if no successor.

        Order: (1) explicit successor in the deletion note, resolved to its
        current name if it was itself renamed later; (2) the deleted entry's
        HLA ID still has a current name; (3) the name appears in history for an
        ID that is current today."""
        d = self.deleted.get(name)
        if d:
            s = d.successor
            if s:
                return self._current_name_for(s)
            cur = self.id_to_name.get(d.hla_id)
            if cur:
                return cur
        for hid in sorted(self.ids_for_name_ever(name)):
            cur = self.id_to_name.get(hid)
            if cur and cur != name:
                return cur
        return None

    def _current_name_for(self, name: str, _depth: int = 0) -> str:
        if self.exists(name) or _depth > 5:
            return name
        d = self.deleted.get(name)
        if d and d.successor and d.successor != name:
            return self._current_name_for(d.successor, _depth + 1)
        cur = self.id_to_name.get(d.hla_id) if d else None
        return cur or name

    # ----------------------------------------------------------------- status
    @cached_property
    def status(self) -> dict[str, AlleleStatus]:
        out = {}
        for ln in self._read("Allele_status.txt"):
            if not ln or ln.startswith("Allele,"):
                continue
            a, cells, groups, conf, start, end, partial, typ = ln.split(",")
            out[a] = AlleleStatus(a, int(cells or 0), int(groups or 0), conf == "Confirmed",
                                  int(start or 0), int(end or 0), partial != "Full", typ)
        return out

    def confirmed(self, name: str) -> bool:
        st = self.status.get(name)
        return bool(st and st.confirmed)

    # --------------------------------------------------------------- G/P groups
    def _load_groups(self, rel_path: str, letter: str) -> tuple[dict[str, str], dict[str, list[str]]]:
        allele_to_group: dict[str, str] = {}
        members: dict[str, list[str]] = {}
        for ln in self._read(rel_path):
            if not ln:
                continue
            locus, mem, grp = ln.split(";")
            if not grp:
                continue  # allele stands alone; not in any group
            gname = f"{locus}{grp}"
            names = [f"{locus}{m}" for m in mem.split("/") if m]
            members[gname] = names
            for n in names:
                allele_to_group[n] = gname
        return allele_to_group, members

    @cached_property
    def _g(self):
        return self._load_groups("wmda/hla_nom_g.txt", "G")

    @cached_property
    def _p(self):
        return self._load_groups("wmda/hla_nom_p.txt", "P")

    def g_group(self, allele: str) -> Optional[str]:
        """G group of a full allele name, or None if it is not in any G group."""
        return self._g[0].get(allele)

    def p_group(self, allele: str) -> Optional[str]:
        return self._p[0].get(allele)

    def g_groups_under(self, prefix: str) -> set[Optional[str]]:
        """Distinct G groups of every allele under a lower-resolution prefix
        (None included when some member is in no group)."""
        return {self.g_group(a) for a in self.expand(prefix)}

    def p_groups_under(self, prefix: str) -> set[Optional[str]]:
        return {self.p_group(a) for a in self.expand(prefix)}

    def g_members(self, group: str) -> list[str]:
        return list(self._g[1].get(group, []))

    def p_members(self, group: str) -> list[str]:
        return list(self._p[1].get(group, []))

    def g_groups(self, locus: Optional[str] = None) -> list[str]:
        return [g for g in self._g[1] if locus is None or g.startswith(f"{locus}*")]

    def p_groups(self, locus: Optional[str] = None) -> list[str]:
        return [g for g in self._p[1] if locus is None or g.startswith(f"{locus}*")]

    def is_group_name(self, name: str) -> bool:
        return name in self._g[1] or name in self._p[1]

    # ---------------------------------------------------------------- serology
    @cached_property
    def _serology(self) -> dict[str, Serology]:
        out = {}
        for ln in self._read("wmda/rel_dna_ser.txt"):
            if not ln:
                continue
            parts = ln.split(";")
            if len(parts) < 6:
                continue
            locus, allele = parts[0], parts[1]
            name = f"{locus}{allele}"
            cols = [tuple(x for x in p.split("/") if x) for p in parts[2:6]]
            out[name] = Serology(name, *cols)
        return out

    def serology(self, allele: str) -> Optional[Serology]:
        return self._serology.get(allele)

    @cached_property
    def serology_relations(self) -> list[tuple[str, str, tuple[str, ...], tuple[str, ...]]]:
        """(locus, broad, splits, associated) from rel_ser_ser.txt."""
        out = []
        for ln in self._read("wmda/rel_ser_ser.txt"):
            if not ln:
                continue
            locus, broad, splits, assoc = (ln.split(";") + ["", ""])[:4]
            out.append((locus, broad, tuple(x for x in splits.split("/") if x), tuple(x for x in assoc.split("/") if x)))
        return out

    # ------------------------------------------------------------ hallucination
    def classify_tokens(self, text: str) -> dict[str, list[str]]:
        """Split every allele-like token in free text into valid / deleted /
        group / hallucinated, per GRADER_SPEC §3.4."""
        seen = {"valid": [], "deleted": [], "group": [], "hallucinated": []}
        for tok in set(ALLELE_TOKEN_RE.findall(text)):
            t = tok[4:] if tok.startswith("HLA-") else tok
            if self.exists(t):
                seen["valid"].append(t)
            elif self.is_group_name(t):
                seen["group"].append(t)
            elif self.is_deleted(t) or (self.ids_for_name_ever(t) and not self.exists(t)):
                seen["deleted"].append(t)
            else:
                seen["hallucinated"].append(t)
        for k in seen:
            seen[k].sort()
        return seen

    def assert_release(self, release: str) -> None:
        if release != self.release:
            raise ReleaseMismatch(f"reference is {self.release}, task pinned to {release}")
