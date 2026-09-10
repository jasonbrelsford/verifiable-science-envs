"""Family C — donor–recipient matching: an executable encoding of published rules.

Every verdict is computed from the pinned release's own files (Allelelist,
Deleted_alleles, rel_dna_ser, rel_ser_ser) — no frequencies, no licensed data.
Where accredited labs are known to diverge, we encode ONE documented
interpretation (below) and tag the divergent inputs as the `edge_case` slice
rather than pretending consensus.

v0 rule choices (stated so a lab director can audit them):
R1. Names are normalized with the family-A normalizer first: deleted names are
    chased to successors, legacy strings converted; comparison happens at the
    2-field level, keeping an expression suffix only when all full-resolution
    alleles under the name share it (so A*24:09N never collapses into A*24:09).
R2. Allele-level match at a locus = equality of those 2-field names, counted
    per chromosome: matched = size of the multiset intersection of the two
    pairs; bidirectional mismatches at the locus = 2 - matched.
R3. Antigen-level: each expressed allele maps to the first antigen of the most
    confident non-empty WMDA column (unambiguous > possible > assumed > expert)
    across the *unsuffixed* full-resolution members that WMDA maps (a hidden N variant under an expressed name must not poison the antigen); if the mapped members
    disagree, or none is mapped, the antigen is UNCERTAIN and any verdict that
    depends on it is `potential`. Antigen '0' and expression
    suffix N both mean "expresses no antigen": a null allele contributes
    nothing to the antigen set (the A*24:09N trap) and raises `null_allele`.
R4. Direction (for homozygous cases): HvG mismatches = donor 2-field names
    absent from the recipient (host attacks graft); GvH = recipient names
    absent from the donor. The bidirectional per-locus count of R2 equals
    max(HvG, GvH) at that locus.
R5. Frameworks: 6/6 = A, B at antigen level + DRB1 at allele level;
    8/8 = A, B, C, DRB1 allele level; 10/10 adds DQB1; 12/12 adds DPB1;
    'antigen' = A, B, C, DRB1, DQB1 at antigen level. DQA1/DPA1 and DPB1 TCE
    permissiveness are deliberately out of scope in v0.
R6. If any typing at a scored locus cannot be resolved to 2-field resolution
    (unresolvable name, or antigen UNCERTAIN at an antigen-level locus), that
    locus's verdict is `potential`, the `resolution_insufficient` flag is set,
    and the locus is EXCLUDED from the numeric count's denominator — a
    confident count over unresolvable typing is exactly the error we grade
    models down for.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sci_envs.reference.imgt import ImgtReference, split_allele
from sci_envs.families.nomenclature.normalize import normalize, resolve_name

FRAMEWORKS: dict[str, list[tuple[str, str]]] = {
    "6/6": [("A", "antigen"), ("B", "antigen"), ("DRB1", "allele")],
    "8/8": [("A", "allele"), ("B", "allele"), ("C", "allele"), ("DRB1", "allele")],
    "10/10": [("A", "allele"), ("B", "allele"), ("C", "allele"), ("DRB1", "allele"), ("DQB1", "allele")],
    "12/12": [("A", "allele"), ("B", "allele"), ("C", "allele"), ("DRB1", "allele"), ("DQB1", "allele"), ("DPB1", "allele")],
    "antigen": [("A", "antigen"), ("B", "antigen"), ("C", "antigen"), ("DRB1", "antigen"), ("DQB1", "antigen")],
}

NULL = "∅"          # expresses no antigen (suffix N, or WMDA antigen '0')
UNCERTAIN = "?"     # WMDA gives no unambiguous antigen, or members disagree


@dataclass
class LocusVerdict:
    locus: str
    level: str                      # 'allele' | 'antigen'
    verdict: str                    # 'match' | 'mismatch' | 'potential'
    mismatches: int                 # bidirectional, 0-2 (0 when potential)
    hvg: int = 0                    # donor names foreign to recipient
    gvh: int = 0                    # recipient names foreign to donor
    flags: list[str] = field(default_factory=list)


def two_field(ref: ImgtReference, reported: str) -> Optional[str]:
    """Family-A normalization to the comparable 2-field name (R1). None = unresolvable."""
    n = normalize(ref, reported)
    return None if n["allele_2field"] == "UNRESOLVABLE" else n["allele_2field"]


def antigen_of(ref: ImgtReference, reported: str) -> str:
    """WMDA antigen for one reported typing (R3). NULL / UNCERTAIN sentinels."""
    name, _ = resolve_name(ref, reported)
    if name is None:
        return UNCERTAIN
    locus, fields, suffix = split_allele(name)
    if suffix == "N":
        return NULL
    if ref.exists(name):
        members = [name]
    else:                                 # lower-resolution prefix, possibly with a shared suffix
        members = ref.expand(f"{locus}*{':'.join(fields)}")
        if suffix:
            members = [m for m in members if split_allele(m)[2] == suffix]
    if not members:
        return UNCERTAIN
    antigens = set()
    for m in members:
        if split_allele(m)[2]:            # suffixed members (incl. hidden N) do not speak
            continue                      # for an unsuffixed reported name
        s = ref.serology(m)
        if s is None:
            continue                      # WMDA maps only a subset of full alleles
        best = s.best if s.best else None
        if best:
            antigens.add(best[0])
    if len(antigens) != 1:                # nothing mapped, or members disagree
        return UNCERTAIN
    a = antigens.pop()
    return NULL if a == "0" else a


def _pair_tokens(ref: ImgtReference, pair: list[str], level: str) -> Optional[list[str]]:
    """The two comparable tokens for one locus of one person, or None if unresolvable."""
    out = []
    for reported in pair:
        if level == "allele":
            t = two_field(ref, reported)
            if t is None:
                return None
        else:
            t = antigen_of(ref, reported)
            if t == UNCERTAIN:
                return None
            # a null expresses nothing: drop it from the antigen multiset (R3)
            if t == NULL:
                continue
        out.append(t)
    return out


def locus_verdict(ref: ImgtReference, locus: str, level: str,
                  recipient: list[str], donor: list[str]) -> LocusVerdict:
    flags = []
    for reported in recipient + donor:
        name, fl = resolve_name(ref, reported)
        if name and split_allele(name)[2] == "N":
            flags.append("null_allele")
    r = _pair_tokens(ref, recipient, level)
    d = _pair_tokens(ref, donor, level)
    if r is None or d is None:
        return LocusVerdict(locus, level, "potential", 0, flags=sorted(set(flags + ["resolution_insufficient"])))
    # multiset intersection (R2); antigen level may have <2 tokens after null-dropping
    rr, dd = sorted(r), sorted(d)
    matched = 0
    dd_pool = list(dd)
    for t in rr:
        if t in dd_pool:
            dd_pool.remove(t)
            matched += 1
    slots = max(len(rr), len(dd), 1)
    mism = slots - matched
    hvg = len([t for t in dd if t not in rr])   # donor tokens foreign to recipient
    gvh = len([t for t in rr if t not in dd])
    if level == "antigen" and "null_allele" in flags and mism == 0:
        # DNA-visible null hiding inside an apparent antigen match — the classic trap
        flags.append("null_allele_mismatch")
    v = "match" if mism == 0 else "mismatch"
    return LocusVerdict(locus, level, v, mism, hvg=hvg, gvh=gvh, flags=sorted(set(flags)))


def score(ref: ImgtReference, framework: str,
          recipient: dict[str, list[str]], donor: dict[str, list[str]]) -> dict:
    """Full oracle answer for one pair. Loci absent from either typing are skipped
    with `resolution_insufficient` (typing too coarse to call, R6)."""
    verdicts: dict[str, LocusVerdict] = {}
    total = matched = 0
    flags: set[str] = set()
    for locus, level in FRAMEWORKS[framework]:
        if locus not in recipient or locus not in donor:
            verdicts[locus] = LocusVerdict(locus, level, "potential", 0, flags=["resolution_insufficient"])
            flags.add("resolution_insufficient")
            continue
        lv = locus_verdict(ref, locus, level, recipient[locus], donor[locus])
        verdicts[locus] = lv
        flags.update(lv.flags)
        if lv.verdict == "potential":
            continue
        total += 2
        matched += 2 - lv.mismatches
    return {
        "framework": framework,
        "count": f"{matched}/{total}" if total else "UNRESOLVABLE",
        "verdicts": {k: v.verdict for k, v in verdicts.items()},
        "hvg_mismatches": sum(v.hvg for v in verdicts.values() if v.verdict != "potential"),
        "gvh_mismatches": sum(v.gvh for v in verdicts.values() if v.verdict != "potential"),
        "flags": sorted(flags),
        "_detail": verdicts,
    }


def flat_answer(s: dict) -> dict:
    """Flatten score() into the scalar dict the family-A object grader accepts."""
    out = {"count": s["count"]}
    for locus, v in s["verdicts"].items():
        out[f"verdict_{locus}"] = v
    return out
