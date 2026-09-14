"""Amino-acid facts from the pinned release's protein alignments (alignments/<locus>_prot.txt).

Only *derived* per-allele facts leave this module (a residue at a numbered
position, a ligand group) — never sequences.  The alignment files are fetched
at runtime into the same cache as the nomenclature files and are not
redistributed (IPD-IMGT/HLA is CC-BY-ND).  Licence: PolyForm Noncommercial
1.0.0 (sci_envs/service/LICENSE).

Alignment format (IPD-IMGT/HLA): blocks headed by ` Prot  <first position>`,
then a ruler line whose `|` marks the first column; sequence lines carry the
allele name then columns in groups of ten separated by one space.  The first
sequence line is the reference.  In other lines `-` = same as reference,
`*` = not sequenced, `.` = gap, `X` = stop codon.  A column whose reference
character is `.` is an insertion column and carries no position number; the
numbering skips 0 (… -2, -1, 1, 2 …), so mature position 1 follows leader -1.
"""
from __future__ import annotations

import re
import urllib.request
from functools import cached_property
from pathlib import Path
from typing import Optional

from sci_envs.reference.imgt import ImgtReference, ImgtError, RAW_BASE

PROTEIN_LOCI = ("A", "B", "C")
UNKNOWN = "?"
GAP = "."
STOP = "X"

_BLOCK_RE = re.compile(r"^\s*Prot\s+(-?\d+)")


def _fetch(ref: ImgtReference, rel_path: str) -> Path:
    p = ref.root / rel_path
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        url = RAW_BASE.format(tag=ref.tag, path=rel_path)
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(p)
    return p


def parse_alignment(path: Path) -> tuple[str, dict[str, dict[int, str]]]:
    """-> (release version string, {allele: {position: residue}}) with every
    numbered position resolved against the reference ('?' unknown, '.' gap)."""
    version = ""
    blocks: list[tuple[int, int, list[str]]] = []   # (start number, first column offset, lines)
    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("# version:"):
            version = ln.split(":", 1)[1].strip()
        m = _BLOCK_RE.match(ln)
        if m and i + 1 < len(lines) and "|" in lines[i + 1]:
            start = int(m.group(1))
            off = lines[i + 1].index("|")
            body = []
            j = i + 2
            while j < len(lines) and lines[j].strip() and not _BLOCK_RE.match(lines[j]):
                if not lines[j].startswith("Please see"):
                    body.append(lines[j])
                j += 1
            blocks.append((start, off, body))
            i = j
            continue
        i += 1
    if not blocks:
        raise ImgtError(f"no alignment blocks in {path}")

    out: dict[str, dict[int, str]] = {}
    ref_name: Optional[str] = None
    expected_next: Optional[int] = None
    for start, off, body in blocks:
        if not body:
            continue
        names = [b[:off].strip() for b in body]
        cols = [_columns(b[off:].rstrip()) for b in body]
        if ref_name is None:
            ref_name = names[0]
        if names[0] == ref_name:
            ref_cols = cols[0]
        else:  # trailing block past the reference's end: every column is numbered, none known
            ref_cols = " " * max(len(c) for c in cols)
        # number the reference columns in this block
        numbers: list[Optional[int]] = []
        pos = start
        for c in ref_cols:
            if c == GAP:
                numbers.append(None)
                continue
            numbers.append(pos)
            pos += 1
            if pos == 0:
                pos = 1
        if expected_next is not None and start != expected_next:
            raise ImgtError(f"{path.name}: numbering drift — block starts at {start}, expected {expected_next}")
        expected_next = pos
        for name, cs in zip(names, cols):
            row = out.setdefault(name, {})
            for k, n in enumerate(numbers):
                if n is None:
                    continue
                c = cs[k] if k < len(cs) else " "
                rc = ref_cols[k]
                if c == "-":
                    res = rc if rc not in (" ", "*") else UNKNOWN
                elif c in (" ", "*"):
                    res = UNKNOWN
                else:
                    res = c
                if name == ref_name and c == " ":
                    res = UNKNOWN
                row[n] = res
    return version, out


def _columns(s: str) -> str:
    """Drop the one-space separator after every ten columns; keep blanks inside groups."""
    return "".join(s[k] for k in range(len(s)) if k % 11 != 10)


class ProteinFacts:
    """Residue lookup for the class I loci whose ligand groups labs use."""

    def __init__(self, ref: ImgtReference, loci: tuple[str, ...] = PROTEIN_LOCI):
        self.ref = ref
        self.loci = loci

    @cached_property
    def _tables(self) -> dict[str, dict[str, dict[int, str]]]:
        t = {}
        for locus in self.loci:
            version, rows = parse_alignment(_fetch(self.ref, f"alignments/{locus}_prot.txt"))
            if self.ref.release not in version:
                raise ImgtError(f"alignments/{locus}_prot.txt is {version!r}, reference is {self.ref.release}")
            t[locus] = rows
        return t

    def residue(self, allele: str, position: int) -> Optional[str]:
        """Residue of a full allele name at a numbered position; None if the allele
        is not in the alignment ('?' not sequenced, '.' gap, 'X' stop)."""
        locus = allele.split("*", 1)[0]
        rows = self._tables.get(locus)
        if rows is None or allele not in rows:
            return None
        r = rows[allele].get(position, UNKNOWN)
        return r

    def truncated_before(self, allele: str, position: int) -> bool:
        """True when a stop codon occurs at or before `position` (no mature protein there)."""
        locus = allele.split("*", 1)[0]
        row = self._tables.get(locus, {}).get(allele)
        if not row:
            return False
        return any(p <= position and v == STOP for p, v in row.items())
