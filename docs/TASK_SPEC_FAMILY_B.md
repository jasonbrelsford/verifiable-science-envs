# TASK_SPEC — Family B: haplotype phasing & imputation (v0.1 draft, 2026-08-31)

*Companion to `TASK_SPEC.md` (family A). Status: draft for review; implementation follows the same rungs (spec → generators → grader → oracle 100% → harness rows). NSF Objective 1 and PRODUCT.md roadmap item 3 point here.*

## 1. What the agent gets and must return

**Input:** an unphased multi-locus HLA genotype (2 alleles per locus at 2–5 loci among A, C, B, DRB1, DQB1; resolution varies per task — 2-field, G group, or an ambiguity string), plus a population label, plus the pinned release.

**Output (JSON contract, as family A):** the two haplotypes as ordered locus lists, a probability (or rank list of up to 3 haplotype pairs with probabilities), `confidence`, and `flags` (`phase_ambiguous`, `rare_haplotype`, `inconsistent_genotype`, `low_resolution_input`).

## 2. Ground truth without redistributing licensed data (the design that matters)

NMDP haplotype frequency tables are click-through licensed; we never ship them. Truth is generated, not licensed:

1. **Synthetic population**: define a compact founder haplotype pool with explicit frequencies (drawn to mimic realistic LD structure — parameters public, values ours), or, where a licence permits server-side use, real frequencies stay server-side only.
2. **Mendelian simulation** (the `segregation.py` approach from the inventory): simulate families — founder haplotype pairs → gametes (no recombination within the HLA block for v0; recombination as a later slice) → children. Phase is known *by construction*.
3. A task presents the child's (or unrelated individual's) unphased genotype; the answer key holds the true phase and, for imputation tasks, the posterior over pairs computed exactly from the generating pool by enumeration (pools are small enough that the posterior is exact, not approximated).
4. **Oracle**: GRIMM/py-graph-imputation (LGPL) run over the same generating pool must reproduce the enumerated posterior — a cross-check between two independent implementations, giving the "oracle passes 100%" bar.

Contamination resistance: pools are re-drawn per release with the generation seed, and any allele added after the model-cutoff release can be planted in founder haplotypes (post-cutoff slice, as family A).

## 3. Subtypes (draft, 4 tiers ~ family A's shape)

- T1 `phase_trivial` — two loci, one heterozygous; phase is forced. Tests representation, not inference.
- T1 `consistency_check` — genotype inconsistent with any pair in the pool (planted typo / impossible combination) → `inconsistent_genotype`.
- T2 `phase_from_ld` — 3–5 loci where LD makes one phasing dominant (posterior > 0.9); answer = the pair.
- T2 `impute_missing_locus` — one locus untyped; return most probable allele pair for it with probability.
- T3 `phase_ambiguous` — posterior mass split (< 0.6 top pair); correct answer is the ranked list with calibrated probabilities; a single confident pair is `wrong_but_overconfident`.
- T3 `resolution_lift` — input at antigen/2-field level, pool at 4-field; answer at the pool's resolution with the lift made explicit.
- T4 `rare_haplotype` — true pair includes a low-frequency haplotype; tests whether the model defaults to the common answer (the clinically dangerous prior).
- T4 `family_phase` — parents' genotypes given too; phase decidable by Mendelian logic alone even when LD is misleading (tests reasoning over recall).
- T4 `null_in_haplotype` — null allele inside a haplotype changes the effective match; flag must fire.

## 4. Grading

Exact match on the pair (order-normalized) for determinate subtypes. For probabilistic subtypes: top-pair match + probability within a tolerance band (band width set from the pool's enumeration, published per task; target ±0.05 for v0), plus a proper-scoring slice (Brier) reported per model. Failure taxonomy extends family A's with `phase_flip` (right alleles, wrong pairing), `common_default` (answered the population mode instead of the evidence), `impossible_pair` (haplotype not in the pool and not constructible — the fabrication analogue). Anti-reward-hacking: blanket `UNRESOLVABLE` and blanket "ranked list of everything" are penalized exactly as family A penalizes refusal spam; probability sums must be ≤ 1 + ε or `malformed_response`.

## 5. Data hierarchy (decided 2026-08-31)

Registry haplotype-frequency data (NMDP and similar) is licensed to only a few
organizations and is NOT assumed anywhere in this family. Three layers, in order:

1. **Graded core — synthetic Mendelian truth (no external data).** Phased founder
   haplotypes generated from the pinned IPD-IMGT/HLA release, inherited under
   Mendel's rules, unphased into tasks. Ground truth is known by construction;
   every graded number derives from it. This layer alone is the benchmark.
2. **Realism layer — open data only.** Founder pools and frequency weights may be
   informed by openly licensed resources (1000 Genomes-class HLA call sets; openly
   published frequency tables where the article's data terms permit reuse). These
   shape task distributions; they never become redistributed data files.
3. **Partner-held layer — restricted data stays with its holders.** Organizations
   holding registry licences can run population-realistic slices on their own
   infrastructure with their own data; the environment ships to the data. No data
   agreement with us is required. See docs/DATA_STRATEGY.md.

## 6. Open questions before implementation

1. Pool size and locus set for v0 (proposal: 40 founder haplotypes, 3 loci A–B–DRB1, one population; second population as a slice later).
2. Whether GRIMM runs in CI (dependency weight) or only in the release-validation workflow.
3. Whether `family_phase` belongs in B or starts family C (matching) — it shares machinery with donor–recipient logic.
4. External validated-haplotype lists (Zenodo-published, DOI-pinned) may back a `validated_haplotype` slice once their licence is confirmed.
