# HLA-Bench-C-v0.1@IMGT-3.65.0

**Can a model score a donor-recipient HLA match the way a transplant lab must?** 205 generated pairs across 8 subtypes, graded by exact match against an executable encoding of published matching rules over IPD-IMGT/HLA v3.65.0-alpha (C-v0.1 (rules.py R1-R6)). Confident counts over unresolvable typing are the headline error.

Dev split: 40 tasks (public). Sealed split: 165 tasks (server-side). Regenerated every IPD release; this page is versioned.

## Headline

| Model | Split | n | Accuracy | Tasks with fabricated names | Fabricated / task | Calibrated | Most common outcome |
|---|---|---:|---:|---:|---:|---:|---|
| `oracle-reference` | all | 205 | 100% <sub>[98–100]</sub> | 0 | 0.00 | 100% | `clean_correct` |
| `ollama/qwen2.5:7b` | all | 205 | 1% <sub>[0–3]</sub> | 0 | 0.00 | 73% | `wrong_but_overconfident` |
| `baseline-cautious-abstainer` | all | 205 | 0% <sub>[0–2]</sub> | 0 | 0.00 | 100% | `resolution_mismatch` |
| `baseline-naive-string` | all | 205 | 0% <sub>[0–2]</sub> | 0 | 0.00 | 73% | `resolution_mismatch` |

## By tier

| Model | Split | T1 syntax | T2 groups | T3 history | T4 adversarial |
|---|---|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[94–100]</sub> | 100% <sub>[93–100]</sub> | 100% <sub>[95–100]</sub> | 100% <sub>[84–100]</sub> |
| `ollama/qwen2.5:7b` | all | 3% <sub>[1–11]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–6]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |
| `baseline-naive-string` | all | 0% <sub>[0–6]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |

## By slice (where clinical risk concentrates)

| Model | Split | `null_allele` | `unconfirmed` | `partial_sequence` | `post_cutoff` | `deleted_name` | `class_II_secondary_locus` | `expression_suffix` | `serology_uncertain` | contamination-resistant |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[87–100]</sub> | — | — | — | — | — | — | — | — |
| `ollama/qwen2.5:7b` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |
| `baseline-naive-string` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |

## By subtype

| Subtype | `oracle-reference` (all) | `ollama/qwen2.5:7b` (all) | `baseline-cautious-abstainer` (all) | `baseline-naive-string` (all) |
|---|---:|---:|---:|---:|
| `antigen_vs_allele` | 100% <sub>[89–100]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |
| `count_simple` | 100% <sub>[89–100]</sub> | 7% <sub>[2–21]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |
| `direction` | 100% <sub>[87–100]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `framework_shift` | 100% <sub>[84–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> |
| `near_miss_pair` | 100% <sub>[84–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> |
| `null_trap_match` | 100% <sub>[87–100]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `resolution_insufficient` | 100% <sub>[87–100]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `same_after_normalize` | 100% <sub>[89–100]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |

## Fabricated names (top 10 per model)

- `oracle-reference` (all): none
- `ollama/qwen2.5:7b` (all): none
- `baseline-cautious-abstainer` (all): none
- `baseline-naive-string` (all): none

## Failure modes (primary, per task)

| Model | Split | `clean_correct` | `wrong_calibrated` | `wrong_but_overconfident` | `resolution_mismatch` |
|---|---|---:|---:|---:|---:|
| `oracle-reference` | all | 150 | 55 | 0 | 0 |
| `ollama/qwen2.5:7b` | all | 2 | 1 | 202 | 0 |
| `baseline-cautious-abstainer` | all | 0 | 0 | 0 | 205 |
| `baseline-naive-string` | all | 0 | 0 | 0 | 205 |

## Method

Tasks are generated from the pinned IPD-IMGT/HLA release (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, `Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`), stratified so unconfirmed and rare alleles are over-represented. The grader (`sci_envs/families/nomenclature/grade.py`) is deterministic: exact match after minimal normalization, legacy colon-less names count as wrong, a P group assigned to a null allele is `fabricated_group`, and every allele-like token in the answer and reasoning is checked against the release. Confidence intervals are Wilson 95%. The generator's own answers pass the grader at 100% (oracle test in CI).

Reference data: IPD-IMGT/HLA, Barker DJ et al., *Nucleic Acids Research* 2025 (CC-BY-ND; fetched at runtime, never redistributed). Scope: human clinical-genomics informatics only — no pathogen sequences, no wet-lab protocols.

Run your own model: `pip install -e . && hla-bench auto` (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY), or implement `answer(task) -> json` and pass it to `sci_envs.harness.run.run_model`.
