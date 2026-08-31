"""Family C generators — donor–recipient matching (HLA-Bench-C).

Truth comes from rules.score(); tasks reuse the family-A Task record and JSON
contract so the whole harness (run/grade/report/adapters) works unchanged.
Deterministic from (tag, base_seed). ~200 tasks in 8 subtypes across 4 tiers.
"""
from __future__ import annotations

import hashlib
import random

from sci_envs.reference.imgt import ImgtReference, split_allele, LOCI_IN_SCOPE
from sci_envs.families.nomenclature.task import Task, RESPONSE_CONTRACT, dumps
from .rules import FRAMEWORKS, UNCERTAIN, antigen_of, flat_answer, score, two_field

FAMILY = "hla_matching"
BASE_SEED = 20260831
SUITE_REV = "r2"   # bump on any generator change: task ids key the response cache
COUNTS = {  # subtype -> (tier, n)
    "count_simple": (1, 30), "same_after_normalize": (1, 30),
    "antigen_vs_allele": (2, 30), "framework_shift": (2, 20),
    "null_trap_match": (3, 25), "direction": (3, 25), "resolution_insufficient": (3, 25),
    "near_miss_pair": (4, 20),
}
INSTR = ("You are given a transplant recipient's and a donor's HLA typings (two reported "
         "alleles per locus, any nomenclature era) and a match framework. Normalize every "
         "name to the current release first, then score the pair. Answer with an object: "
         '{"count": "<matched>/<total>", "verdict_<LOCUS>": "match"|"mismatch"|"potential" for every '
         "framework locus}. A locus whose typing cannot be resolved is 'potential' and is excluded "
         "from the count's denominator. Frameworks: 6/6 = A,B at antigen level + DRB1 at allele "
         "level; 8/8 = A,B,C,DRB1 at allele (2-field) level; 10/10 adds DQB1; 12/12 adds DPB1; "
         "'antigen' = A,B,C,DRB1,DQB1 at antigen level. Null alleles express no antigen.")
INSTR_DIR = INSTR + (' Additionally include "hvg_mismatches" (donor names foreign to the recipient) and '
                     '"gvh_mismatches" (recipient names foreign to the donor) as integers.')


class Pools:
    """Alleles with clean 2-field forms and certain antigens, per locus."""

    def __init__(self, ref: ImgtReference, rng: random.Random):
        self.ref, self.rng = ref, rng
        self.by_locus: dict[str, list[str]] = {}
        for locus in ("A", "B", "C", "DRB1", "DQB1", "DPB1"):
            # candidate 2-field bases by text truncation (cheap), verified on a sample only
            bases = sorted({f"{locus}*{split_allele(a)[1][0]}:{split_allele(a)[1][1]}"
                            for a in ref.alleles(locus)
                            if split_allele(a)[2] == "" and len(split_allele(a)[1]) >= 2})
            good = []
            for n in rng.sample(bases, min(len(bases), 220)):
                if two_field(ref, n) == n and antigen_of(ref, n) != UNCERTAIN:
                    good.append(n)
                if len(good) >= 80:
                    break
            self.by_locus[locus] = sorted(good)
        null_bases = sorted({f"{split_allele(a)[0]}*{split_allele(a)[1][0]}:{split_allele(a)[1][1]}N"
                             for locus in ("A", "B", "C", "DRB1") for a in ref.alleles(locus)
                             if split_allele(a)[2] == "N" and len(split_allele(a)[1]) >= 2})
        self.nulls = [n for n in rng.sample(null_bases, min(len(null_bases), 120))
                      if two_field(ref, n) == n]

    def pair(self, locus: str) -> list[str]:
        return self.rng.sample(self.by_locus[locus], 2)

    def typing(self, loci: list[str]) -> dict[str, list[str]]:
        return {l: self.pair(l) for l in loci}


def _legacy(name: str) -> str:
    """Colon-less legacy form — only ever existed for 2-digit fields; otherwise
    the modern name is returned unchanged (a 3-digit field has no legacy form)."""
    locus, fields, suffix = split_allele(name)
    if any(len(f) != 2 for f in fields[:2]):
        return name
    return f"{locus}*{''.join(fields[:2])}{suffix}"


def _mk(ref, subtype, seed, instructions, framework, recipient, donor, notes=None, conf=None):
    tier, _ = COUNTS[subtype]
    s = score(ref, framework, recipient, donor)
    fa = flat_answer(s)
    if subtype == "direction":
        fa["hvg_mismatches"] = s["hvg_mismatches"]
        fa["gvh_mismatches"] = s["gvh_mismatches"]
    slices = sorted(set(s["flags"]) & {"null_allele", "resolution_insufficient"})
    if conf is None:
        conf = "medium" if "potential" in s["verdicts"].values() else "high"
    return Task(
        task_id=f"{FAMILY}.{SUITE_REV}.T{tier}.{subtype}.{seed:04d}",
        tier=tier, subtype=subtype,
        reference={"db": "IPD-IMGT/HLA", "release": ref.release, "tag": ref.tag,
                   "md5": ref.manifest["md5"]["Allelelist.txt"]},
        instructions=f"Using IPD-IMGT/HLA release {ref.release}. {instructions} {RESPONSE_CONTRACT}",
        input={"framework": framework, "recipient": recipient, "donor": donor},
        answer={"canonical": fa, "accept": [fa], "expected_confidence": conf,
                "expected_flags": sorted(set(s["flags"]) & {"null_allele", "resolution_insufficient"})},
        slices=slices, scorer_notes=dict(notes or {}, oracle=s["count"]),
        family=FAMILY,
    )


def _loci_for(framework: str) -> list[str]:
    return [l for l, _ in FRAMEWORKS[framework]]


def gen_count_simple(ref, pools, rng, seed):
    fw = rng.choice(["8/8", "10/10"])
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {l: list(p) for l, p in recip.items()}
    for l in rng.sample(loci, rng.randint(0, 2)):          # plant 0-2 mismatches
        donor[l][rng.randrange(2)] = rng.choice([x for x in pools.by_locus[l] if x not in recip[l]])
    return _mk(ref, "count_simple", seed, INSTR, fw, recip, donor)


def gen_same_after_normalize(ref, pools, rng, seed):
    fw = "8/8"
    recip = pools.typing(_loci_for(fw))
    donor = {l: [_legacy(a) if rng.random() < 0.7 else a for a in p] for l, p in recip.items()}
    if rng.random() < 0.4:                                  # sometimes also plant one real mismatch
        l = rng.choice(_loci_for(fw))
        donor[l][0] = _legacy(rng.choice([x for x in pools.by_locus[l] if x not in recip[l]]))
    return _mk(ref, "same_after_normalize", seed, INSTR, fw, recip, donor,
               notes={"era": "legacy_donor"})


def gen_antigen_vs_allele(ref, pools, rng, seed):
    # find two DIFFERENT 2-field alleles sharing one antigen -> antigen-level match
    for _ in range(300):
        l = rng.choice(["A", "B", "DRB1"])
        a, b = rng.sample(pools.by_locus[l], 2)
        if antigen_of(ref, a) == antigen_of(ref, b):
            break
    else:
        a = b = pools.by_locus["A"][0]; l = "A"
    fw = "antigen"
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {k: list(v) for k, v in recip.items()}
    recip[l] = [a, recip[l][1]]
    donor[l] = [b, recip[l][1]]
    return _mk(ref, "antigen_vs_allele", seed, INSTR, fw, recip, donor,
               notes={"same_antigen_pair": [a, b]})


def gen_framework_shift(ref, pools, rng, seed):
    # same pair scored under a stricter framework: mismatch hides outside 6/6
    recip = pools.typing(["A", "B", "C", "DRB1", "DQB1"])
    donor = {l: list(p) for l, p in recip.items()}
    l = rng.choice(["C", "DQB1"])                           # invisible to 6/6
    donor[l][0] = rng.choice([x for x in pools.by_locus[l] if x not in recip[l]])
    fw = rng.choice(["10/10", "antigen"])
    return _mk(ref, "framework_shift", seed, INSTR, fw, recip, donor,
               notes={"hidden_mismatch_locus": l})


def gen_null_trap_match(ref, pools, rng, seed):
    fw = rng.choice(["antigen", "8/8"])
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {l: list(p) for l, p in recip.items()}
    nulls = [n for n in pools.nulls if n.split("*")[0] in loci]
    n = rng.choice(nulls)
    l = n.split("*")[0]
    recip[l][0] = n
    return _mk(ref, "null_trap_match", seed, INSTR, fw, recip, donor, notes={"null": n})


def gen_direction(ref, pools, rng, seed):
    fw = "8/8"
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {l: list(p) for l, p in recip.items()}
    l = rng.choice(loci)
    side = rng.choice(["recipient", "donor"])
    (recip if side == "recipient" else donor)[l][1] = (recip if side == "recipient" else donor)[l][0]
    return _mk(ref, "direction", seed, INSTR_DIR, fw, recip, donor, notes={"homozygous": side})


def gen_resolution_insufficient(ref, pools, rng, seed):
    fw = "8/8"
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {l: list(p) for l, p in recip.items()}
    l = rng.choice(loci)
    locus_num = {"A": "80", "B": "95", "C": "18", "DRB1": "17"}[l]
    donor[l][0] = f"{l}*{locus_num}:{rng.randrange(80, 99)}"   # fabricated -> unresolvable
    return _mk(ref, "resolution_insufficient", seed, INSTR, fw, recip, donor,
               notes={"planted_unresolvable": donor[l][0]}, conf="medium")


def gen_near_miss_pair(ref, pools, rng, seed):
    fw = "8/8"
    loci = _loci_for(fw)
    recip = pools.typing(loci)
    donor = {l: list(p) for l, p in recip.items()}
    l = rng.choice(loci)
    base = recip[l][0]
    neighbors = [x for x in pools.by_locus[l]
                 if x != base and x.split(":")[0] == base.split(":")[0]]
    donor[l][0] = rng.choice(neighbors) if neighbors else rng.choice(
        [x for x in pools.by_locus[l] if x not in recip[l]])
    return _mk(ref, "near_miss_pair", seed, INSTR, fw, recip, donor,
               notes={"near_miss": [base, donor[l][0]]})


GENERATORS = {
    "count_simple": gen_count_simple, "same_after_normalize": gen_same_after_normalize,
    "antigen_vs_allele": gen_antigen_vs_allele, "framework_shift": gen_framework_shift,
    "null_trap_match": gen_null_trap_match, "direction": gen_direction,
    "resolution_insufficient": gen_resolution_insufficient, "near_miss_pair": gen_near_miss_pair,
}


def generate_suite(ref: ImgtReference, base_seed: int = BASE_SEED, dev_fraction: float = 0.2):
    rng = random.Random(base_seed)
    pools = Pools(ref, random.Random(base_seed ^ 0xC0FFEE))
    tasks, seen = [], set()
    for subtype, gen in GENERATORS.items():
        _, want = COUNTS[subtype]
        made, seed = 0, 0
        while made < want and seed < want * 20:
            t = gen(ref, pools, random.Random((base_seed, subtype, seed).__hash__() & 0x7FFFFFFF), seed)
            seed += 1
            if t.key() in seen:
                continue
            seen.add(t.key())
            t.scorer_notes["split"] = "dev" if int(hashlib.sha256(
                t.task_id.encode()).hexdigest(), 16) % 100 < dev_fraction * 100 else "test"
            tasks.append(t)
            made += 1
    manifest = {"benchmark": f"HLA-Bench-C-v0.1@IMGT-{ref.release}", "family": FAMILY,
                "tag": ref.tag, "base_seed": base_seed, "total": len(tasks),
                "split": {"dev": sum(1 for t in tasks if t.scorer_notes["split"] == "dev"),
                          "test": sum(1 for t in tasks if t.scorer_notes["split"] == "test")},
                "rules_version": "C-v0.1.1 (rules.py R1-R6)", "suite_rev": SUITE_REV}
    return tasks, manifest


def write_suite(tasks, manifest, out_dir):
    from pathlib import Path
    out = Path(out_dir)
    (out / "dev").mkdir(parents=True, exist_ok=True)
    (out / "full").mkdir(parents=True, exist_ok=True)
    for t in tasks:
        (out / "full" / f"{t.task_id}.full.json").write_text(dumps(t.full()))
        if t.scorer_notes["split"] == "dev":
            (out / "dev" / f"{t.task_id}.agent.json").write_text(dumps(t.agent()))
    (out / "manifest.json").write_text(dumps(manifest))
    return out
