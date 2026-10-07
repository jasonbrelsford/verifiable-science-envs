"""Family B, layer 2 — the first graded subtypes on top of the layer-1 generator
(docs/TASK_SPEC_FAMILY_B.md §3, §4, §7).

Three subtypes need nothing but Mendelian truth — no LD model, no frequency table —
so they are buildable from ``mendelian.py`` as merged:

  * T1 ``phase_trivial``     — two loci, exactly one heterozygous; the phase is forced.
  * T1 ``consistency_check`` — a child's genotype with a planted impossibility (an allele
                               neither parent carries, or both alleles of one locus taken
                               from the same parent while the other parent carries
                               neither); the only right answer is ``UNRESOLVABLE`` with
                               the ``inconsistent_genotype`` flag.
  * T4 ``family_phase``      — the child's genotype plus both parents' *unphased*
                               genotypes; the child's phase is decidable by Mendel alone.

Tasks reuse family A's ``Task`` record and JSON envelope.  Everything is deterministic
from ``(tag, base_seed)``; the same seed writes byte-identical task files.  The agent
never sees which subtype a family task belongs to: ``consistency_check`` and
``family_phase`` share one instruction text, so the inconsistency has to be found.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import random
from typing import Optional

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.task import Task, dumps
from sci_envs.families.matching.generate import write_suite       # family-agnostic file writer
from .mendelian import (
    FAMILY, BASE_SEED, GENERATOR_REV, DEFAULT_LOCI, generate_dataset, normalize_loci,
)

__all__ = ["SUITE_REV", "COUNTS", "RESPONSE_CONTRACT", "generate_suite", "write_suite",
           "mendelian_phasings", "order_normalise", "GENERATORS"]

SUITE_REV = "B2-r1"          # bump on any generator change: task ids key the response cache
COUNTS = {                   # subtype -> (tier, n)
    "phase_trivial": (1, 30),
    "consistency_check": (1, 30),
    "family_phase": (4, 30),
}
DATASET_FAMILIES = 60        # layer-1 families drawn per suite (enough candidates for every subtype)
DATASET_CHILDREN = 2

RESPONSE_CONTRACT = (
    'Respond with ONLY a JSON object: {"answer": {"haplotypes": [[<one allele per locus, in the '
    'order given by "loci">], [<the other haplotype>]]} or "UNRESOLVABLE", '
    '"confidence": "high"|"medium"|"low", "flags": [<strings>], "reasoning": "<brief>"}. '
    'The order of the two haplotypes does not matter. Recognized flags: phase_ambiguous, '
    'rare_haplotype, inconsistent_genotype, low_resolution_input. '
    'Answer "UNRESOLVABLE" only when no phase can be assigned; if the genotype is impossible '
    'under Mendelian inheritance from the stated relatives, answer "UNRESOLVABLE" and raise '
    'inconsistent_genotype. Use the allele names exactly as given (current IPD-IMGT/HLA '
    'colon-delimited nomenclature).'
)
INSTR_PHASE = (
    "You are given one individual's unphased HLA genotype from a synthetic population: two "
    "alleles per locus at the listed loci, in no particular order within a locus. Return the "
    "two haplotypes (one allele per locus, in the order of \"loci\") that together reproduce "
    "the genotype."
)
INSTR_FAMILY = INSTR_PHASE + (
    " The unphased genotypes of the individual's father and mother are given under "
    "\"relatives\". Inheritance is Mendelian with whole-haplotype transmission (no "
    "recombination within the HLA block): one haplotype came whole from the father and the "
    "other whole from the mother. Use the relatives to decide which alleles travel together. "
    "If the individual's genotype could not have arisen from these parents, answer "
    "\"UNRESOLVABLE\" with the inconsistent_genotype flag."
)

Genotype = dict[str, list[str]]
Hap = tuple[str, ...]


# ------------------------------------------------------------------- the Mendel oracle
def order_normalise(h1: Hap, h2: Hap) -> list[list[str]]:
    """The pair as the grader compares it: sorted, so neither position carries phase."""
    a, b = sorted((tuple(h1), tuple(h2)))
    return [list(a), list(b)]


def mendelian_phasings(child: Genotype, father: Genotype, mother: Genotype,
                       loci: list[str]) -> set[tuple[Hap, Hap]]:
    """Every order-normalised haplotype pair for ``child`` that Mendel allows given the
    parents' *unphased* genotypes: at each locus one allele must come from the father's
    pair and the other from the mother's.  Whole-haplotype transmission adds no further
    constraint when the parents are unphased, so per-locus assignment is the whole rule.

    Empty set  == the genotype is inconsistent with these parents (``consistency_check``).
    One member == the phase is decidable by Mendel alone (``family_phase``).
    """
    per_locus: list[set[tuple[str, str]]] = []
    for l in loci:
        c = sorted(child[l])
        options = {(p, m) for p in father[l] for m in mother[l] if sorted([p, m]) == c}
        if not options:
            return set()
        per_locus.append(options)
    out: set[tuple[Hap, Hap]] = set()
    for combo in itertools.product(*per_locus):
        paternal = tuple(p for p, _ in combo)
        maternal = tuple(m for _, m in combo)
        a, b = sorted((paternal, maternal))
        out.add((a, b))
    return out


def _is_het(genotype: Genotype, locus: str) -> bool:
    return genotype[locus][0] != genotype[locus][1]


# ------------------------------------------------------------------------ task factory
def _mk(ref: ImgtReference, subtype: str, seed: int, instructions: str, loci: list[str],
        genotype: Genotype, population: str, canonical, expected_flags: list[str],
        relatives: Optional[dict[str, Genotype]] = None, notes: Optional[dict] = None,
        slices: Optional[list[str]] = None) -> Task:
    tier, _ = COUNTS[subtype]
    inp = {"loci": list(loci), "genotype": {l: list(genotype[l]) for l in loci}, "population": population}
    if relatives is not None:
        inp["relatives"] = {who: {l: list(g[l]) for l in loci} for who, g in relatives.items()}
    return Task(
        task_id=f"{FAMILY}.{SUITE_REV}.T{tier}.{subtype}.{seed:04d}",
        tier=tier, subtype=subtype,
        reference={"db": "IPD-IMGT/HLA", "release": ref.release, "tag": ref.tag,
                   "md5": ref.manifest["md5"]["Allelelist.txt"]},
        instructions=f"Using IPD-IMGT/HLA release {ref.release}. {instructions} {RESPONSE_CONTRACT}",
        input=inp,
        answer={"canonical": canonical, "accept": [canonical], "expected_confidence": "high",
                "expected_flags": sorted(expected_flags)},
        slices=list(slices or []),
        scorer_notes=dict(notes or {}, key=json.dumps(inp, sort_keys=True), truth="construction"),
        family=FAMILY,
    )


class _Data:
    """The layer-1 dataset indexed for the generators."""

    def __init__(self, data: dict):
        self.data = data
        self.loci: list[str] = list(data["pool"]["loci"])
        self.population: str = data["pool"]["population"]
        self.alleles_by_locus: dict[str, list[str]] = data["pool"]["alleles_by_locus"]
        self.individuals: list[tuple[str, dict]] = [
            (fam["family_id"], m) for fam in data["families"] for m in fam["members"]]
        self.children: list[tuple[str, dict, dict, dict]] = []
        for fam in data["families"]:
            ix = {m["id"]: m for m in fam["members"]}
            for m in fam["members"]:
                if m["father"] is not None:
                    self.children.append((fam["family_id"], m, ix[m["father"]], ix[m["mother"]]))


# ---------------------------------------------------------------------- the subtypes
def gen_phase_trivial(ref: ImgtReference, d: _Data, rng: random.Random, seed: int) -> Optional[Task]:
    """Two loci, exactly one heterozygous: the homozygous allele sits on both haplotypes,
    so the pair is forced.  Tests representation, not inference."""
    fam_id, m = rng.choice(d.individuals)
    pairs = list(itertools.combinations(d.loci, 2))
    rng.shuffle(pairs)
    for pair in pairs:
        loci = list(normalize_loci(pair))
        if sum(_is_het(m["genotype"], l) for l in loci) != 1:
            continue
        h1, h2 = (tuple(h) for h in m["truth"]["haplotypes"])
        idx = [d.loci.index(l) for l in loci]
        truth = order_normalise(tuple(h1[i] for i in idx), tuple(h2[i] for i in idx))
        return _mk(ref, "phase_trivial", seed, INSTR_PHASE, loci, m["genotype"], d.population,
                   {"haplotypes": truth}, [], notes={"individual": f"{fam_id}/{m['id']}"})
    return None


def gen_family_phase(ref: ImgtReference, d: _Data, rng: random.Random, seed: int) -> Optional[Task]:
    """A child heterozygous at two or more loci whose phase Mendel alone decides from the
    parents' unphased genotypes.  The truth is the generator's phased pair; the oracle
    enumeration must agree with it, or the generator is wrong."""
    fam_id, child, father, mother = rng.choice(d.children)
    loci = d.loci
    if sum(_is_het(child["genotype"], l) for l in loci) < 2:
        return None
    allowed = mendelian_phasings(child["genotype"], father["genotype"], mother["genotype"], loci)
    if len(allowed) != 1:
        return None
    h1, h2 = (tuple(h) for h in child["truth"]["haplotypes"])
    truth = order_normalise(h1, h2)
    assert next(iter(allowed)) == (tuple(truth[0]), tuple(truth[1])), "Mendel oracle disagrees with construction"
    return _mk(ref, "family_phase", seed, INSTR_FAMILY, loci, child["genotype"], d.population,
               {"haplotypes": truth}, [],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}"})


def gen_consistency_check(ref: ImgtReference, d: _Data, rng: random.Random, seed: int) -> Optional[Task]:
    """A child's genotype made impossible under its parents, two ways:

    ``foreign_allele``          one allele replaced by a real allele from the pool at that
                                locus that neither parent carries (the planted typo);
    ``impossible_combination``  both alleles at one locus taken from one heterozygous
                                parent while the other parent carries neither, so no
                                allele can have come from the second parent.

    The planted name always exists in the pinned release: the inconsistency is Mendelian,
    never nomenclature, so a hallucination check cannot shortcut the task."""
    fam_id, child, father, mother = rng.choice(d.children)
    loci = d.loci
    genotype = {l: list(child["genotype"][l]) for l in loci}
    variants = ["foreign_allele", "impossible_combination"]
    rng.shuffle(variants)
    planted = None
    for variant in variants:
        for l in rng.sample(loci, len(loci)):
            parents = set(father["genotype"][l]) | set(mother["genotype"][l])
            if variant == "foreign_allele":
                foreign = [a for a in d.alleles_by_locus[l] if a not in parents]
                if not foreign:
                    continue
                keep = genotype[l][rng.randrange(2)]
                genotype[l] = sorted([keep, rng.choice(foreign)])
            else:
                donor, other = (father, mother) if rng.random() < 0.5 else (mother, father)
                pair = donor["genotype"][l]
                if pair[0] == pair[1] or set(pair) & set(other["genotype"][l]):
                    continue
                genotype[l] = sorted(pair)
            planted = {"variant": variant, "locus": l, "genotype_at_locus": list(genotype[l])}
            break
        if planted:
            break
    if planted is None:
        return None
    allowed = mendelian_phasings(genotype, father["genotype"], mother["genotype"], loci)
    assert not allowed, "planted genotype is still Mendel-consistent"
    return _mk(ref, "consistency_check", seed, INSTR_FAMILY, loci, genotype, d.population,
               "UNRESOLVABLE", ["inconsistent_genotype"],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}", "planted": planted},
               slices=[planted["variant"]])


GENERATORS = {
    "phase_trivial": gen_phase_trivial,
    "consistency_check": gen_consistency_check,
    "family_phase": gen_family_phase,
}


# -------------------------------------------------------------------------- the suite
def generate_suite(ref: ImgtReference, base_seed: int = BASE_SEED, dev_fraction: float = 0.2):
    """Layer-1 dataset → graded tasks, deterministic from ``(ref.tag, base_seed)``.
    The dev/test split is keyed on the task id, as families A and C do it."""
    data = _Data(generate_dataset(ref, seed=base_seed, n_families=DATASET_FAMILIES,
                                  n_children=DATASET_CHILDREN))
    tasks: list[Task] = []
    seen: set[tuple] = set()
    for subtype, gen in GENERATORS.items():
        _, want = COUNTS[subtype]
        made, seed = 0, 0
        while made < want and seed < want * 40:
            rng = random.Random(int(hashlib.sha256(f"{base_seed}:{subtype}:{seed}".encode()).hexdigest()[:12], 16))
            t = gen(ref, data, rng, seed)
            seed += 1
            if t is None or t.key() in seen:
                continue
            seen.add(t.key())
            t.scorer_notes["split"] = "dev" if int(hashlib.sha256(
                t.task_id.encode()).hexdigest(), 16) % 100 < dev_fraction * 100 else "test"
            tasks.append(t)
            made += 1
        if made < want:
            raise RuntimeError(f"{subtype}: only {made}/{want} distinct tasks from the layer-1 dataset")
    manifest = {
        "benchmark": f"HLA-Bench-B-v0.1@IMGT-{ref.release}", "family": FAMILY,
        "tag": ref.tag, "base_seed": base_seed, "total": len(tasks),
        "split": {"dev": sum(1 for t in tasks if t.scorer_notes["split"] == "dev"),
                  "test": sum(1 for t in tasks if t.scorer_notes["split"] == "test")},
        "by_subtype": {s: sum(1 for t in tasks if t.subtype == s) for s in COUNTS},
        "suite_rev": SUITE_REV, "generator_rev": GENERATOR_REV,
        "layer": "synthetic_mendelian_truth (TASK_SPEC_FAMILY_B §5 layer 1; no frequency model)",
        "dataset_parameters": data.data["parameters"],
    }
    return tasks, manifest
