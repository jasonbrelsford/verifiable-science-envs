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
--family b`), GRIMM validation, and any registry or partner data. *Revisited in §8.4:
four of these become frequency-free slices in layer 3.*

## 8. Layer 3 decisions (2026-10-15)

*The design pass board item (c).3 asked for (issue #120): the next graded slice, scoped
so an agent can build it, and the line it does not cross. Docs only — the generator and
grader work get their own issue once this is on `main`. The supply numbers in 8.5 were
measured on the merged layer-1 generator at IPD-IMGT/HLA 3.66.0 under the suite seed;
they are the evidence behind the task counts, not a promise about a later release.*

### 8.1 The §6 questions, revisited

**Q1 — pool and locus set: unchanged; purpose-built pool parameters, not a bigger pool.**
Layer 3 keeps 40 founders, A–B–DRB1, 12 alleles per locus, one synthetic population. Two
subtypes need something the default pool does not contain and get it from a new pool
*parameter*, not a different population: `null_per_locus` (k of the 12 alleles at each
locus are N-suffixed names from the pinned release; the existing `--allow-suffix` draws
suffixes at random, Q and L included, and cannot promise one) for `null_in_haplotype`,
and `sibling_pairs_per_locus` (p pairs of full-resolution names that share one two-field
prefix) for `resolution_lift`. Both are post-draw substitutions on the default pool under
their own seeded streams, so the default pool's bytes do not change and the new
parameters are flags with zero as the default, as Q1's others are. A fourth or fifth
locus (C, DQB1) and a second population are deferred to the frequency layer: without an
LD model an extra locus only adds per-locus Mendel bookkeeping, and a second population
only means something once populations differ in frequencies.

**Q2 — GRIMM still stays out of CI, and now has a definite entry point.** Every layer-3
oracle is again an exact enumeration — over unphased parents, over phased parents, or
over a three-generation pedigree — so there is still nothing for an LD imputer to
cross-check. GRIMM enters with the first frequency-dependent subtype (`phase_from_ld`,
8.4), in the release-validation workflow only, run against the generating pool; it is
never a `pytest` dependency.

**Q3 — family reasoning stays in B.** `family_phase` stays and `pedigree_phase` (8.2)
joins it. The machinery family C might share is the Mendel enumeration, and until a
donor–recipient rule needs it, moving it is a refactor with no customer.

**Q4 — validated-haplotype lists: still deferred, and bounded.** The licence is
unconfirmed, nothing in layer 3 depends on it, and once it is confirmed the lists shape
founder pools (§5 layer 2) and never become shipped files. Nothing in this layer, or any
later one, reads NMDP frequency tables or anything behind a click-through licence
(§2, §7.3): every graded number in layer 3 still derives from construction.

### 8.2 The subtypes to build (determinate without frequencies)

| Subtype | Tier | Input | Truth | Answer |
|---|---|---|---|---|
| `impute_missing_locus` (slice `family_determinate`) | T2 | a child typed at two of the three loci (`genotype[X]` is `null`), plus both parents' **phased** haplotypes under `relatives` — "established by a prior family study" | the child's phased pair from the generator, all three loci | the pair with the untyped locus filled in |
| `resolution_lift` (slice `family_determinate`) | T3 | a child typed at **two fields**; both parents' *unphased* genotypes at the pool's full resolution | the child's phased pair at full resolution | the pair at full resolution + `low_resolution_input` |
| `phase_ambiguous` (slice `mendelian_set`) | T3 | a child plus both parents' *unphased* genotypes, where Mendel allows **exactly two** pairs | the set of both pairs | a `ranked` list of both + `phase_ambiguous` |
| `pedigree_phase` | T4 | a child, both parents and all four grandparents, all *unphased*; the parents alone leave ≥ 2 pairs, the pedigree leaves one | the child's phased pair | the pair |
| `null_in_haplotype` | T4 | the `family_phase` shape, drawn from the null-quota pool; slices `carried` (the child's truth pair holds ≥ 1 N allele) and `decoy` (an N allele sits in a parent and was not transmitted) | the child's phased pair | the pair + `null_allele` on `carried`, no flag on `decoy` |

`pedigree_phase` is new to §3; the rest are §3 subtypes with the frequency-free case
carved out as a named slice, so the frequency-dependent case can land later under the same
subtype name without renaming anything. Tiers follow §3, except that `pedigree_phase` sits
with `family_phase` at T4. §7.1's rules carry over: every genotype is sorted per locus,
nothing is announced, and the Mendel-shaped subtypes share one instruction text so the
agent has to find out for itself whether the answer is one pair, two pairs or the
sentinel.

**Determinacy filters, and the oracle behind each.**

- `impute_missing_locus`: enumerate `(f, m)` over the father's two haplotypes × the
  mother's two; keep the pairs whose unphasing matches the child at both typed loci;
  exactly one (as an order-normalised set) makes the task. Excluded as trivial: both
  parents homozygous at the untyped locus. Over the layer-1 dataset nearly every child
  qualifies at some locus, so the generator rotates the untyped locus to balance the three.
- `resolution_lift`: the child's names are truncated to two fields (the
  `low_resolution_input` the §1 flag was written for); the oracle runs
  `mendelian_phasings` over the parents' full-resolution alleles whose two-field form
  matches the child's two-field pair at that locus; exactly one pair makes the task, and
  it must be **non-trivial**: at some locus the child's two-field name covers ≥ 2 distinct
  full-resolution parental alleles, so the lift is a Mendel deduction, not a lookup. The
  ambiguous remainder is a `phase_ambiguous` slice for a later layer (8.4), not discarded
  in principle.
- `phase_ambiguous` (`mendelian_set`): `mendelian_phasings` returns exactly two pairs.
  Three cannot happen (per-locus option counts are 1 or 2, and order-normalisation merges
  pairs by whole products), and four is excluded by §1's cap of three.
- `pedigree_phase`: `pedigree_phasings(child, father, mother, grandparents)` = the union,
  over every Mendel-allowed phasing of each parent given *its* parents, of the child pairs
  reachable by whole-haplotype transmission from those phased parents. The task needs
  `len(mendelian_phasings(child, father, mother)) ≥ 2` and `len(pedigree) == 1`, so the
  grandparents are necessary, not decoration. (Unphased parents never constrain
  transmission — §7.1 — but phased ones do, which is the whole point of the subtype.)
- `null_in_haplotype`: the `family_phase` filter (heterozygous at ≥ 2 loci, exactly one
  Mendel pair) on the null-quota dataset, then `carried` if the child's pair holds an
  N allele, `decoy` if only a parent does; roughly two `carried` to one `decoy`.

As in §7.1, the generator asserts that the construction truth is in (and, for determinate
subtypes, is) the oracle's set; a disagreement fails generation. `consistency_check` does
not get a pedigree slice in this layer: the planted inconsistency is already Mendelian
and a grandparent plant would only move it one generation up.

**Envelope changes (the §1 contract made concrete).**

- `answer` gains a second form, `{"ranked": [{"haplotypes": h, "probability": p}, …]}`,
  one to three entries, `probability` optional in this layer. A one-entry `ranked` is
  graded as a pair. `{"haplotypes": …}` and the sentinel stay exactly as in §7.2.
- `input.genotype[X]` may be `null` (`impute_missing_locus` only; the instructions say so).
- `input.relatives.<who>` is either an unphased genotype (as today) or
  `{"haplotypes": [h1, h2]}` (`impute_missing_locus` only); the shape, not a label, says
  which. `pedigree_phase` adds `paternal_grandfather`, `paternal_grandmother`,
  `maternal_grandfather`, `maternal_grandmother` next to `father` and `mother`.
- The flag vocabulary grows by one, `null_allele`, borrowed verbatim from family A
  (`GRADER_SPEC.md` §3.3); §1's four stay. Unknown strings are still ignored.
- Input names: every name is still a current release name, except in `resolution_lift`,
  where the individual's names are two-field truncations of release names (the layer-2
  test invariant is loosened for exactly that subtype).

### 8.3 Grading additions (§4 style; everything in §7.2 stands)

- **Correct** is still exact, order-normalised equality with the truth — for
  `phase_ambiguous`, equality of the *set* of pairs with the truth set, list order
  irrelevant; for `resolution_lift`, at full resolution; for `impute_missing_locus`, at all
  three loci.
- `impossible_pair` widens to cover the new inputs: a pair that does not reproduce the
  genotype at the typed loci, or, after truncation to the input's field count, the
  two-field genotype; or that carries, at the untyped locus or at any lifted locus, an
  allele neither parent carries there. The fabrication analogue, as before.
- **`resolution_not_lifted`** (new): the pair reproduces the two-field input and every
  name is still at two fields — the phase may be right, the lift was not attempted.
- **`wrong_lift`** (new): parental, consistent with the two-field input, not the pair
  Mendel forces, and not a `phase_flip` (the name multiset differs from the truth's).
- **`wrong_imputation`** (new): the typed loci are exactly right, names and pairing, and
  the untyped locus is wrong — the phasing worked, the imputation did not.
- **`hedged_answer`** (new): a `ranked` list of two or three on a single-pair task that
  contains the truth. More than three entries is `malformed_response`. On a
  `phase_ambiguous` task a list whose members all reproduce the genotype but is not the
  truth set is `phase_flip`; a member that does not reproduce the genotype is
  `impossible_pair`; a single pair, even one of the two, is wrong — §3's "a single
  confident pair is `wrong_but_overconfident`" — and `missed_ambiguity` if the flag is
  absent.
- **Probabilities**: if present, each in [0, 1] and the sum ≤ 1 + ε (ε = 0.01), else
  `malformed_response` — §4's sum rule built now. Values are **not graded** in this
  layer: the agent cannot know the synthetic pool's prior, so a tolerance band against the
  pool's posterior would grade knowledge it cannot have. Bands and Brier arrive with the
  frequency layer (8.4), when the prior is something an agent can in principle hold.
- `refused`, `phase_flip`, the calibration rule, the hallucination check and the soft
  flags are §7.2's verbatim. `expected_confidence` is `high` for every layer-3 subtype:
  each answer, set or pair, is forced.
- Precedence: `malformed_response` > `hallucinated_answer` > `impossible_pair` >
  `phase_flip` > `resolution_not_lifted` > `wrong_lift` > `wrong_imputation` >
  `hedged_answer` > `wrong_but_overconfident` > `wrong_calibrated` > `refused` >
  `correct_but_overconfident` > `correct_with_hallucinated_reasoning` >
  `missed_ambiguity` > `false_positive_flag` > `clean_correct`.
- **Oracle gate** unchanged: `oracle_response` emits the `ranked` form for set tasks and
  the expected flags, and must grade `clean_correct` on every task. `GRADER_VERSION`
  becomes `B-0.2`; `summarize()` and the report tooling are untouched (new modes are
  strings in the same column).

### 8.4 §7.3 revisited: what layer 3 unlocks, what stays out

**Unlocked, as frequency-free slices:** `impute_missing_locus`, `resolution_lift`,
`phase_ambiguous`, `null_in_haplotype` (8.2); the `ranked` envelope and the
probability-sum check (8.3); the harness/CLI wiring, `hla-bench generate --family b`
(8.5). Three of §1's four flags get tasks on which they are *expected* — until now
`phase_ambiguous` and `low_resolution_input` could only ever be `false_positive_flag`.

**Still out, with the reason:**

- `phase_from_ld` and `rare_haplotype` — need an LD model and a frequency prior the agent
  can hold; nothing Mendelian stands in for them.
- `common_default` — "answered the population mode" presupposes a population mode.
- Tolerance bands, Brier and graded probabilities — same reason (8.3).
- Unrelated-individual imputation and lift (no relatives) — those are the frequency
  versions of two subtypes above and wait for them.
- `phase_ambiguous` as §3 wrote it (posterior split under 0.6) — the `mendelian_set`
  slice covers the *set* semantics; the probabilistic case follows the frequency layer.
- GRIMM validation (Q2), recombination (§2), registry and partner data (§5 layer 3).

### 8.5 Counts, datasets, seed and regeneration

**Counts.** 30 per subtype, as §7.1: five new subtypes, 150 tasks, 240 in the suite after
the existing 90; dev ≈ 48 at the 20 % rate. The supply measured at 3.66.0 under the suite
seed is the margin behind each 30, and the generator keeps §7.1's guard — fewer distinct
eligible individuals than the count fails generation rather than shipping a thin subtype.

| Subtype | Dataset | Eligible individuals measured (3.66.0, suite seed) |
|---|---|---|
| `phase_trivial`, `consistency_check`, `family_phase` | D-main: 300 two-generation families (600 children), default pool | `family_phase`-eligible 488 of 600 |
| `phase_ambiguous` | D-main | exactly two Mendel pairs: 39 (560 children have one, 1 has four) |
| `impute_missing_locus` | D-main | ≥ 1 non-trivial determinate untyped locus: 590 |
| `pedigree_phase` | D-ped: 600 three-generation families (1,200 children), default pool | parents alone ≥ 2 pairs and pedigree exactly 1: 87 (53 at 400 families) |
| `null_in_haplotype` | D-null: 300 two-generation families, `null_per_locus = 2` | emulated by relabelling two slots per locus on a 250-family draw, five slot draws: `carried` 111–251, `decoy` 82–111 of the `family_phase`-eligible |
| `resolution_lift` | D-lift: 300 two-generation families, `sibling_pairs_per_locus = 3` | emulated the same way: determinate with a non-trivial lift 53–91; ambiguous lift 99–243 (left for a later slice); 2 pairs per locus gave as few as 11, 4 gave as few as 38 |

`phase_ambiguous` is the thin one: a rate of 6–12 % of children, so D-main is 300
families (it was 60 in layer 2), and the generator selects by enumerating the eligible
list in seeded order rather than rejection-sampling, so yield equals supply. All four
datasets generate in seconds; the release has 150–510 N alleles and 210–460 two-field
prefixes with ≥ 2 full-resolution siblings per locus, so neither quota is near the supply.

**Datasets and revisions.** D-main replaces the 60-family dataset the three layer-2
subtypes drew from, so their content changes once, in this layer. That is acceptable
because no family B results have been published (`bench/HLA-Bench-B.md` does not exist
and `runs/hla-bench-b/` has never been generated). `GENERATOR_REV` → `B1-r2` (the
`parameters` block gains the two pool parameters; default-pool bytes are otherwise
unchanged), `SUITE_REV` → `B3-r1`.

**Split key.** The dev/test split moves from the task id to the id *without* its revision
segment (`hla_phasing.T<tier>.<subtype>.<seed>`), which is what family A hashes. Layer 2
copied family C, whose ids carry the rev, so every rev bump reshuffled dev and test and a
dev task could resurface as a test task with identical content. From B3 on, a rev bump
that leaves a task's content unchanged leaves its split unchanged.

**Per release.** Nothing changes in principle from §2 and layer 1: the pool stream is
keyed on `(seed, tag, population, …)`, so a new IPD-IMGT/HLA tag redraws every pool,
every family and every task — the contamination property — and the manifest's
benchmark string carries the release (`HLA-Bench-B-v0.1@IMGT-<release>`). The sealed
split regenerates on any machine from `(tag, base_seed)` alone, byte-identical, with no
data file to ship; it never leaves the machine (`runs/*/full/` is gitignored), and the
dev split (`runs/hla-bench-b/dev/*.agent.json`, `manifest.json`) is committed, exactly
as A and C. A release bump is a new benchmark revision with no published results, which
`RELEASE_BUMP.md` §4 already makes Jason's call, separate from the quarterly API bump;
the supply table above is re-measured on each bump because the pool is redrawn, and
a subtype whose supply falls under its count fails loudly at generation (the guard).

**Harness wiring, in this layer.** `hla-bench generate --family b` (`runs/hla-bench-b`),
and `run`/`auto` dispatch the grader on the task's `family` field instead of importing
family A's; `report` reads the manifest's family as it does for C. The response cache is
keyed on task ids, so the B3 ids are a fresh cache.

**What the generator issue has to do, in one list:** the two pool parameters and
`pedigree_phasings`/`phased_pairs` in `mendelian.py`; five generators, the `ranked`
form, the two new input shapes and the shared instruction texts in `tasks.py`; the modes,
flag and probability rule of 8.3 in `grade.py`; the split key; `oracle_response` for set
tasks; tests for every determinacy filter, every new mode, the loosened name invariant
and the oracle gate at 100 %; the harness flag and dispatch; README/HANDOFF lines.
