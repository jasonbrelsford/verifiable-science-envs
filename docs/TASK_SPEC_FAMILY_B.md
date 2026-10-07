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
   *Implemented 2026-10-06 as `sci_envs/families/phasing/mendelian.py`
   (`python -m sci_envs.families.phasing`): seeded, byte-reproducible, founder pool
   drawn from the pinned release at full resolution, whole-haplotype transmission (no
   recombination in v0), two- or three-generation families, unphased genotype kept next
   to the phased truth. The §6 question-1 values are flags with the proposal as defaults
   (`--founders 40 --loci A,B,DRB1`, one population). The first graded slice on top of
   it — three subtypes, the §4 grader and the dev/test split — landed 2026-10-07; see §7.*
2. **Realism layer — open data only.** Founder pools and frequency weights may be
   informed by openly licensed resources (1000 Genomes-class HLA call sets; openly
   published frequency tables where the article's data terms permit reuse). These
   shape task distributions; they never become redistributed data files.
3. **Partner-held layer — restricted data stays with its holders.** Organizations
   holding registry licences can run population-realistic slices on their own
   infrastructure with their own data; the environment ships to the data. No data
   agreement with us is required — hello@hlaverify.com.

## 6. Open questions before implementation

1. Pool size and locus set for v0 (proposal: 40 founder haplotypes, 3 loci A–B–DRB1, one population; second population as a slice later).
2. Whether GRIMM runs in CI (dependency weight) or only in the release-validation workflow.
3. Whether `family_phase` belongs in B or starts family C (matching) — it shares machinery with donor–recipient logic.
4. External validated-haplotype lists (Zenodo-published, DOI-pinned) may back a `validated_haplotype` slice once their licence is confirmed.

## 7. Layer 2 decisions (2026-10-07)

*The design pass the §6 questions asked for, plus the smallest graded slice it unlocks.
Implemented in `sci_envs/families/phasing/tasks.py` (subtypes, suite) and
`sci_envs/families/phasing/grade.py` (grader); tests in `tests/test_family_b_tasks.py`.*

**Q1 — pool size and locus set: settled by PR #86's defaults.** 40 founder haplotypes,
loci A–B–DRB1, one synthetic population, 12 alleles per locus. They are flags on the
layer-1 generator, not constants, so a second population or a C/DQB1 extension is a flag
change plus a new `SUITE_REV`. The graded suite draws 60 two-generation families (120
children) from that pool under the suite seed.

**Q2 — GRIMM stays out of CI.** It is release-validation only. The three subtypes below
need no LD model and no frequency table: their truth is Mendelian and their oracle is an
exact enumeration over the parents' genotypes, so there is nothing for GRIMM to cross-check
yet. When the frequency-dependent subtypes arrive, GRIMM runs in the release-validation
workflow against the generating pool, never as a `pytest` dependency.

**Q3 — `family_phase` stays in family B for v0.** The layer-1 generator already emits the
parents' genotypes next to every child, so the subtype costs nothing here. Moving it to
family C (matching) is a later refactor if donor–recipient logic needs the same machinery.

**Q4 — validated-haplotype lists stay open.** It is a licence question; nothing in this
layer depends on it.

### 7.1 The subtypes built (no frequencies needed)

| Subtype | Tier | Input | Truth | Answer |
|---|---|---|---|---|
| `phase_trivial` | T1 | one individual, **two** loci, exactly one heterozygous | phased pair from the generator, projected onto the two loci | the pair |
| `consistency_check` | T1 | a child plus both parents' *unphased* genotypes, one locus made impossible | — | `UNRESOLVABLE` + `inconsistent_genotype` |
| `family_phase` | T4 | a child heterozygous at ≥ 2 loci plus both parents' *unphased* genotypes | phased pair from the generator | the pair |

The two family subtypes share one instruction text, so the agent is never told which it is
facing: it has to find the inconsistency. `consistency_check` is planted two ways, kept as
slices — `foreign_allele` (one allele replaced by a real pool allele at that locus that
neither parent carries) and `impossible_combination` (both alleles at one locus taken from
one heterozygous parent while the other parent carries neither). The planted name always
exists in the pinned release: the inconsistency is Mendelian, not nomenclature, so a
hallucination check cannot shortcut the task. Every input name is a current release name;
every genotype is sorted per locus so no position carries phase.

**The Mendel oracle.** `mendelian_phasings(child, father, mother, loci)` enumerates every
order-normalised haplotype pair Mendel allows from unphased parents: at each locus one
allele from the father's pair and one from the mother's. With unphased parents,
whole-haplotype transmission adds no further constraint, so per-locus assignment is the
whole rule. An empty set is `consistency_check`; exactly one member is `family_phase`;
the generator asserts that member equals the phased truth, so a disagreement between the
oracle and construction fails generation rather than shipping a wrong key. Task ids are
`hla_phasing.<SUITE_REV>.T<tier>.<subtype>.<seed>`; the dev/test split is keyed on the
task id as families A and C do it. The same `(tag, base_seed)` writes byte-identical
task files; the test suite checks this.

### 7.2 Grading as built (§4, determinate subtypes only)

Response envelope as family A (`answer`, `confidence`, `flags`, `reasoning`; JSON found
inside prose is accepted). `answer` is `{"haplotypes": [h1, h2]}` — each haplotype a list
in the task's `loci` order or an object keyed by locus (`HLA-` prefix and key case
forgiven) — or the sentinel `UNRESOLVABLE` (case-insensitive, like family A's sentinels).

- **Correct** = the order-normalised pair equals the truth pair exactly; nothing fuzzy.
  For `consistency_check`, correct = the sentinel.
- **`phase_flip`**: the pair reproduces the genotype but pairs the alleles wrongly.
- **`impossible_pair`**: the pair does not reproduce the genotype (an allele the
  individual does not carry) — the fabrication analogue. A fabricated name in the answer
  is additionally `hallucinated_answer`, which outranks it.
- **`refused`**: `UNRESOLVABLE` where a phase existed. A blanket `UNRESOLVABLE` therefore
  scores exactly the `consistency_check` third of the suite and is `refused` on every
  other task — the same penalty family A applies to refusal spam.
- A pair returned for an inconsistent genotype is wrong with `missed_ambiguity`; it is not
  a `phase_flip` (there is no right pairing to flip).
- Wrong locus count or haplotype count, a non-pair non-sentinel answer, or an unparseable
  envelope: `malformed_response`.
- Calibration, flag vocabulary (`phase_ambiguous`, `rare_haplotype`,
  `inconsistent_genotype`, `low_resolution_input`; unknown strings ignored),
  under-confidence tolerated, and the hallucination check over answer + reasoning are
  family A's rules verbatim. `expected_confidence` is `high` for all three subtypes: every
  answer is forced.
- Primary-mode precedence: `malformed_response` > `hallucinated_answer` >
  `impossible_pair` > `phase_flip` > `wrong_but_overconfident` > `wrong_calibrated` >
  `refused` > `correct_but_overconfident` > `correct_with_hallucinated_reasoning` >
  `missed_ambiguity` > `false_positive_flag` > `clean_correct`.
- **Oracle gate** (as family A §5): the phased truth read straight from the generator
  must grade `correct`, `calibrated`, `failure_modes == ["clean_correct"]` on every task.

### 7.3 Not in this layer

`phase_from_ld`, `impute_missing_locus`, `phase_ambiguous`, `rare_haplotype`,
`resolution_lift`, `null_in_haplotype` (all need the realism layer or a frequency model),
the probabilistic grading rules of §4 (ranked lists, tolerance bands, Brier, the
probability-sum check), `common_default`, the harness/CLI wiring (`hla-bench generate
--family b`), GRIMM validation, and any registry or partner data.
