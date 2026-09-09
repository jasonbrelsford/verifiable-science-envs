# HLA-Bench: contamination-resistant, executable-oracle evaluation of language models on clinical immunogenetics

*DRAFT v0.1 (2026-08-31) — internal working draft for the bioRxiv preprint.
Author: Jason Brelsford (Brelsford Software LLC). Numbers below are from the
committed results in `bench/`; every figure will be regenerated with provenance
before submission.*

## Abstract (draft)

Large language models are entering clinical genomics workflows, but no benchmark
measures whether they handle the field's foundational layer: HLA nomenclature and
donor–recipient histocompatibility assessment, where a fabricated allele name or a
miscounted match is a patient-safety error. We present HLA-Bench, two evaluation
suites — 550 nomenclature tasks (family A) and 205 donor–recipient matching pairs
(family C) — in which every answer is computed by an executable oracle from the
pinned IPD-IMGT/HLA release itself: no human labels, no LLM judges, no licensed
data. Because ground truth regenerates deterministically from each quarterly
database release, a versioned share of tasks is post-training-cutoff by
construction, giving contamination resistance that static benchmarks cannot offer.
Across seven open-weight models (3B–14B) and one frontier model, accuracy on
nomenclature ranged from 15% to 34.7% against a 28% naive string-manipulation
baseline, and **every model family tested scored 0% on two-field ambiguity
expansion** — the core clinical trap that a two-field name denotes many
full-resolution alleles. On matching, string manipulation collapses to 0% and the
best tested open model reached 6.3%, systematically counting matched loci instead
of chromosomes and never flagging unresolvable typing. Models fabricated allele
names at 0.05–0.14 per task. A GRPO fine-tune on a disjoint generated split
[RESULTS PENDING] demonstrates the suites function as training environments, not
only evaluations. All generators, graders, and the verification service are open
source; the scored split remains sealed and regenerates every release.

## 1. Introduction

- AI assistance is reaching clinical genomics: agentic "AI workbench" products now
  ship genomics database connectors and multi-agent pipelines. Their built-in
  reviewers check citations and arithmetic — none holds allele-level ground truth.
- HLA is uniquely suited to deterministic evaluation: the field's single
  authoritative, versioned, machine-readable source of truth (IPD-IMGT/HLA;
  46,652 named alleles at release 3.65.0; 288 deleted names; quarterly releases)
  makes correctness computable rather than adjudicated.
- The stakes are concrete: a nomenclature error propagates into registry searches
  and match assessments; the classic traps (null alleles inside apparent
  serologic matches; legacy-era typings; resolution-insufficient reports read as
  confident counts) are exactly where clerical-style AI errors become clinical
  ones.
- Contributions: (i) two executable-oracle suites with tiered difficulty and
  audited failure taxonomies; (ii) a contamination-resistance design that keys
  ground truth to database releases; (iii) results for seven models with
  stratified wrong-answer audits; (iv) an open verification service (HLA-Verify)
  exposing the graders as a runtime guard; (v) external validation: 99.3% concordance with NMDP's py-ard on the
  overlapping reduction slice, with all divergences triaged; (vi) [pending]
  a training-environment demonstration via GRPO on a disjoint split.

## 2. Related work

- **LLM genomics benchmarks.** GeneTuring: 16 tasks / 1,600 curated questions,
  48,000 answers evaluated manually (Shang et al., Brief Bioinform 2025,
  doi:10.1093/bib/bbaf492) — curated QA with static keys, no immunogenetics.
  LAB-Bench (Laurent et al., arXiv:2407.10362) and BixBench (arXiv:2503.00096)
  cover biology research and computational-biology agent tasks. GAME
  (doi:10.1101/2025.07.04.663250) standardizes benchmarking of genomic
  sequence-to-activity models — a different model class.
- **LLMs vs deterministic tools.** Reese et al. (doi:10.1101/2024.07.22.24310816)
  benchmark seven LLMs against Exomiser on 5,213 rare-disease cases: best LLM
  23.6% top-1 vs 35.5% for the deterministic tool — converging evidence that
  LLMs trail executable domain logic; our design makes the executable logic the
  grader rather than the competitor.
- **Public-data validation in HLA methodology.** Multi-ethnic HLA imputation
  reference panels are routinely built and validated on 1000 Genomes-class open
  data (Degenhardt et al., doi:10.1093/hmg/ddy443; Silva et al.,
  doi:10.1111/tan.15543; Barbosa et al., doi:10.1016/j.humimm.2026.111700). We
  follow this established public-data pattern and extend it from imputation
  models to language-model evaluation.
- **HLA reduction tooling.** py-ard (NMDP's ARD-reduction library) is the
  field-standard normalizer for *valid* typing inside matching pipelines. Our
  concordance study (docs/pyard-concordance.md; 2,000-allele deterministic
  sample) finds 99.3% agreement on the overlap slice; all divergences fall into
  two documented semantic families (group-vs-allele suffix handling; ARD
  rollups). Critically, on AI-generated input the two tools answer different
  questions: given the fabricated `DQB1*05:03:26:99`, py-ard reduces it to a
  plausible `DQB1*05:03`, while a verifier must instead classify it as
  fabricated — reduction and verification are different jobs, and evaluating
  models requires the latter.
- **Gap.** No prior benchmark combines clinical immunogenetics content,
  LLM/agent evaluation, executable-oracle grading, and release-keyed
  regeneration of ground truth.

## 3. Benchmark design

### 3.1 Executable oracle

Every task's answer is computed from the pinned release's own files (Allelelist,
Deleted_alleles, WMDA rel_dna_ser / rel_ser_ser, nomenclature history) by rules
documented for audit (normalization rules; matching rules R1–R6). The oracle
scores 100% by construction; a grader change is only ever made with a failing
test written first. No human annotation, no LLM-as-judge.

### 3.2 Contamination resistance

Suites regenerate deterministically from (release tag, seed). 32.7% of tier-3/4
allele tasks in family A involve database facts newer than an assumed model
training cutoff (release 3.58.0); this share refreshes every quarterly release.
Task identifiers embed a suite revision; sealed scored splits (438/550 and
162/205 tasks) never leave the grading machines, while dev splits are public.

### 3.3 Family A — nomenclature (550 tasks, 20 subtypes, 4 tiers)

Truncation with expression-suffix rules, validity, G/P group assignment,
serologic equivalents, rename/deletion history, ambiguity expansion,
typing-report normalization, near-miss discrimination, release drift. Object
answers graded exactly; every emitted allele-shaped token checked against the
release (fabrication detection); confidence and flags graded for calibration.

### 3.4 Family C — donor–recipient matching (205 pairs, 8 subtypes)

Frameworks 6/6 through 12/12 and antigen-level; mixed typing eras and
resolutions. Rules R1–R6 encode: normalize-then-compare (deleted names chased to
successors), per-chromosome multiset counting, WMDA-column antigen assignment
with null handling ('0' and suffix N express no antigen), GvH/HvG
directionality, and the R6 principle that unresolvable typing yields a
`potential` verdict excluded from the denominator — a confident count over
unresolvable typing is itself the graded error.

### 3.5 Harness

Local open-weight models via Ollama (temperature 0, JSON-forced); hosted models
via vendor APIs with a bare-JSON clamp (strict system prompt; Anthropic
prefilled-`{` continuation; OpenAI json_object; Gemini JSON MIME) recorded as
`prompt_rev` in results. Wilson 95% CIs throughout. A stratified wrong-answer
sample (≤3 per subtype) is committed per run so failure shapes are auditable
without exposing the sealed split.

## 4. Results

### 4.1 Family A (all 550)

| Model | Acc [95% CI] | Fabricated-name tasks | Notes |
|---|---:|---:|---|
| oracle | 100% | 0 | validates harness |
| claude-sonnet-4-6 | 34.7%* | — | *600-token truncation on 187 tasks; clean 1600-token re-run pending |
| qwen2.5:7b | 31% [27–35] | 47 | perfect null_trap; 0% expand_ambiguity |
| mistral:7b | 29% [26–33] | 76 | truncation changes digits (B*15:504→B*15:01) |
| naive-string baseline | 28% | 0 | |
| qwen2.5:3b | 28% [24–32] | 27 | most cautious; best calibration |
| qwen2.5:14b | 26% [23–30] | 39 | refuses 120/550 (22%); 33% on answered; 90% null_trap, 80% near_miss; 0% expand_ambiguity |
| phi4-mini | 24% [21–28] | 35 | |
| llama3.1:8b | 21% [18–25] | 43 | worst calibration (402/550 wrong-overconfident) |
| llama3.2:3b | 15% [12–18] | 57 | below the string baseline |
| cautious-abstainer | 4% | 0 | refusal floor |

Key findings: (1) universal 0% on `expand_ambiguity` across Claude, Qwen,
Mistral, Llama, and Phi, at every scale from 3B to 14B — no tested model knows
a 2-field name covers 2–389 full-resolution alleles; (2) a 3B model scores
below string manipulation, and so does a 14B model: qwen2.5:14b refuses 22% of
tasks outright and, on the tasks it answers, matches rather than beats its 7B
sibling (33% vs 31%) — added parameters buy caution on the traps it recognises
(null alleles, near-misses) but no nomenclature knowledge;
(3) fabrication is universal and takes characteristic forms (invented 4th
fields, legacy colon-less strings, invented G/P group names); (4) reasoning-mode
models under forced-JSON burn their entire budget thinking (deepseek-r1:8b,
excluded; harness finding).

### 4.2 Family C (all 205)

| Model | Acc [95% CI] |
|---|---:|
| oracle | 100% |
| qwen2.5:7b | 6.3% [3.7–10.6] |
| naive-string baseline | 0% [0–1.8] |
| cautious-abstainer | 0% [0–1.8] |

Unlike nomenclature, matching admits no string shortcut: both baselines collapse
to zero. qwen2.5:7b succeeds only on tier-1 counting (22%); 0% on antigen-vs-
allele, null traps, directionality, framework shifts, and resolution-
insufficient cases. Hand-audit of the stratified wrong sample shows two dominant
error modes: counting matched **loci** instead of chromosomes ("4/8" when four
loci match), and self-contradiction (all-match per-locus verdicts beside a 5/10
count). The model never emitted a `potential` verdict — the clinically dangerous
confident-count behaviour the suite was built to expose. 190/205 answers were
wrong-but-overconfident.

### 4.3 Training-environment demonstration [PENDING]

GRPO fine-tune of a 3B model on a disjoint generated split (separate seed, 0
task-id overlap), evaluated on the sealed split before/after. [Table: base vs
tuned accuracy, fabrication rate, calibration. Run planned on a rented A100;
scripts in `docs/` runbook.]

### 4.4 Reproducibility across environments

The family-C suite regraded to an identical score (n=205, 13/205 correct,
identical CIs, identical per-subtype and per-tier tables) across three runner
configurations: the original interactive runner; a torn-down-and-reinstalled
service runner; and a third configuration under a different Windows service
account, Python 3.14 instead of 3.12, and a different launcher path — same
(release tag, seed) each time, consistent with the deterministic-seeding
design (sha256-derived per-task seeds). Across the three runs, exactly one of
the 205 raw model responses differed in form (a malformed JSON object in place
of a wrong-but-overconfident answer at temperature 0 — inference-backend
nondeterminism, not the grader); it was scored wrong in both forms, so the
score and every reported table were unaffected. We report this rather than
claim raw-response determinism, which no local inference stack guarantees.

### 4.5 External validation against NMDP tooling

On a deterministic 2,000-allele sample across six loci, our normalizer's
2-field reductions agree with py-ard 2.4.0 (db 3650) on 1,986/2,000 (99.30%).
The 14 divergences comprise six Q-suffix cases (we name the 2-field group;
py-ard annotates the reported allele's own suffix) and eight ARD-equivalence
rollups (py-ard maps ARD-identical alleles to a group exemplar — correct for
matching, lossy for name verification). Full table and triage in the
repository (docs/pyard-concordance.md), regenerated by CI from
scripts/pyard_concordance.py.

## 5. Discussion

- Deterministic verification is complementary infrastructure for agentic science
  tools: the graders run as a service (HLA-Verify) gating model output at
  runtime, the same rules that grade the benchmark.
- Limitations: English-only prompts; v0 scope excludes DPB1 TCE permissiveness,
  DQA1/DPA1, and frequency-weighted population realism (data hierarchy in
  docs/DATA_STRATEGY.md); single-turn tasks (agentic multi-step variants are
  future work); the frontier-model row currently reflects a token-budget floor.
- Contamination resistance is structural, not assumed: post-cutoff facts did not
  yield the expected advantage-from-memorization pattern (post-cutoff slice
  scored *higher* than deleted-name slice for qwen2.5:7b, consistent with task-
  type mix rather than memorization; per-subtype breakdown in supplement).
- The 0% ambiguity-expansion result across all families suggests a shared
  representational gap, not a scale problem (identical failure at 3B and 7B and
  in the frontier model), making it a concrete target for environment-driven
  training.

## 6. Data and code availability

Generators, graders, harness, adapters (verifiers/Inspect AI), and the
verification service: github.com/jasonbrelsford/verifiable-science-envs
(Apache-2.0; service under PolyForm-NC). Reference data fetched at runtime from
IPD-IMGT/HLA (CC-BY-ND; Barker DJ et al., NAR 2025) and never redistributed. Dev
splits public; sealed splits regenerate per release from (tag, seed). In-browser
demo: hlaverify.com/demo.

## TODO before submission

- [ ] Clean claude-sonnet-4-6 re-run at 1600 tokens (cache v0.2, ~$1)
- [ ] GRPO delta table (Modal A100, ~$10–30, likely within free credits)
- [x] 14B tier row (qwen2.5:14b, 2026-09-09; further 12–14B families queued on TOWER)
- [ ] Per-subtype post-cutoff breakdown (contamination supplement)
- [ ] Cross-machine bit-identical reproduction check (tower vs tower2)
- [ ] Figures with provenance (Claude Science); bioRxiv category: bioinformatics
- [ ] Decide author list / acknowledgements; ORCID
