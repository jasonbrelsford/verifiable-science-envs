"""Lab Toolkit — typing QC, donor/recipient compatibility, GL String validation.

Licence: PolyForm Noncommercial 1.0.0 (sci_envs/service/LICENSE) — unlike the
rest of this repository (Apache-2.0). Commercial use requires a licence:
Brelsford Software LLC (hello@hlaverify.com).

Deterministic, no LLM anywhere: every answer is computed from a pinned
IPD-IMGT/HLA release (fetched at runtime, never redistributed; CC-BY-ND
attribution in every response). Never outputs sequences.

Contract: the Lab Toolkit spec, kept privately. This module is the reference
implementation ("golden oracle") that the JavaScript edge Worker is later
tested against byte-for-byte — key orders, sort orders, sentinel strings and
detail texts here are load-bearing, not stylistic.

`donor_compat` output is decision support only; not a medical device.
"""
from __future__ import annotations

import re
from typing import Optional

from sci_envs.reference.imgt import ImgtReference, ImgtError, split_allele
from sci_envs.families.nomenclature.normalize import normalize, resolve_name, _members
from sci_envs.families.matching.rules import antigen_of
from sci_envs.service.protein import ProteinFacts

ATTRIBUTION = ("Computed from IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Res 2025), "
               "fetched at runtime from the ANHIG/IMGTHLA mirror under CC-BY-ND.")

MAX_LOCI = 24
MAX_PER_LOCUS = 4
MAX_NAME = 64
MAX_GL_CHARS = 100_000
MAX_GL_ALLELES = 5_000

PETERSDORF_RULE = (
    "Petersdorf 2020 (Blood): for a single HLA-B mismatch, leader-matched when the "
    "mismatched recipient and donor HLA-B alleles share the -21 M/T leader residue. "
    "Decision support only; not a medical device."
)
KIR_RULE = (
    "Ligand-ligand model: a KIR ligand class (C1, C2, Bw4) present in one party and "
    "absent in the other. Requires complete A, B and C typing. Decision support only; "
    "not a medical device."
)

_LOCUS_PREFIX_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*")

# One ProteinFacts per ImgtReference instance (residue lookups fetch/parse the
# alignment files once and are relatively expensive; never rebuild per request).
_PF_CACHE: dict[int, ProteinFacts] = {}


def get_protein_facts(ref: ImgtReference) -> ProteinFacts:
    pf = _PF_CACHE.get(id(ref))
    if pf is None:
        pf = ProteinFacts(ref)
        _PF_CACHE[id(ref)] = pf
    return pf


def _canonical_locus(key: str) -> str:
    k = key.strip()
    if k.startswith("HLA-"):
        k = k[4:]
    return "C" if k == "Cw" else k


def _regex_locus(s: str) -> Optional[str]:
    m = _LOCUS_PREFIX_RE.match(s)
    if not m:
        return None
    loc = m.group(1)
    return "C" if loc == "Cw" else loc


def _aa(x: Optional[str]) -> str:
    return x if (x is not None and len(x) == 1 and x.isalpha() and x != "X") else "unknown"


# --------------------------------------------------------------------- §2 ligands

def ligands(ref: ImgtReference, pf: ProteinFacts, name: str) -> Optional[dict]:
    """Ligand facts for one reported name (§2). None when the name does not
    split as a class I (A/B/C) allele name, or has no members."""
    try:
        locus, fields, suffix = split_allele(name)
    except ImgtError:
        return None
    if locus not in ("A", "B", "C"):
        return None
    members = _members(ref, name)
    if not members:
        return None

    expressed = [m for m in members if split_allele(m)[2] != "N"]
    if not expressed:
        return {
            "expressed": False,
            "leader_21": "not_expressed",
            "residue_80": "not_expressed",
            "bw": "not_expressed" if locus in ("A", "B") else None,
            "c_group": None,
            "kir_ligand": "none",
        }

    per_member = []
    for m in expressed:
        leader_21 = _aa(pf.residue(m, -21))
        residue_80 = _aa(pf.residue(m, 80))

        if locus == "C":
            bw = None
        else:
            p82 = _aa(pf.residue(m, 82))
            p83 = _aa(pf.residue(m, 83))
            if p82 == "unknown" or p83 == "unknown":
                bw = "unknown"
            elif (p82, p83) == ("L", "R"):
                bw = "Bw4"
            elif (p82, p83) == ("R", "G"):
                bw = "Bw6" if locus == "B" else "non-Bw4"
            else:
                bw = "unclassified"

        if locus == "C":
            if residue_80 == "N":
                c_group = "C1"
            elif residue_80 == "K":
                c_group = "C2"
            elif residue_80 == "unknown":
                c_group = "unknown"
            else:
                c_group = "unclassified"
        elif locus == "B":
            c_group = "C1" if (_aa(pf.residue(m, 76)) == "V" and residue_80 == "N") else None
        else:
            c_group = None

        if locus == "C":
            if c_group in ("C1", "C2"):
                kir_ligand = c_group
            elif c_group == "unknown":
                kir_ligand = "unknown"
            else:
                kir_ligand = "none"
        else:
            if bw == "Bw4":
                if residue_80 == "I":
                    kir_ligand = "Bw4-80I"
                elif residue_80 == "T":
                    kir_ligand = "Bw4-80T"
                else:
                    kir_ligand = "Bw4"
            elif c_group == "C1":
                kir_ligand = "C1"
            elif bw == "unknown":
                kir_ligand = "unknown"
            else:
                kir_ligand = "none"

        per_member.append({
            "leader_21": leader_21, "residue_80": residue_80, "bw": bw,
            "c_group": c_group, "kir_ligand": kir_ligand,
        })

    keys = ("leader_21", "residue_80", "bw", "c_group", "kir_ligand")
    out: dict = {"expressed": True}
    ambiguities: dict[str, list[str]] = {}
    for key in keys:
        values = [pm[key] for pm in per_member]
        known = [v for v in values if v != "unknown"]
        if not known:
            agg: object = "unknown"
        else:
            distinct = set(known)
            if len(distinct) == 1:
                agg = next(iter(distinct))
            else:
                agg = "ambiguous"
                ambiguities[key] = sorted("null" if v is None else v for v in distinct)
        out[key] = agg
    if ambiguities:
        out["ambiguities"] = {k: ambiguities[k] for k in keys if k in ambiguities}
    return out


# --------------------------------------------------------------- typing validation

def validate_typing(obj, side: str) -> Optional[str]:
    """Mirrors edge/src/handlers.js validateTyping() exactly: same messages, same limits."""
    if not isinstance(obj, dict):
        return f"{side} must be an object mapping locus -> [reported alleles]"
    loci = list(obj.keys())
    if len(loci) > MAX_LOCI:
        return f"{side}: at most {MAX_LOCI} loci"
    for l in loci:
        v = obj[l]
        if not isinstance(v, list) or len(v) > MAX_PER_LOCUS or not all(
            isinstance(x, str) and len(x) <= MAX_NAME for x in v
        ):
            return f"{side}.{l} must be a list of up to {MAX_PER_LOCUS} reported allele strings"
    return None


def _issue(severity: str, locus, code: str, detail: str) -> dict:
    return {"severity": severity, "locus": locus, "code": code, "detail": detail}


def _check(ref: ImgtReference, pf: ProteinFacts, typing: dict):
    """-> (response, row_lookup: {input key: [row,...]}, canonical_lookup: {input key: canonical locus})"""
    release = ref.release
    loci_out: dict[str, list[dict]] = {}
    row_lookup: dict[str, list[dict]] = {}
    canonical_lookup: dict[str, str] = {}
    issues: list[dict] = []

    for key, strings in typing.items():
        canon = _canonical_locus(key)
        canonical_lookup[key] = canon
        rows = []
        for s in strings:
            name, flags = resolve_name(ref, s)
            n = normalize(ref, s)
            if name is None:
                status = "unresolvable"
            elif "deprecated_name" in flags:
                status = "renamed"
            else:
                status = "ok"
            current_name = name if name is not None else "UNRESOLVABLE"
            row_flags = n["flags"].split(";") if n["flags"] else []
            antigen_raw = antigen_of(ref, s)
            antigen = "null" if antigen_raw == "∅" else ("uncertain" if antigen_raw == "?" else antigen_raw)
            row = {
                "reported": s, "status": status, "current_name": current_name,
                "allele_2field": n["allele_2field"], "g_group": n["g_group"],
                "flags": row_flags, "antigen": antigen,
            }
            ligs = ligands(ref, pf, name) if name is not None else None
            if ligs is not None:
                row["ligands"] = ligs
            rows.append(row)

            string_locus = split_allele(name)[0] if name is not None else _regex_locus(s.strip())
            if status == "unresolvable":
                issues.append(_issue("error", key, "unresolvable", f"'{s}' is not a name in release {release}"))
            if status == "renamed":
                issues.append(_issue("warning", key, "deprecated_name",
                                      f"'{s}' is an outdated name; current name is {current_name}"))
            if string_locus is not None and string_locus != canon:
                issues.append(_issue("error", key, "locus_mismatch", f"{s} is a {string_locus} allele listed under {key}"))
            if "null_allele" in row_flags:
                issues.append(_issue("warning", key, "null_allele", f"{current_name} is a null allele (not expressed)"))

        loci_out[key] = rows
        row_lookup[key] = rows

        if len(rows) > 2:
            issues.append(_issue("warning", key, "too_many_alleles",
                                  f"{len(rows)} alleles listed; a genotype has at most 2 per locus"))
        if len(rows) == 1:
            issues.append(_issue("info", key, "single_allele", "one allele listed: homozygous or incomplete typing"))
        if len(rows) == 2 and rows[0]["allele_2field"] == rows[1]["allele_2field"] and rows[0]["allele_2field"] != "UNRESOLVABLE":
            issues.append(_issue("info", key, "homozygous", f"both alleles are {rows[0]['allele_2field']}"))

    profile = _profile(typing, row_lookup, canonical_lookup)
    drb345 = _drb345(typing, row_lookup, canonical_lookup, issues)

    counts = {"error": 0, "warning": 0, "info": 0}
    for iss in issues:
        counts[iss["severity"]] += 1
    valid = counts["error"] == 0

    response = {
        "release": release, "valid": valid, "loci": loci_out, "issues": issues, "counts": counts,
        "profile": profile, "drb345": drb345, "attribution": ATTRIBUTION,
    }
    return response, row_lookup, canonical_lookup


def check_typing(ref: ImgtReference, pf: ProteinFacts, typing: dict) -> dict:
    return _check(ref, pf, typing)[0]


def _leader_slot(row: dict) -> str:
    ligs = row.get("ligands")
    if not ligs:
        return "?"
    v = ligs.get("leader_21")
    return v if v in ("M", "T") else "?"


def _c_slot(row: dict) -> str:
    ligs = row.get("ligands")
    if not ligs:
        return "?"
    kl = ligs.get("kir_ligand")
    if kl in ("C1", "C2"):
        return kl
    if ligs.get("expressed") is False:
        return "none"
    return "?"


def _rows_for_canon(typing: dict, row_lookup: dict, canonical_lookup: dict, canon: str) -> list[dict]:
    rows = []
    for key in typing:
        if canonical_lookup[key] == canon:
            rows.extend(row_lookup[key])
    return rows


def _profile(typing: dict, row_lookup: dict, canonical_lookup: dict) -> dict:
    has = {c: any(canonical_lookup[k] == c for k in typing) for c in ("A", "B", "C")}
    rows_by_canon = {c: _rows_for_canon(typing, row_lookup, canonical_lookup, c) for c in ("A", "B", "C")}

    if not has["B"]:
        b_leader_genotype = None
    else:
        slots = [_leader_slot(r) for r in rows_by_canon["B"][:2]]
        while len(slots) < 2:
            slots.append("?")
        slots.sort(key=lambda x: {"M": 0, "T": 1, "?": 2}[x])
        b_leader_genotype = "/".join(slots)

    if not has["C"]:
        c_kir_ligand_genotype = None
    else:
        slots = [_c_slot(r) for r in rows_by_canon["C"][:2]]
        while len(slots) < 2:
            slots.append("?")
        slots.sort(key=lambda x: {"C1": 0, "C2": 1, "none": 2, "?": 3}[x])
        c_kir_ligand_genotype = "/".join(slots)

    kir_set = {"C1", "C2", "Bw4", "Bw4-80I", "Bw4-80T"}
    present = set()
    for c in ("A", "B", "C"):
        for r in rows_by_canon[c]:
            ligs = r.get("ligands")
            if ligs and ligs.get("kir_ligand") in kir_set:
                present.add(ligs["kir_ligand"])
    kir_ligands_present = sorted(present)

    complete = has["A"] and has["B"] and has["C"]
    if complete:
        for c in ("A", "B", "C"):
            rs = rows_by_canon[c]
            if len(rs) != 2:
                complete = False
                break
            for r in rs:
                ligs = r.get("ligands")
                if not ligs or ligs.get("kir_ligand") in ("unknown", "ambiguous"):
                    complete = False
                    break
            if not complete:
                break
    kir_ligand_status = "complete" if complete else "incomplete"

    return {
        "b_leader_genotype": b_leader_genotype,
        "c_kir_ligand_genotype": c_kir_ligand_genotype,
        "kir_ligands_present": kir_ligands_present,
        "kir_ligand_status": kir_ligand_status,
    }


_DRB1_FAMILY = {
    "15": "DRB5", "16": "DRB5",
    "03": "DRB3", "11": "DRB3", "12": "DRB3", "13": "DRB3", "14": "DRB3",
    "04": "DRB4", "07": "DRB4", "09": "DRB4",
    "01": "none", "08": "none", "10": "none",
}


def _drb1_family(row: dict) -> str:
    name = row["current_name"]
    if name == "UNRESOLVABLE":
        return "unknown"
    try:
        first_field = split_allele(name)[1][0]
    except ImgtError:
        return "unknown"
    return _DRB1_FAMILY.get(first_field, "unknown")


def _drb345(typing: dict, row_lookup: dict, canonical_lookup: dict, issues: list[dict]) -> Optional[dict]:
    if not any(canonical_lookup[k] == "DRB1" for k in typing):
        return None
    drb1_rows = _rows_for_canon(typing, row_lookup, canonical_lookup, "DRB1")
    families = [_drb1_family(r) for r in drb1_rows]
    expected = sorted({f for f in families if f in ("DRB3", "DRB4", "DRB5")})
    determinate = len(drb1_rows) == 2 and all(f != "unknown" for f in families)

    reported_set = set()
    for L in ("DRB3", "DRB4", "DRB5"):
        for r in _rows_for_canon(typing, row_lookup, canonical_lookup, L):
            if r["status"] != "unresolvable":
                reported_set.add(L)
                break
    reported = sorted(reported_set)

    for L in sorted(set(expected) | reported_set):
        if determinate and L in reported_set and L not in expected:
            issues.append(_issue("warning", L, "drb345_unexpected",
                                  f"{L} reported but neither DRB1 allele is normally carried with {L}"))
        if L in expected and L not in reported_set:
            names = ", ".join(r["current_name"] for r, f in zip(drb1_rows, families) if f == L)
            issues.append(_issue("info", L, "drb345_not_reported",
                                  f"{L} is normally carried with {names} but was not reported"))

    return {"expected": expected, "reported": reported, "determinate": determinate}


# ------------------------------------------------------------------------ §4 compat

def _multiset_match(rec_rows: list[dict], don_rows: list[dict]):
    don_vals = [r["allele_2field"] for r in don_rows]
    don_pool = list(don_vals)
    don_unmatched = list(don_rows)
    rec_unmatched = []
    matched = 0
    for r in rec_rows:
        v = r["allele_2field"]
        if v in don_pool:
            idx = don_pool.index(v)
            don_pool.pop(idx)
            don_unmatched.pop(idx)
            matched += 1
        else:
            rec_unmatched.append(r)
    return matched, rec_unmatched, don_unmatched


def _b_leader(rec_resp: dict, don_resp: dict, rec_rows_b: list[dict], don_rows_b: list[dict]) -> dict:
    b_mismatches = None
    leader_match = None
    if (1 <= len(rec_rows_b) <= 2 and 1 <= len(don_rows_b) <= 2
            and all(r["allele_2field"] != "UNRESOLVABLE" for r in rec_rows_b)
            and all(r["allele_2field"] != "UNRESOLVABLE" for r in don_rows_b)):
        matched, rec_unmatched, don_unmatched = _multiset_match(rec_rows_b, don_rows_b)
        slots = max(len(rec_rows_b), len(don_rows_b))
        b_mismatches = slots - matched
        if (b_mismatches == 1 and len(rec_rows_b) == 2 and len(don_rows_b) == 2
                and len(rec_unmatched) == 1 and len(don_unmatched) == 1):
            r_leader = (rec_unmatched[0].get("ligands") or {}).get("leader_21")
            d_leader = (don_unmatched[0].get("ligands") or {}).get("leader_21")
            if r_leader in ("M", "T") and d_leader in ("M", "T"):
                leader_match = r_leader == d_leader
    return {
        "recipient": rec_resp["profile"]["b_leader_genotype"],
        "donor": don_resp["profile"]["b_leader_genotype"],
        "b_mismatches": b_mismatches,
        "leader_match": leader_match,
        "rule": PETERSDORF_RULE,
    }


def _kir_class(v: str) -> str:
    return "Bw4" if v.startswith("Bw4") else v


def _kir_ligands(rec_resp: dict, don_resp: dict) -> dict:
    rec_classes = sorted({_kir_class(v) for v in rec_resp["profile"]["kir_ligands_present"]})
    don_classes = sorted({_kir_class(v) for v in don_resp["profile"]["kir_ligands_present"]})
    missing_in_recipient = sorted(set(don_classes) - set(rec_classes))
    missing_in_donor = sorted(set(rec_classes) - set(don_classes))
    status = "complete" if (rec_resp["profile"]["kir_ligand_status"] == "complete"
                             and don_resp["profile"]["kir_ligand_status"] == "complete") else "incomplete"
    return {
        "recipient": rec_classes, "donor": don_classes,
        "missing_in_recipient": missing_in_recipient, "missing_in_donor": missing_in_donor,
        "status": status, "rule": KIR_RULE,
    }


def compat(ref: ImgtReference, pf: ProteinFacts, recipient: dict, donor: dict) -> dict:
    rec_resp, rec_rows, rec_canon = _check(ref, pf, recipient)
    don_resp, don_rows, don_canon = _check(ref, pf, donor)

    rec_rows_b = _rows_for_canon(recipient, rec_rows, rec_canon, "B")
    don_rows_b = _rows_for_canon(donor, don_rows, don_canon, "B")

    return {
        "release": ref.release,
        "b_leader": _b_leader(rec_resp, don_resp, rec_rows_b, don_rows_b),
        "kir_ligands": _kir_ligands(rec_resp, don_resp),
        "recipient_valid": rec_resp["valid"],
        "donor_valid": don_resp["valid"],
        "issues": {"recipient": rec_resp["issues"], "donor": don_resp["issues"]},
        "attribution": ATTRIBUTION,
    }


# --------------------------------------------------------------------- §5 gl_string

def count_gl_tokens(s: str) -> int:
    n = 0
    for block in s.split("^"):
        for alt in block.split("|"):
            for geno in alt.split("+"):
                for hap in geno.split("~"):
                    n += len(hap.split("/"))
    return n


def _process_token(ref: ImgtReference, release: str, raw_tok: str, issues: list[dict],
                    alleles_by_text: dict, order_list: list) -> dict:
    t = raw_tok.strip()
    base = t[4:] if t.startswith("HLA-") else t

    if any(c.isspace() for c in t):
        status = "unresolvable"
        current_name = None
        locus = _regex_locus(base)
        issues.append({"severity": "error", "code": "whitespace_in_name", "detail": f"'{t}' contains whitespace"})
    elif ref.is_group_name(base):
        status = "group"
        current_name = base
        locus = base.split("*", 1)[0]
    else:
        name, flags = resolve_name(ref, base)
        if name is None:
            status = "unresolvable"
            current_name = None
            locus = _regex_locus(base)
        elif "deprecated_name" in flags:
            status = "renamed"
            current_name = name
            locus = split_allele(name)[0]
        else:
            status = "valid"
            current_name = name
            locus = split_allele(name)[0]

    if status == "unresolvable":
        issues.append({"severity": "error", "code": "unresolvable_allele", "detail": f"'{t}' is not a name in release {release}"})
    elif status == "renamed":
        issues.append({"severity": "warning", "code": "renamed_allele", "detail": f"'{t}' is outdated; current name is {current_name}"})

    if status == "renamed":
        norm = ("HLA-" if t.startswith("HLA-") else "") + current_name
    else:
        norm = t

    entry = {"token": t, "status": status, "current_name": current_name, "locus": locus}
    if t not in alleles_by_text:
        alleles_by_text[t] = entry
        order_list.append(t)
    return {"t": t, "locus": locus, "norm": norm}


def _parse_list(ref, release, raw_text, issues, alleles_by_text, order_list):
    pieces = raw_text.split("/")
    norm_pieces = []
    loci = set()
    for piece in pieces:
        t = piece.strip()
        if t == "":
            issues.append({"severity": "error", "code": "empty_element", "detail": f"empty element in '{raw_text}'"})
            norm_pieces.append("")
            continue
        tok = _process_token(ref, release, piece, issues, alleles_by_text, order_list)
        norm_pieces.append(tok["norm"])
        if tok["locus"] is not None:
            loci.add(tok["locus"])
    norm_text = "/".join(norm_pieces)
    if len(loci) > 1:
        issues.append({"severity": "error", "code": "mixed_locus_allele_list",
                        "detail": f"'{raw_text}' mixes loci {', '.join(sorted(loci))}"})
    return {"norm": norm_text, "loci": loci}


def _parse_haplotype(ref, release, raw_text, issues, alleles_by_text, order_list):
    pieces = raw_text.split("~")
    lists = [_parse_list(ref, release, p, issues, alleles_by_text, order_list) for p in pieces]
    norm_text = "~".join(l["norm"] for l in lists)
    loci = set()
    counts: dict[str, int] = {}
    for l in lists:
        loci |= l["loci"]
        for lo in l["loci"]:
            counts[lo] = counts.get(lo, 0) + 1
    repeated = sorted(lo for lo, c in counts.items() if c > 1)
    if repeated:
        issues.append({"severity": "error", "code": "haplotype_repeats_locus",
                        "detail": f"'{raw_text}' repeats locus {repeated[0]}"})
    return {"norm": norm_text, "loci": loci}


def _parse_genotype(ref, release, raw_text, issues, alleles_by_text, order_list):
    pieces = raw_text.split("+")
    haps = [_parse_haplotype(ref, release, p, issues, alleles_by_text, order_list) for p in pieces]
    norm_text = "+".join(h["norm"] for h in haps)
    loci = set()
    for h in haps:
        loci |= h["loci"]
    if len(haps) > 2:
        issues.append({"severity": "warning", "code": "more_than_two_haplotypes",
                        "detail": f"'{raw_text}' has {len(haps)} haplotypes"})
    hap_loci_sets = [h["loci"] for h in haps]
    if len(hap_loci_sets) > 1 and any(s != hap_loci_sets[0] for s in hap_loci_sets[1:]):
        issues.append({"severity": "error", "code": "genotype_loci_differ", "detail": f"'{raw_text}' pairs different loci"})
    return {"norm": norm_text, "loci": loci}


def _parse_block(ref, release, raw_text, issues, alleles_by_text, order_list):
    pieces = raw_text.split("|")
    genos = [_parse_genotype(ref, release, p, issues, alleles_by_text, order_list) for p in pieces]
    norm_text = "|".join(g["norm"] for g in genos)
    loci = set()
    for g in genos:
        loci |= g["loci"]
    geno_loci_sets = [g["loci"] for g in genos]
    if len(geno_loci_sets) > 1 and any(s != geno_loci_sets[0] for s in geno_loci_sets[1:]):
        issues.append({"severity": "warning", "code": "genotype_list_loci_differ",
                        "detail": f"'{raw_text}' lists genotypes over different loci"})
    return {"norm": norm_text, "loci": loci}


def gl_string(ref: ImgtReference, gl) -> dict:
    """Validate and normalize a GL String (§5). Raises ValueError(detail) for the
    three 422 conditions (non-string/empty, too long, too many alleles)."""
    if not isinstance(gl, str) or gl.strip() == "":
        raise ValueError("gl must be a non-empty string")
    if len(gl) > MAX_GL_CHARS:
        raise ValueError(f"gl must be at most {MAX_GL_CHARS} characters")
    s = gl.strip()
    if count_gl_tokens(s) > MAX_GL_ALLELES:
        raise ValueError(f"gl must contain at most {MAX_GL_ALLELES} alleles")

    release = ref.release
    issues: list[dict] = []
    alleles_by_text: dict[str, dict] = {}
    order_list: list[str] = []

    blocks_raw = s.split("^")
    blocks = [_parse_block(ref, release, p, issues, alleles_by_text, order_list) for p in blocks_raw]
    norm_text = "^".join(b["norm"] for b in blocks)

    block_counts: dict[str, int] = {}
    for b in blocks:
        for lo in b["loci"]:
            block_counts[lo] = block_counts.get(lo, 0) + 1
    for lo in sorted(lo for lo, c in block_counts.items() if c > 1):
        issues.append({"severity": "warning", "code": "locus_repeated_across_blocks",
                        "detail": f"locus {lo} appears in more than one ^ block"})

    counts = {"error": 0, "warning": 0}
    for iss in issues:
        counts[iss["severity"]] += 1
    valid = counts["error"] == 0

    loci_out = sorted({e["locus"] for e in alleles_by_text.values() if e["locus"] is not None})
    alleles_out = [alleles_by_text[t] for t in order_list]

    return {
        "release": release, "valid": valid, "normalized_gl": norm_text, "changed": norm_text != s,
        "loci": loci_out, "alleles": alleles_out, "issues": issues, "counts": counts,
        "attribution": ATTRIBUTION,
    }
