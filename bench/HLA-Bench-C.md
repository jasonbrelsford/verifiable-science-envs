# HLA-Bench-C-v0.1@IMGT-3.65.0

**Can a model score a donor-recipient HLA match the way a transplant lab must?** 205 generated pairs across 8 subtypes, graded by exact match against an executable encoding of published matching rules over IPD-IMGT/HLA v3.65.0-alpha (C-v0.1.1 (rules.py R1-R6)). Confident counts over unresolvable typing are the headline error.

Dev split: 43 tasks (public). Sealed split: 162 tasks (server-side). Regenerated every IPD release; this page is versioned.

## Headline

| Model | Split | n | Accuracy | Tasks with fabricated names | Fabricated / task | Calibrated | Most common outcome |
|---|---|---:|---:|---:|---:|---:|---|
| `ollama/qwen2.5:14b` | all | 205 | 12% <sub>[8–17]</sub> | 14 | 0.08 | 88% | `wrong_but_overconfident` |
| `ollama/qwen2.5:7b` | all | 205 | 6% <sub>[4–11]</sub> | 2 | 0.01 | 87% | `wrong_but_overconfident` |
| `baseline-cautious-abstainer` | all | 205 | 0% <sub>[0–2]</sub> | 0 | 0.00 | 100% | `resolution_mismatch` |
| `baseline-naive-string` | all | 205 | 0% <sub>[0–2]</sub> | 0 | 0.00 | 88% | `resolution_mismatch` |

## By tier

| Model | Split | T1 syntax | T2 groups | T3 history | T4 adversarial |
|---|---|---:|---:|---:|---:|
| `ollama/qwen2.5:14b` | all | 33% <sub>[23–46]</sub> | 8% <sub>[3–19]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |
| `ollama/qwen2.5:7b` | all | 22% <sub>[13–34]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–6]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |
| `baseline-naive-string` | all | 0% <sub>[0–6]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–16]</sub> |

## By slice (where clinical risk concentrates)

| Model | Split | `null_allele` | `unconfirmed` | `partial_sequence` | `post_cutoff` | `deleted_name` | `class_II_secondary_locus` | `expression_suffix` | `serology_uncertain` | contamination-resistant |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ollama/qwen2.5:14b` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |
| `ollama/qwen2.5:7b` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |
| `baseline-naive-string` | all | 0% <sub>[0–13]</sub> | — | — | — | — | — | — | — | — |

## By subtype

| Subtype | `ollama/qwen2.5:14b` (all) | `ollama/qwen2.5:7b` (all) | `baseline-cautious-abstainer` (all) | `baseline-naive-string` (all) |
|---|---:|---:|---:|---:|
| `antigen_vs_allele` | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |
| `count_simple` | 60% <sub>[42–75]</sub> | 33% <sub>[19–51]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |
| `direction` | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `framework_shift` | 20% <sub>[8–42]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> |
| `near_miss_pair` | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> |
| `null_trap_match` | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `resolution_insufficient` | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> | 0% <sub>[0–13]</sub> |
| `same_after_normalize` | 7% <sub>[2–21]</sub> | 10% <sub>[3–26]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> |

## Fabricated names (top 10 per model)

- `ollama/qwen2.5:14b` (all): `C*1481`×2, `A*2524`×2, `A*2562`×1, `A*2339`×1, `B*5643`×1, `DRB1*03:740`×1, `A*0192`×1, `A*3284`×1, `C*0745`×1, `A*6883`×1
- `ollama/qwen2.5:7b` (all): `C*0224`×1, `C*1481`×1
- `baseline-cautious-abstainer` (all): none
- `baseline-naive-string` (all): none

## Failure modes (primary, per task)

| Model | Split | `clean_correct` | `wrong_but_overconfident` | `wrong_calibrated` | `malformed_response` | `resolution_mismatch` |
|---|---|---:|---:|---:|---:|---:|
| `ollama/qwen2.5:14b` | all | 23 | 181 | 1 | 0 | 0 |
| `ollama/qwen2.5:7b` | all | 13 | 189 | 2 | 1 | 0 |
| `baseline-cautious-abstainer` | all | 0 | 0 | 0 | 0 | 205 |
| `baseline-naive-string` | all | 0 | 0 | 0 | 0 | 205 |

## Method

Tasks are generated from the pinned IPD-IMGT/HLA release (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, `Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`), stratified so unconfirmed and rare alleles are over-represented. The grader (`sci_envs/families/nomenclature/grade.py`) is deterministic: exact match after minimal normalization, legacy colon-less names count as wrong, a P group assigned to a null allele is `fabricated_group`, and every allele-like token in the answer and reasoning is checked against the release. Confidence intervals are Wilson 95%. The generator's own answers pass the grader at 100% (oracle test in CI).

Reference data: IPD-IMGT/HLA, Barker DJ et al., *Nucleic Acids Research* 2025 (CC-BY-ND; fetched at runtime, never redistributed). Scope: human clinical-genomics informatics only — no pathogen sequences, no wet-lab protocols.

Run your own model: `pip install -e . && hla-bench auto` (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY), or implement `answer(task) -> json` and pass it to `sci_envs.harness.run.run_model`.
