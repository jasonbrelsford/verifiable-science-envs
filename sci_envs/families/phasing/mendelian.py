"""Family B, layer 1 — synthetic Mendelian truth (docs/TASK_SPEC_FAMILY_B.md §5, layer 1).

Ground truth for haplotype phasing is *generated*, never licensed:

1. a compact pool of phased founder haplotypes is drawn from the pinned IPD-IMGT/HLA
   release (allele names come from the loader's ``Allelelist.txt``; no data file is
   written or redistributed),
2. founders are paired and their haplotypes inherited under Mendel's rules — one
   haplotype from each parent, no recombination inside the HLA block for v0 — to build
   families of a requested shape,
3. every individual's genotype is unphased (alleles sorted per locus) to form the task
   input, while the phased truth is kept alongside.

Everything is deterministic from ``(tag, seed, parameters)``: the same call writes
byte-identical output, which is the property ``docs/RELEASE_BUMP.md`` relies on for
the other families.  The §6 question-1 parameters (pool size, locus set, population)
are arguments whose defaults are the spec's proposal, not constants.

Layer 3 (§8.1) adds two purpose-built pool parameters, ``null_per_locus`` and
``sibling_pairs_per_locus``, as post-draw relabellings of the default pool under their
own seeded streams (the default pool's bytes do not change), plus the two enumeration
oracles the pedigree subtype needs, ``phased_pairs`` and ``pedigree_phasings``.  The
Mendel oracle over unphased parents, ``mendelian_phasings``, lives here too.

No grading, no subtypes, no bench split here — those are ``tasks.py`` and ``grade.py``.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import random
import sys
from dataclasses import dataclass, field
from typing import Optional, Sequence

from sci_envs.reference.imgt import ImgtReference, split_allele, truncate
from sci_envs.families.nomenclature.task import dumps

FAMILY = "hla_phasing"
LAYER = "synthetic_mendelian_truth"
GENERATOR_REV = "B1-r2"      # bump on any change that alters output for a fixed seed
BASE_SEED = 20260831

# TASK_SPEC_FAMILY_B §6 question 1 — the proposal, as defaults.  Change the flag, not the code.
DEFAULT_FOUNDERS = 40
DEFAULT_LOCI = ("A", "B", "DRB1")
DEFAULT_POPULATION = "synthetic-pop-1"
DEFAULT_ALLELES_PER_LOCUS = 12
DEFAULT_FAMILIES = 20
DEFAULT_CHILDREN = 2
DEFAULT_TAG = "v3.66.0-alpha"

# §1: 2–5 loci among A, C, B, DRB1, DQB1.  Kept in genomic order for output.
LOCI_ALLOWED = ("A", "C", "B", "DRB1", "DQB1")

Haplotype = tuple[str, ...]      # one allele per locus, in pool.loci order


class PhasingError(ValueError):
    pass


def _rng(seed: int, *parts: object) -> random.Random:
    """Independent, reproducible stream per purpose (same scheme as family C)."""
    key = ":".join(str(p) for p in (seed, *parts))
    return random.Random(int(hashlib.sha256(key.encode()).hexdigest()[:16], 16))


def normalize_loci(loci: Sequence[str]) -> tuple[str, ...]:
    """Validate a locus list against §1 and return it in genomic order."""
    seen = []
    for l in loci:
        l = l.strip().upper().removeprefix("HLA-")
        if l not in LOCI_ALLOWED:
            raise PhasingError(f"locus {l!r} is outside family B's scope {LOCI_ALLOWED}")
        if l in seen:
            raise PhasingError(f"locus {l!r} given twice")
        seen.append(l)
    if not 2 <= len(seen) <= 5:
        raise PhasingError(f"family B takes 2–5 loci, got {len(seen)}")
    return tuple(sorted(seen, key=LOCI_ALLOWED.index))


# ---------------------------------------------------------------------------- founder pool
@dataclass
class FounderPool:
    loci: tuple[str, ...]
    population: str
    haplotypes: list[Haplotype]          # distinct, frequency-descending
    frequencies: list[float]             # sum to 1.0 (6 dp), aligned with haplotypes
    alleles_by_locus: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "population": self.population,
            "loci": list(self.loci),
            "size": len(self.haplotypes),
            "alleles_by_locus": {l: list(a) for l, a in self.alleles_by_locus.items()},
            "haplotypes": [{"alleles": list(h), "frequency": f}
                           for h, f in zip(self.haplotypes, self.frequencies)],
        }

    def draw(self, rng: random.Random) -> Haplotype:
        return rng.choices(self.haplotypes, weights=self.frequencies, k=1)[0]


def _candidate_alleles(ref: ImgtReference, locus: str, allow_suffix: bool) -> list[str]:
    """Full-resolution names from the pinned release at one locus (the pool is at the
    release's own resolution — §3 ``resolution_lift`` lifts *inputs*, not the pool)."""
    out = []
    for name in ref.alleles(locus):
        _, fields, suffix = split_allele(name)
        if len(fields) < 2:
            continue
        if suffix and not allow_suffix:
            continue
        out.append(name)
    return out


def _skewed_weights(rng: random.Random, n: int) -> list[float]:
    """Exponential draws, normalised and sorted descending: a few common, a long tail."""
    raw = sorted((rng.expovariate(1.0) for _ in range(n)), reverse=True)
    total = sum(raw)
    return [w / total for w in raw]


def _round_to_one(weights: list[float], places: int = 6) -> list[float]:
    """Round to ``places`` and push the rounding remainder onto the largest weight so
    the frequencies sum to exactly 1.0 at that precision."""
    out = [round(w, places) for w in weights]
    out[0] = round(out[0] + (1.0 - sum(out)), places)
    return out


def draw_founder_pool(ref: ImgtReference, seed: int = BASE_SEED,
                      n_founders: int = DEFAULT_FOUNDERS,
                      loci: Sequence[str] = DEFAULT_LOCI,
                      population: str = DEFAULT_POPULATION,
                      alleles_per_locus: int = DEFAULT_ALLELES_PER_LOCUS,
                      allow_suffix: bool = False,
                      null_per_locus: int = 0,
                      sibling_pairs_per_locus: int = 0) -> FounderPool:
    """Draw ``n_founders`` distinct phased haplotypes over ``loci`` from the pinned release.

    Each locus contributes ``alleles_per_locus`` distinct alleles with skewed per-locus
    weights; haplotypes are combinations drawn under those weights (so alleles recur
    across haplotypes and phase is not trivially forced), de-duplicated, then given
    skewed frequencies.  The pool is small by design: §2 needs posteriors computed by
    exact enumeration over it.

    The two layer-3 parameters (§8.1) relabel the drawn pool after the draw, each under
    its own seeded stream, so a pool with both at zero is byte-identical to layer 1's:

    ``null_per_locus``          k of the alleles at every locus are replaced by N-suffixed
                                (null) names from the release — a promise the random
                                ``allow_suffix`` cannot make;
    ``sibling_pairs_per_locus`` p pairs of alleles at every locus are replaced by pairs
                                of full-resolution names that share one two-field prefix
                                (and share it with nothing else at that locus), so a
                                two-field input covers two pool alleles.
    """
    loci = normalize_loci(loci)
    if n_founders < 2:
        raise PhasingError("a founder pool needs at least 2 haplotypes")
    if alleles_per_locus < 2:
        raise PhasingError("need at least 2 alleles per locus")
    if null_per_locus < 0 or sibling_pairs_per_locus < 0:
        raise PhasingError("null_per_locus and sibling_pairs_per_locus cannot be negative")
    if null_per_locus + 2 * sibling_pairs_per_locus > alleles_per_locus:
        raise PhasingError(f"{null_per_locus} null + {2 * sibling_pairs_per_locus} sibling slots exceed "
                           f"{alleles_per_locus} alleles per locus")
    rng = _rng(seed, "pool", ref.tag, population, n_founders, ",".join(loci), alleles_per_locus,
               int(allow_suffix))
    alleles_by_locus: dict[str, list[str]] = {}
    locus_weights: dict[str, list[float]] = {}
    for locus in loci:
        cands = _candidate_alleles(ref, locus, allow_suffix)
        if len(cands) < alleles_per_locus:
            raise PhasingError(f"{locus}: only {len(cands)} candidate alleles in {ref.release}")
        chosen = rng.sample(cands, alleles_per_locus)       # unsorted: weight order is random
        alleles_by_locus[locus] = chosen
        locus_weights[locus] = _skewed_weights(rng, alleles_per_locus)
    capacity = alleles_per_locus ** len(loci)
    if n_founders > capacity:
        raise PhasingError(f"{n_founders} founders cannot be distinct over {capacity} combinations")
    haps: list[Haplotype] = []
    seen: set[Haplotype] = set()
    while len(haps) < n_founders:
        h = tuple(rng.choices(alleles_by_locus[l], weights=locus_weights[l], k=1)[0] for l in loci)
        if h in seen:
            continue
        seen.add(h)
        haps.append(h)
    freqs = _round_to_one(_skewed_weights(rng, n_founders))
    if null_per_locus or sibling_pairs_per_locus:
        relabel = _relabel_map(ref, seed, loci, population, alleles_by_locus, null_per_locus,
                               sibling_pairs_per_locus)
        alleles_by_locus = {l: [relabel.get(a, a) for a in alleles] for l, alleles in alleles_by_locus.items()}
        haps = [tuple(relabel.get(a, a) for a in h) for h in haps]
        assert len(set(haps)) == len(haps)           # a bijective relabel keeps the pool distinct
    return FounderPool(loci=loci, population=population, haplotypes=haps, frequencies=freqs,
                       alleles_by_locus={l: sorted(a) for l, a in alleles_by_locus.items()})


def _relabel_map(ref: ImgtReference, seed: int, loci: tuple[str, ...], population: str,
                 alleles_by_locus: dict[str, list[str]], null_per_locus: int,
                 sibling_pairs_per_locus: int) -> dict[str, str]:
    """old name -> new name for the layer-3 pool parameters.  Slots are chosen and
    replacements drawn under streams keyed on the parameter, so the default pool is
    untouched and each parameter is independent of the other."""
    relabel: dict[str, str] = {}
    for locus in loci:
        current = list(alleles_by_locus[locus])
        free = list(range(len(current)))               # slot indices not yet relabelled
        if null_per_locus:
            rng = _rng(seed, "null", ref.tag, population, locus, null_per_locus)
            nulls = [n for n in ref.alleles(locus)
                     if split_allele(n)[2] == "N" and len(split_allele(n)[1]) >= 2 and n not in current]
            if len(nulls) < null_per_locus:
                raise PhasingError(f"{locus}: only {len(nulls)} null alleles in {ref.release}")
            slots = sorted(rng.sample(free, null_per_locus))
            for slot, new in zip(slots, rng.sample(nulls, null_per_locus)):
                relabel[current[slot]] = new
                free.remove(slot)
        if sibling_pairs_per_locus:
            rng = _rng(seed, "siblings", ref.tag, population, locus, sibling_pairs_per_locus)
            taken_prefixes = {truncate(a, 2) for a in current}
            by_prefix: dict[str, list[str]] = {}
            for n in ref.alleles(locus):
                _, fields, suffix = split_allele(n)
                if suffix or len(fields) < 3 or n in current:
                    continue
                by_prefix.setdefault(truncate(n, 2), []).append(n)
            prefixes = sorted(p for p, names in by_prefix.items() if len(names) >= 2 and p not in taken_prefixes)
            if len(prefixes) < sibling_pairs_per_locus:
                raise PhasingError(f"{locus}: only {len(prefixes)} two-field prefixes with siblings in {ref.release}")
            slots = sorted(rng.sample(free, 2 * sibling_pairs_per_locus))
            for i, prefix in enumerate(rng.sample(prefixes, sibling_pairs_per_locus)):
                pair = rng.sample(by_prefix[prefix], 2)
                for slot, new in zip(slots[2 * i:2 * i + 2], pair):
                    relabel[current[slot]] = new
                    free.remove(slot)
    return relabel


# ------------------------------------------------------------------------ individuals, families
@dataclass
class Individual:
    id: str
    role: str                                   # founder | parent | child
    haplotypes: tuple[Haplotype, Haplotype]     # phased truth: (from father, from mother) for
                                                # non-founders; draw order for founders
    father: Optional[str] = None
    mother: Optional[str] = None

    def to_dict(self, loci: Sequence[str]) -> dict:
        return {
            "id": self.id, "role": self.role, "father": self.father, "mother": self.mother,
            "genotype": unphase(self.haplotypes, loci),
            "truth": {"haplotypes": [list(h) for h in self.haplotypes],
                      "phase_known_by": "construction"},
        }


def unphase(haplotypes: tuple[Haplotype, Haplotype], loci: Sequence[str]) -> dict[str, list[str]]:
    """The task input: two alleles per locus with phase discarded (sorted, so neither the
    pair order nor the position in the list carries phase information)."""
    return {l: sorted([haplotypes[0][i], haplotypes[1][i]]) for i, l in enumerate(loci)}


def _gamete(parent: Individual, rng: random.Random) -> Haplotype:
    """Mendel, no recombination within the HLA block (v0): one whole haplotype."""
    return parent.haplotypes[rng.randrange(2)]


def _founder(pool: FounderPool, rng: random.Random, ident: str) -> Individual:
    return Individual(id=ident, role="founder", haplotypes=(pool.draw(rng), pool.draw(rng)))


def _child(father: Individual, mother: Individual, rng: random.Random, ident: str, role: str) -> Individual:
    return Individual(id=ident, role=role, haplotypes=(_gamete(father, rng), _gamete(mother, rng)),
                      father=father.id, mother=mother.id)


@dataclass
class Family:
    family_id: str
    shape: dict
    members: list[Individual]

    def by_id(self) -> dict[str, Individual]:
        return {m.id: m for m in self.members}

    def to_dict(self, loci: Sequence[str]) -> dict:
        return {"family_id": self.family_id, "shape": dict(self.shape),
                "members": [m.to_dict(loci) for m in self.members]}


def simulate_family(pool: FounderPool, rng: random.Random, family_id: str,
                    n_children: int = DEFAULT_CHILDREN, grandparents: bool = False) -> Family:
    """One nuclear family (two founder parents, ``n_children`` children) or, with
    ``grandparents=True``, a three-generation family whose parents are themselves
    children of founder grandparents."""
    if n_children < 1:
        raise PhasingError("a family needs at least one child")
    members: list[Individual] = []
    if grandparents:
        pgf, pgm = _founder(pool, rng, "paternal_grandfather"), _founder(pool, rng, "paternal_grandmother")
        mgf, mgm = _founder(pool, rng, "maternal_grandfather"), _founder(pool, rng, "maternal_grandmother")
        father = _child(pgf, pgm, rng, "father", "parent")
        mother = _child(mgf, mgm, rng, "mother", "parent")
        members += [pgf, pgm, mgf, mgm]
    else:
        father, mother = _founder(pool, rng, "father"), _founder(pool, rng, "mother")
        father.role = mother.role = "parent"
    members += [father, mother]
    for i in range(1, n_children + 1):
        members.append(_child(father, mother, rng, f"child{i}", "child"))
    return Family(family_id=family_id, members=members,
                  shape={"children": n_children, "generations": 3 if grandparents else 2})


def check_mendelian(family: Family) -> list[str]:
    """Violations of Mendel's rules in a family (empty list == consistent).  Used by the
    tests and available to later sub-steps as the ``inconsistent_genotype`` oracle."""
    ix = family.by_id()
    problems = []
    for m in family.members:
        if m.father is None and m.mother is None:
            continue
        paternal, maternal = m.haplotypes
        if paternal not in ix[m.father].haplotypes:
            problems.append(f"{family.family_id}/{m.id}: paternal haplotype not carried by {m.father}")
        if maternal not in ix[m.mother].haplotypes:
            problems.append(f"{family.family_id}/{m.id}: maternal haplotype not carried by {m.mother}")
    return problems


# ------------------------------------------------------------------------- Mendel oracles
Genotype = dict[str, list[str]]


def order_normalise(h1: Haplotype, h2: Haplotype) -> list[list[str]]:
    """The pair as the grader compares it: sorted, so neither position carries phase."""
    a, b = sorted((tuple(h1), tuple(h2)))
    return [list(a), list(b)]


def mendelian_phasings(child: Genotype, father: Genotype, mother: Genotype,
                       loci: Sequence[str]) -> set[tuple[Haplotype, Haplotype]]:
    """Every order-normalised haplotype pair for ``child`` that Mendel allows given the
    parents' *unphased* genotypes: at each locus one allele must come from the father's
    pair and the other from the mother's.  Whole-haplotype transmission adds no further
    constraint when the parents are unphased, so per-locus assignment is the whole rule.

    Empty set  == the genotype is inconsistent with these parents (``consistency_check``).
    One member == the phase is decidable by Mendel alone (``family_phase``).
    Two members == the Mendel set (``phase_ambiguous``); three cannot happen (§8.2).
    """
    per_locus: list[set[tuple[str, str]]] = []
    for l in loci:
        c = sorted(child[l])
        options = {(p, m) for p in father[l] for m in mother[l] if sorted([p, m]) == c}
        if not options:
            return set()
        per_locus.append(options)
    out: set[tuple[Haplotype, Haplotype]] = set()
    for combo in itertools.product(*per_locus):
        paternal = tuple(p for p, _ in combo)
        maternal = tuple(m for _, m in combo)
        a, b = sorted((paternal, maternal))
        out.add((a, b))
    return out


def phased_pairs(father: Sequence[Haplotype], mother: Sequence[Haplotype],
                 child: Optional[Genotype] = None,
                 loci: Optional[Sequence[str]] = None) -> set[tuple[Haplotype, Haplotype]]:
    """Every order-normalised child pair reachable by whole-haplotype transmission from
    *phased* parents: one of the father's two haplotypes with one of the mother's.
    With ``child`` (and ``loci``) given, only the pairs whose unphasing matches the
    child at every locus that is typed (``child[l]`` is not None) are kept — the
    ``impute_missing_locus`` oracle (§8.2)."""
    out: set[tuple[Haplotype, Haplotype]] = set()
    for f in father:
        for m in mother:
            if child is not None:
                ok = all(child[l] is None or sorted([f[i], m[i]]) == sorted(child[l])
                         for i, l in enumerate(loci))
                if not ok:
                    continue
            a, b = sorted((tuple(f), tuple(m)))
            out.add((a, b))
    return out


def pedigree_phasings(child: Genotype, father: Genotype, mother: Genotype,
                      grandparents: dict[str, Genotype],
                      loci: Sequence[str]) -> set[tuple[Haplotype, Haplotype]]:
    """The ``pedigree_phase`` oracle (§8.2): the union, over every Mendel-allowed phasing
    of each parent given *its* unphased parents, of the child pairs reachable by
    whole-haplotype transmission from those phased parents.  Unphased parents never
    constrain transmission; phased ones do, which is what the grandparents buy.

    ``grandparents`` is keyed ``paternal_grandfather``, ``paternal_grandmother``,
    ``maternal_grandfather``, ``maternal_grandmother``."""
    f_phasings = mendelian_phasings(father, grandparents["paternal_grandfather"],
                                    grandparents["paternal_grandmother"], loci)
    m_phasings = mendelian_phasings(mother, grandparents["maternal_grandfather"],
                                    grandparents["maternal_grandmother"], loci)
    out: set[tuple[Haplotype, Haplotype]] = set()
    for fp in f_phasings:
        for mp in m_phasings:
            out |= phased_pairs(fp, mp, child, loci)
    return out


# ---------------------------------------------------------------------------------- dataset
def generate_dataset(ref: ImgtReference, seed: int = BASE_SEED,
                     n_founders: int = DEFAULT_FOUNDERS, loci: Sequence[str] = DEFAULT_LOCI,
                     population: str = DEFAULT_POPULATION,
                     alleles_per_locus: int = DEFAULT_ALLELES_PER_LOCUS,
                     n_families: int = DEFAULT_FAMILIES, n_children: int = DEFAULT_CHILDREN,
                     grandparents: bool = False, allow_suffix: bool = False,
                     null_per_locus: int = 0, sibling_pairs_per_locus: int = 0) -> dict:
    """Pool + families as one JSON-serialisable record; ``dumps()`` it for a stable file."""
    pool = draw_founder_pool(ref, seed, n_founders, loci, population, alleles_per_locus, allow_suffix,
                             null_per_locus, sibling_pairs_per_locus)
    families = []
    for i in range(1, n_families + 1):
        fam_rng = _rng(seed, "family", ref.tag, population, i)
        families.append(simulate_family(pool, fam_rng, f"fam{i:04d}", n_children, grandparents))
    bad = [p for f in families for p in check_mendelian(f)]
    assert not bad, bad[:3]          # by construction; a failure here is a generator bug
    return {
        "family": FAMILY, "layer": LAYER, "generator_rev": GENERATOR_REV,
        "reference": {"db": "IPD-IMGT/HLA", "release": ref.release, "tag": ref.tag,
                      "md5": ref.manifest["md5"]["Allelelist.txt"]},
        "parameters": {"seed": seed, "founders": n_founders, "loci": list(pool.loci),
                       "population": population, "alleles_per_locus": alleles_per_locus,
                       "families": n_families, "children": n_children,
                       "grandparents": grandparents, "allow_suffix": allow_suffix,
                       "null_per_locus": null_per_locus,
                       "sibling_pairs_per_locus": sibling_pairs_per_locus,
                       "recombination": "none (v0: whole-haplotype transmission)"},
        "pool": pool.to_dict(),
        "families": [f.to_dict(pool.loci) for f in families],
        "counts": {"individuals": sum(len(f.members) for f in families),
                   "children": sum(1 for f in families for m in f.members if m.role == "child")},
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m sci_envs.families.phasing",
        description="Family B layer 1: seeded synthetic Mendelian truth from the pinned IPD-IMGT/HLA release.")
    p.add_argument("--tag", default=DEFAULT_TAG, help="pinned IPD-IMGT/HLA git tag")
    p.add_argument("--seed", type=int, default=BASE_SEED)
    p.add_argument("--founders", type=int, default=DEFAULT_FOUNDERS, help="founder haplotype pool size (§6 Q1)")
    p.add_argument("--loci", default=",".join(DEFAULT_LOCI), help="comma-separated, 2–5 of A,C,B,DRB1,DQB1 (§6 Q1)")
    p.add_argument("--population", default=DEFAULT_POPULATION, help="label for the synthetic population (§6 Q1)")
    p.add_argument("--alleles-per-locus", type=int, default=DEFAULT_ALLELES_PER_LOCUS)
    p.add_argument("--families", type=int, default=DEFAULT_FAMILIES)
    p.add_argument("--children", type=int, default=DEFAULT_CHILDREN)
    p.add_argument("--grandparents", action="store_true", help="three-generation families")
    p.add_argument("--allow-suffix", action="store_true", help="let N/L/S/C/A/Q alleles into the pool")
    p.add_argument("--null-per-locus", type=int, default=0,
                   help="relabel this many alleles per locus as null (N) alleles (§8.1)")
    p.add_argument("--sibling-pairs-per-locus", type=int, default=0,
                   help="relabel this many allele pairs per locus as two-field siblings (§8.1)")
    p.add_argument("--out", default="-", help="output path (default stdout)")
    a = p.parse_args(argv)
    ref = ImgtReference.load(a.tag)
    try:
        data = generate_dataset(ref, a.seed, a.founders, [l for l in a.loci.split(",") if l],
                                a.population, a.alleles_per_locus, a.families, a.children,
                                a.grandparents, a.allow_suffix, a.null_per_locus, a.sibling_pairs_per_locus)
    except PhasingError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    text = dumps(data) + "\n"
    if a.out == "-":
        sys.stdout.write(text)
    else:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
