"""Family B, layers 2 and 3 — the graded subtypes on top of the layer-1 generator
(docs/TASK_SPEC_FAMILY_B.md §3, §4, §7, §8).

Eight subtypes need nothing but Mendelian truth — no LD model, no frequency table —
so they are buildable from ``mendelian.py``:

  * T1 ``phase_trivial``        — two loci, exactly one heterozygous; the phase is forced.
  * T1 ``consistency_check``    — a child's genotype with a planted impossibility; the only
                                  right answer is ``UNRESOLVABLE`` + ``inconsistent_genotype``.
  * T2 ``impute_missing_locus`` — a child typed at two of three loci (the third is ``null``)
                                  plus both parents' *phased* haplotypes; the pair with the
                                  untyped locus filled in (slice ``family_determinate``).
  * T3 ``resolution_lift``      — the child typed at two fields, the parents unphased at full
                                  resolution; the pair at full resolution with
                                  ``low_resolution_input`` raised (slice ``family_determinate``).
  * T3 ``phase_ambiguous``      — Mendel allows exactly two pairs; the answer is the ranked
                                  list of both with ``phase_ambiguous`` (slice ``mendelian_set``).
  * T4 ``family_phase``         — the child plus both parents' *unphased* genotypes; the
                                  child's phase is decidable by Mendel alone.
  * T4 ``pedigree_phase``       — child, parents and all four grandparents, all unphased; the
                                  parents alone leave two or more pairs, the pedigree leaves one.
  * T4 ``null_in_haplotype``    — the ``family_phase`` shape drawn from the null-quota pool;
                                  ``null_allele`` is expected when the child's truth carries an
                                  N allele (slice ``carried``), not when only a parent does
                                  (slice ``decoy``).

Tasks reuse family A's ``Task`` record and JSON envelope.  Everything is deterministic
from ``(tag, base_seed)``; the same seed writes byte-identical task files.  The agent
never sees which subtype a family task belongs to: every subtype that shows relatives
shares one instruction text, so it has to find out for itself whether the answer is one
pair, two pairs, a filled-in or lifted pair, or the sentinel.  Selection enumerates the
eligible individuals in seeded order (§8.5), so yield equals supply and a subtype whose
supply falls under its count fails generation instead of shipping thin.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import random
from typing import Callable, Optional

from sci_envs.reference.imgt import ImgtReference, split_allele, truncate
from sci_envs.families.nomenclature.task import Task, dumps
from sci_envs.families.matching.generate import write_suite       # family-agnostic file writer
from .mendelian import (
    FAMILY, BASE_SEED, GENERATOR_REV, generate_dataset, normalize_loci,
    mendelian_phasings, phased_pairs, pedigree_phasings, order_normalise,
)

__all__ = ["SUITE_REV", "COUNTS", "DATASETS", "RESPONSE_CONTRACT", "GRANDPARENTS", "generate_suite",
           "write_suite", "mendelian_phasings", "lifted_phasings", "order_normalise", "GENERATORS",
           "split_key"]

SUITE_REV = "B3-r1"          # bump on any generator change: task ids key the response cache
COUNTS = {                   # subtype -> (tier, n), §7.1 and §8.2
    "phase_trivial": (1, 30),
    "consistency_check": (1, 30),
    "impute_missing_locus": (2, 30),
    "resolution_lift": (3, 30),
    "phase_ambiguous": (3, 30),
    "family_phase": (4, 30),
    "pedigree_phase": (4, 30),
    "null_in_haplotype": (4, 30),
}
# The four layer-1 datasets of §8.5, as generate_dataset() keyword arguments.  D-main
# replaced layer 2's 60-family set; the other three exist for one subtype each.
DATASETS = {
    "D-main": dict(n_families=300, n_children=2),
    "D-ped": dict(n_families=600, n_children=2, grandparents=True),
    "D-null": dict(n_families=300, n_children=2, null_per_locus=2),
    "D-lift": dict(n_families=300, n_children=2, sibling_pairs_per_locus=3),
}
GRANDPARENTS = ("paternal_grandfather", "paternal_grandmother", "maternal_grandfather", "maternal_grandmother")

RESPONSE_CONTRACT = (
    'Respond with ONLY a JSON object: {"answer": <see below>, "confidence": "high"|"medium"|"low", '
    '"flags": [<strings>], "reasoning": "<brief>"}. "answer" is {"haplotypes": [[<one allele per '
    'locus, in the order given by "loci">], [<the other haplotype>]]} when exactly one pair is '
    'possible; {"ranked": [{"haplotypes": [...], "probability": <optional, 0 to 1>}, ...]} with '
    'two or three entries when more than one pair remains possible (probabilities, if given, '
    'must sum to at most 1); or "UNRESOLVABLE". The order of the two haplotypes within a pair '
    'does not matter. Recognized flags: phase_ambiguous, rare_haplotype, inconsistent_genotype, '
    'low_resolution_input, null_allele. '
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
# One text for every subtype that shows relatives (§7.1, §8.2): nothing in it says which
# case the agent is facing.
INSTR_FAMILY = INSTR_PHASE + (
    " The genotypes of the individual's relatives are given under \"relatives\": always the "
    "father and mother, and sometimes all four grandparents (paternal_grandfather, "
    "paternal_grandmother, maternal_grandfather, maternal_grandmother). A relative given as "
    "an unphased genotype has two alleles per locus in no particular order; a relative given "
    "as {\"haplotypes\": [h1, h2]} is already phased, established by a prior family study. "
    "Inheritance is Mendelian with whole-haplotype transmission (no recombination within the "
    "HLA block): one haplotype came whole from the father and the other whole from the "
    "mother. Use the relatives to decide which alleles travel together. If one of the "
    "individual's loci is null, it was not typed: fill it in from the relatives. If the "
    "individual's alleles are given at two fields while the relatives' are at full "
    "resolution, return the haplotypes at the relatives' resolution and raise "
    "low_resolution_input. If the relatives leave exactly one possible pair, return it as "
    "\"haplotypes\"; if they leave two, return both under \"ranked\" and raise "
    "phase_ambiguous. If a haplotype you return carries a null (N-suffixed) allele, raise "
    "null_allele. If the individual's genotype could not have arisen from these relatives, "
    "answer \"UNRESOLVABLE\" with the inconsistent_genotype flag."
)

Genotype = dict[str, list[str]]
Hap = tuple[str, ...]
Pair = tuple[Hap, Hap]


# ------------------------------------------------------------------- lift oracle (§8.2)
def lifted_phasings(child_two_field: Genotype, father: Genotype, mother: Genotype,
                    loci: list[str]) -> set[Pair]:
    """``mendelian_phasings`` over the parents' full-resolution alleles whose two-field form
    matches the child's two-field pair at each locus: every full-resolution pair the
    two-field child could be, given unphased parents."""
    per_locus: list[set[tuple[str, str]]] = []
    for l in loci:
        c = sorted(child_two_field[l])
        options = {(p, m) for p in father[l] for m in mother[l]
                   if sorted([truncate(p, 2), truncate(m, 2)]) == c}
        if not options:
            return set()
        per_locus.append(options)
    out: set[Pair] = set()
    for combo in itertools.product(*per_locus):
        paternal = tuple(p for p, _ in combo)
        maternal = tuple(m for _, m in combo)
        a, b = sorted((paternal, maternal))
        out.add((a, b))
    return out


def _is_het(genotype: Genotype, locus: str) -> bool:
    return genotype[locus][0] != genotype[locus][1]


def _is_null(allele: str) -> bool:
    return split_allele(allele)[2] == "N"


def _truth_pair(member: dict) -> Pair:
    h1, h2 = (tuple(h) for h in member["truth"]["haplotypes"])
    a, b = sorted((h1, h2))
    return (a, b)


def _as_lists(pair: Pair) -> list[list[str]]:
    return [list(pair[0]), list(pair[1])]


# ------------------------------------------------------------------------ task factory
def _mk(ref: ImgtReference, subtype: str, seed: int, instructions: str, loci: list[str],
        genotype: dict, population: str, canonical, expected_flags: list[str],
        relatives: Optional[dict] = None, notes: Optional[dict] = None,
        slices: Optional[list[str]] = None) -> Task:
    tier, _ = COUNTS[subtype]
    inp = {"loci": list(loci),
           "genotype": {l: (None if genotype[l] is None else list(genotype[l])) for l in loci},
           "population": population}
    if relatives is not None:
        inp["relatives"] = {}
        for who, g in relatives.items():
            if "haplotypes" in g:                      # phased relative (impute_missing_locus)
                inp["relatives"][who] = {"haplotypes": [list(h) for h in g["haplotypes"]]}
            else:
                inp["relatives"][who] = {l: list(g[l]) for l in loci}
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
    """A layer-1 dataset indexed for the generators."""

    def __init__(self, data: dict):
        self.data = data
        self.loci: list[str] = list(data["pool"]["loci"])
        self.population: str = data["pool"]["population"]
        self.alleles_by_locus: dict[str, list[str]] = data["pool"]["alleles_by_locus"]
        self.individuals: list[tuple[str, dict]] = [
            (fam["family_id"], m) for fam in data["families"] for m in fam["members"]]
        # (family_id, child, father, mother, members-by-id) for every non-founder
        self.children: list[tuple[str, dict, dict, dict, dict]] = []
        for fam in data["families"]:
            ix = {m["id"]: m for m in fam["members"]}
            for m in fam["members"]:
                if m["father"] is not None:
                    self.children.append((fam["family_id"], m, ix[m["father"]], ix[m["mother"]], ix))


# ---------------------------------------------------------------------- the subtypes
# Each subtype is (dataset, candidates, build, pattern): ``candidates(d)`` lists every
# eligible individual as (stratum, payload); ``build`` turns one into a Task (None if
# the seeded plant fails); ``pattern`` is the stratum cycle the selection follows so
# balanced subtypes stay balanced (the untyped locus rotates, carried:decoy is 2:1).

def cand_phase_trivial(d: _Data) -> list[tuple[str, tuple]]:
    out = []
    for fam_id, m in d.individuals:
        for pair in itertools.combinations(d.loci, 2):
            loci = list(normalize_loci(pair))
            if sum(_is_het(m["genotype"], l) for l in loci) == 1:
                out.append(("all", (fam_id, m, loci)))
    return out


def build_phase_trivial(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    """Two loci, exactly one heterozygous: the homozygous allele sits on both haplotypes,
    so the pair is forced.  Tests representation, not inference."""
    fam_id, m, loci = payload
    h1, h2 = (tuple(h) for h in m["truth"]["haplotypes"])
    idx = [d.loci.index(l) for l in loci]
    truth = order_normalise(tuple(h1[i] for i in idx), tuple(h2[i] for i in idx))
    return _mk(ref, "phase_trivial", seed, INSTR_PHASE, loci, m["genotype"], d.population,
               {"haplotypes": truth}, [], notes={"individual": f"{fam_id}/{m['id']}"})


def _family_phase_eligible(d: _Data) -> list[tuple[str, dict, dict, dict, dict]]:
    """Children heterozygous at two or more loci whose phase Mendel alone decides from the
    parents' unphased genotypes (§7.1); the oracle must agree with construction."""
    out = []
    for fam_id, child, father, mother, ix in d.children:
        if child["role"] != "child" or sum(_is_het(child["genotype"], l) for l in d.loci) < 2:
            continue
        allowed = mendelian_phasings(child["genotype"], father["genotype"], mother["genotype"], d.loci)
        if len(allowed) != 1:
            continue
        assert next(iter(allowed)) == _truth_pair(child), "Mendel oracle disagrees with construction"
        out.append((fam_id, child, father, mother, ix))
    return out


def cand_family_phase(d: _Data) -> list[tuple[str, tuple]]:
    return [("all", c) for c in _family_phase_eligible(d)]


def build_family_phase(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother, _ = payload
    return _mk(ref, "family_phase", seed, INSTR_FAMILY, d.loci, child["genotype"], d.population,
               {"haplotypes": _as_lists(_truth_pair(child))}, [],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}"})


def cand_consistency_check(d: _Data) -> list[tuple[str, tuple]]:
    return [("all", c) for c in d.children if c[1]["role"] == "child"]


def build_consistency_check(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random,
                            seed: int) -> Optional[Task]:
    """A child's genotype made impossible under its parents, two ways:

    ``foreign_allele``          one allele replaced by a real allele from the pool at that
                                locus that neither parent carries (the planted typo);
    ``impossible_combination``  both alleles at one locus taken from one heterozygous
                                parent while the other parent carries neither, so no
                                allele can have come from the second parent.

    The planted name always exists in the pinned release: the inconsistency is Mendelian,
    never nomenclature, so a hallucination check cannot shortcut the task."""
    fam_id, child, father, mother, _ = payload
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


def cand_impute_missing_locus(d: _Data) -> list[tuple[str, tuple]]:
    """§8.2: for each child and each locus X, blank X and enumerate the father's two
    haplotypes × the mother's two; keep the pairs that match the child at the typed loci.
    Exactly one pair makes a candidate, stratified by X so the untyped locus rotates.
    Trivial cases — both parents homozygous at X — are excluded."""
    out = []
    for fam_id, child, father, mother, _ in d.children:
        if child["role"] != "child":
            continue
        fh = [tuple(h) for h in father["truth"]["haplotypes"]]
        mh = [tuple(h) for h in mother["truth"]["haplotypes"]]
        for X in d.loci:
            if not _is_het(father["genotype"], X) and not _is_het(mother["genotype"], X):
                continue
            partial = {l: (None if l == X else child["genotype"][l]) for l in d.loci}
            allowed = phased_pairs(fh, mh, partial, d.loci)
            if len(allowed) != 1:
                continue
            assert next(iter(allowed)) == _truth_pair(child), "imputation oracle disagrees with construction"
            out.append((X, (fam_id, child, father, mother, X)))
    return out


def build_impute_missing_locus(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother, X = payload
    genotype = {l: (None if l == X else child["genotype"][l]) for l in d.loci}
    phased = {who: {"haplotypes": order_normalise(*(tuple(h) for h in p["truth"]["haplotypes"]))}
              for who, p in (("father", father), ("mother", mother))}
    return _mk(ref, "impute_missing_locus", seed, INSTR_FAMILY, d.loci, genotype, d.population,
               {"haplotypes": _as_lists(_truth_pair(child))}, [],
               relatives=phased,
               notes={"individual": f"{fam_id}/{child['id']}", "untyped_locus": X},
               slices=["family_determinate"])


def cand_resolution_lift(d: _Data) -> list[tuple[str, tuple]]:
    """§8.2: the child's names truncated to two fields; the oracle runs over the parents'
    full-resolution alleles whose two-field form matches.  Exactly one pair, and a
    non-trivial lift — at some locus the child's two-field name covers two or more
    distinct full-resolution parental alleles — makes a candidate."""
    out = []
    for fam_id, child, father, mother, _ in d.children:
        if child["role"] != "child":
            continue
        two = {l: sorted(truncate(a, 2) for a in child["genotype"][l]) for l in d.loci}
        allowed = lifted_phasings(two, father["genotype"], mother["genotype"], d.loci)
        if len(allowed) != 1:
            continue
        assert next(iter(allowed)) == _truth_pair(child), "lift oracle disagrees with construction"
        nontrivial = False
        for l in d.loci:
            parental = set(father["genotype"][l]) | set(mother["genotype"][l])
            for t in two[l]:
                if len({a for a in parental if truncate(a, 2) == t}) >= 2:
                    nontrivial = True
        if not nontrivial:
            continue
        out.append(("all", (fam_id, child, father, mother, two)))
    return out


def build_resolution_lift(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother, two = payload
    return _mk(ref, "resolution_lift", seed, INSTR_FAMILY, d.loci, two, d.population,
               {"haplotypes": _as_lists(_truth_pair(child))}, ["low_resolution_input"],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}", "input_fields": 2,
                      "full_resolution_genotype": {l: list(child["genotype"][l]) for l in d.loci}},
               slices=["family_determinate"])


def cand_phase_ambiguous(d: _Data) -> list[tuple[str, tuple]]:
    """§8.2 ``mendelian_set``: Mendel allows exactly two pairs (three cannot happen; four
    is outside §1's cap of three and is not a candidate)."""
    out = []
    for fam_id, child, father, mother, _ in d.children:
        if child["role"] != "child":
            continue
        allowed = mendelian_phasings(child["genotype"], father["genotype"], mother["genotype"], d.loci)
        if len(allowed) != 2:
            continue
        assert _truth_pair(child) in allowed, "Mendel set does not contain construction"
        out.append(("all", (fam_id, child, father, mother, sorted(allowed))))
    return out


def build_phase_ambiguous(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother, allowed = payload
    return _mk(ref, "phase_ambiguous", seed, INSTR_FAMILY, d.loci, child["genotype"], d.population,
               {"ranked": [{"haplotypes": _as_lists(p)} for p in allowed]}, ["phase_ambiguous"],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}", "mendel_pairs": len(allowed)},
               slices=["mendelian_set"])


def cand_pedigree_phase(d: _Data) -> list[tuple[str, tuple]]:
    """§8.2: the parents alone leave two or more pairs, the three-generation pedigree
    leaves exactly one — the grandparents are necessary, not decoration."""
    out = []
    for fam_id, child, father, mother, ix in d.children:
        if child["role"] != "child" or not all(g in ix for g in GRANDPARENTS):
            continue
        parents_only = mendelian_phasings(child["genotype"], father["genotype"], mother["genotype"], d.loci)
        if len(parents_only) < 2:
            continue
        gp = {g: ix[g]["genotype"] for g in GRANDPARENTS}
        allowed = pedigree_phasings(child["genotype"], father["genotype"], mother["genotype"], gp, d.loci)
        if len(allowed) != 1:
            continue
        assert next(iter(allowed)) == _truth_pair(child), "pedigree oracle disagrees with construction"
        out.append(("all", (fam_id, child, father, mother, gp, len(parents_only))))
    return out


def build_pedigree_phase(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother, gp, n_parents_only = payload
    relatives = {"father": father["genotype"], "mother": mother["genotype"], **gp}
    return _mk(ref, "pedigree_phase", seed, INSTR_FAMILY, d.loci, child["genotype"], d.population,
               {"haplotypes": _as_lists(_truth_pair(child))}, [],
               relatives=relatives,
               notes={"individual": f"{fam_id}/{child['id']}", "parents_only_pairs": n_parents_only})


def cand_null_in_haplotype(d: _Data) -> list[tuple[str, tuple]]:
    """§8.2: the ``family_phase`` filter on the null-quota dataset; ``carried`` when the
    child's truth pair holds an N allele, ``decoy`` when only a parent does."""
    out = []
    for fam_id, child, father, mother, ix in _family_phase_eligible(d):
        carried = any(_is_null(a) for l in d.loci for a in child["genotype"][l])
        in_parent = any(_is_null(a) for l in d.loci for who in (father, mother) for a in who["genotype"][l])
        if carried:
            out.append(("carried", (fam_id, child, father, mother)))
        elif in_parent:
            out.append(("decoy", (fam_id, child, father, mother)))
    return out


def build_null_in_haplotype(ref: ImgtReference, d: _Data, payload: tuple, rng: random.Random, seed: int) -> Task:
    fam_id, child, father, mother = payload
    carried = any(_is_null(a) for l in d.loci for a in child["genotype"][l])
    return _mk(ref, "null_in_haplotype", seed, INSTR_FAMILY, d.loci, child["genotype"], d.population,
               {"haplotypes": _as_lists(_truth_pair(child))}, ["null_allele"] if carried else [],
               relatives={"father": father["genotype"], "mother": mother["genotype"]},
               notes={"individual": f"{fam_id}/{child['id']}"},
               slices=["carried" if carried else "decoy"])


Generator = tuple[str, Callable[[_Data], list], Callable[..., Optional[Task]], tuple[str, ...]]
GENERATORS: dict[str, Generator] = {
    "phase_trivial": ("D-main", cand_phase_trivial, build_phase_trivial, ("all",)),
    "consistency_check": ("D-main", cand_consistency_check, build_consistency_check, ("all",)),
    "impute_missing_locus": ("D-main", cand_impute_missing_locus, build_impute_missing_locus, ("A", "B", "DRB1")),
    "resolution_lift": ("D-lift", cand_resolution_lift, build_resolution_lift, ("all",)),
    "phase_ambiguous": ("D-main", cand_phase_ambiguous, build_phase_ambiguous, ("all",)),
    "family_phase": ("D-main", cand_family_phase, build_family_phase, ("all",)),
    "pedigree_phase": ("D-ped", cand_pedigree_phase, build_pedigree_phase, ("all",)),
    "null_in_haplotype": ("D-null", cand_null_in_haplotype, build_null_in_haplotype, ("carried", "carried", "decoy")),
}


# -------------------------------------------------------------------------- the suite
def _split_of(task_id_without_rev: str, dev_fraction: float) -> str:
    """Family A's split rule, keyed on the id *without* its revision segment (§8.5): a rev
    bump that leaves a task's content unchanged leaves its split unchanged."""
    h = int(hashlib.sha256(task_id_without_rev.encode()).hexdigest(), 16) % 10_000
    return "dev" if h < dev_fraction * 10_000 else "test"


def split_key(task_id: str) -> str:
    """``hla_phasing.<rev>.T<tier>.<subtype>.<seed>`` -> ``hla_phasing.T<tier>.<subtype>.<seed>``."""
    fam, _rev, rest = task_id.split(".", 2)
    return f"{fam}.{rest}"


def _select(subtype: str, ref: ImgtReference, d: _Data, base_seed: int, seen: set[tuple]) -> list[Task]:
    """Enumerate the eligible list in seeded order, cycling the subtype's strata, until the
    count is met; fewer distinct eligible tasks than the count is a generation failure."""
    _, want = COUNTS[subtype]
    _, candidates, build, pattern = GENERATORS[subtype]
    strata: dict[str, list] = {s: [] for s in pattern}
    for stratum, payload in candidates(d):
        strata.setdefault(stratum, []).append(payload)
    order_rng = random.Random(int(hashlib.sha256(f"{base_seed}:{subtype}:order".encode()).hexdigest()[:12], 16))
    queues = {s: order_rng.sample(items, len(items)) for s, items in strata.items()}
    supply = sum(len(q) for q in queues.values())
    tasks: list[Task] = []
    seed, pos = 0, 0
    while len(tasks) < want and any(queues.values()):
        stratum = pattern[pos % len(pattern)]
        pos += 1
        if not queues[stratum]:
            continue                                   # this stratum is spent; the loop stops when all are
        payload = queues[stratum].pop()
        rng = random.Random(int(hashlib.sha256(f"{base_seed}:{subtype}:{seed}".encode()).hexdigest()[:12], 16))
        t = build(ref, d, payload, rng, seed)
        seed += 1
        if t is None or t.key() in seen:
            continue
        seen.add(t.key())
        tasks.append(t)
    if len(tasks) < want:
        raise RuntimeError(f"{subtype}: only {len(tasks)}/{want} distinct tasks from {supply} eligible "
                           f"individuals in the layer-1 dataset at {ref.release} (the §8.5 guard)")
    return tasks


def generate_suite(ref: ImgtReference, base_seed: int = BASE_SEED, dev_fraction: float = 0.2):
    """Layer-1 datasets → graded tasks, deterministic from ``(ref.tag, base_seed)``.
    The dev/test split is keyed on the task id without its revision segment (§8.5)."""
    datasets = {name: _Data(generate_dataset(ref, seed=base_seed, **kw)) for name, kw in DATASETS.items()}
    tasks: list[Task] = []
    seen: set[tuple] = set()
    for subtype, (dataset, _, _, _) in GENERATORS.items():
        for t in _select(subtype, ref, datasets[dataset], base_seed, seen):
            t.scorer_notes["split"] = _split_of(split_key(t.task_id), dev_fraction)
            tasks.append(t)
    manifest = {
        "benchmark": f"HLA-Bench-B-v0.1@IMGT-{ref.release}", "family": FAMILY,
        "reference": {"db": "IPD-IMGT/HLA", "release": ref.release, "tag": ref.tag},
        "tag": ref.tag, "base_seed": base_seed, "total": len(tasks),
        "split": {"dev": sum(1 for t in tasks if t.scorer_notes["split"] == "dev"),
                  "test": sum(1 for t in tasks if t.scorer_notes["split"] == "test")},
        "by_subtype": {s: sum(1 for t in tasks if t.subtype == s) for s in COUNTS},
        "suite_rev": SUITE_REV, "generator_rev": GENERATOR_REV,
        "layer": "synthetic_mendelian_truth (TASK_SPEC_FAMILY_B §5 layer 1; no frequency model)",
        "dataset_parameters": datasets["D-main"].data["parameters"],
        "datasets": {name: d.data["parameters"] for name, d in datasets.items()},
        "subtype_dataset": {s: g[0] for s, g in GENERATORS.items()},
    }
    return tasks, manifest
