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

No grading, no subtypes, no bench split here — those are the next sub-steps.
"""
from __future__ import annotations

import argparse
import hashlib
import random
import sys
from dataclasses import dataclass, field
from typing import Optional, Sequence

from sci_envs.reference.imgt import ImgtReference, split_allele
from sci_envs.families.nomenclature.task import dumps

FAMILY = "hla_phasing"
LAYER = "synthetic_mendelian_truth"
GENERATOR_REV = "B1-r1"      # bump on any change that alters output for a fixed seed
BASE_SEED = 20260831

# TASK_SPEC_FAMILY_B §6 question 1 — the proposal, as defaults.  Change the flag, not the code.
DEFAULT_FOUNDERS = 40
DEFAULT_LOCI = ("A", "B", "DRB1")
DEFAULT_POPULATION = "synthetic-pop-1"
DEFAULT_ALLELES_PER_LOCUS = 12
DEFAULT_FAMILIES = 20
DEFAULT_CHILDREN = 2
DEFAULT_TAG = "v3.65.0-alpha"

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
                      allow_suffix: bool = False) -> FounderPool:
    """Draw ``n_founders`` distinct phased haplotypes over ``loci`` from the pinned release.

    Each locus contributes ``alleles_per_locus`` distinct alleles with skewed per-locus
    weights; haplotypes are combinations drawn under those weights (so alleles recur
    across haplotypes and phase is not trivially forced), de-duplicated, then given
    skewed frequencies.  The pool is small by design: §2 needs posteriors computed by
    exact enumeration over it.
    """
    loci = normalize_loci(loci)
    if n_founders < 2:
        raise PhasingError("a founder pool needs at least 2 haplotypes")
    if alleles_per_locus < 2:
        raise PhasingError("need at least 2 alleles per locus")
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
    return FounderPool(loci=loci, population=population, haplotypes=haps, frequencies=freqs,
                       alleles_by_locus={l: sorted(a) for l, a in alleles_by_locus.items()})


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


# ---------------------------------------------------------------------------------- dataset
def generate_dataset(ref: ImgtReference, seed: int = BASE_SEED,
                     n_founders: int = DEFAULT_FOUNDERS, loci: Sequence[str] = DEFAULT_LOCI,
                     population: str = DEFAULT_POPULATION,
                     alleles_per_locus: int = DEFAULT_ALLELES_PER_LOCUS,
                     n_families: int = DEFAULT_FAMILIES, n_children: int = DEFAULT_CHILDREN,
                     grandparents: bool = False, allow_suffix: bool = False) -> dict:
    """Pool + families as one JSON-serialisable record; ``dumps()`` it for a stable file."""
    pool = draw_founder_pool(ref, seed, n_founders, loci, population, alleles_per_locus, allow_suffix)
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
    p.add_argument("--out", default="-", help="output path (default stdout)")
    a = p.parse_args(argv)
    ref = ImgtReference.load(a.tag)
    try:
        data = generate_dataset(ref, a.seed, a.founders, [l for l in a.loci.split(",") if l],
                                a.population, a.alleles_per_locus, a.families, a.children,
                                a.grandparents, a.allow_suffix)
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
