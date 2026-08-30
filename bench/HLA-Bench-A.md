# HLA-Bench-A-v0.1@IMGT-3.65.0

**Can a model resolve HLA allele names the way a clinical immunogenetics lab must?** 550 generated tasks, 20 subtypes in 4 tiers, graded by exact match against IPD-IMGT/HLA release 3.65.0 (v3.65.0-alpha). No fuzzy credit. Fabricated allele names are the headline metric.

Dev split: 112 tasks (public, `runs/hla-bench-a/dev/`). Sealed split: 438 tasks (server-side). 33% of Tier 3/4 allele tasks concern names that did not exist at IMGT 3.58.0 (assumed model cutoff). Regenerated every IPD release; this page is versioned.

## Headline

| Model | Split | n | Accuracy | Tasks with fabricated names | Fabricated / task | Calibrated | Most common outcome |
|---|---|---:|---:|---:|---:|---:|---|
| `oracle-reference` | all | 550 | 100% <sub>[99–100]</sub> | 0 | 0.00 | 100% | `clean_correct` |
| `baseline-confident-guesser` | all | 550 | 28% <sub>[25–32]</sub> | 8 | 0.01 | 29% | `clean_correct` |
| `baseline-naive-string` | all | 550 | 28% <sub>[25–32]</sub> | 8 | 0.01 | 29% | `clean_correct` |
| `baseline-cautious-abstainer` | all | 550 | 4% <sub>[2–6]</sub> | 0 | 0.00 | 100% | `refused` |

## By tier

| Model | Split | T1 syntax | T2 groups | T3 history | T4 adversarial |
|---|---|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[97–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[96–100]</sub> |
| `baseline-confident-guesser` | all | 63% <sub>[54–71]</sub> | 26% <sub>[20–34]</sub> | 19% <sub>[14–26]</sub> | 6% <sub>[3–12]</sub> |
| `baseline-naive-string` | all | 63% <sub>[54–71]</sub> | 26% <sub>[20–34]</sub> | 19% <sub>[14–26]</sub> | 6% <sub>[3–12]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[-0–3]</sub> | 0% <sub>[0–2]</sub> | 0% <sub>[0–2]</sub> | 20% <sub>[13–29]</sub> |

## By slice (where clinical risk concentrates)

| Model | Split | `null_allele` | `unconfirmed` | `partial_sequence` | `post_cutoff` | `deleted_name` | `class_II_secondary_locus` | `expression_suffix` | `serology_uncertain` | contamination-resistant |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[90–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[97–100]</sub> | 100% <sub>[95–100]</sub> | 100% <sub>[96–100]</sub> | 100% <sub>[97–100]</sub> | 100% <sub>[65–100]</sub> | 100% <sub>[80–100]</sub> | 100% <sub>[97–100]</sub> |
| `baseline-confident-guesser` | all | 6% <sub>[2–18]</sub> | 35% <sub>[30–42]</sub> | 33% <sub>[26–41]</sub> | 22% <sub>[14–32]</sub> | 18% <sub>[12–27]</sub> | 30% <sub>[23–38]</sub> | 14% <sub>[3–51]</sub> | 100% <sub>[80–100]</sub> | 14% <sub>[9–22]</sub> |
| `baseline-naive-string` | all | 6% <sub>[2–18]</sub> | 35% <sub>[30–42]</sub> | 33% <sub>[26–41]</sub> | 22% <sub>[14–32]</sub> | 18% <sub>[12–27]</sub> | 30% <sub>[23–38]</sub> | 14% <sub>[3–51]</sub> | 100% <sub>[80–100]</sub> | 14% <sub>[9–22]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–10]</sub> | 0% <sub>[-0–2]</sub> | 0% <sub>[0–3]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–4]</sub> | 0% <sub>[0–3]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[-0–20]</sub> | 17% <sub>[11–25]</sub> |

## By subtype

| Subtype | `oracle-reference` (all) | `baseline-confident-guesser` (all) | `baseline-naive-string` (all) | `baseline-cautious-abstainer` (all) |
|---|---:|---:|---:|---:|
| `deleted_reason` | 100% <sub>[89–100]</sub> | 40% <sub>[25–58]</sub> | 40% <sub>[25–58]</sub> | 0% <sub>[-0–11]</sub> |
| `existed_at` | 100% <sub>[89–100]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 0% <sub>[-0–11]</sub> |
| `expand_ambiguity` | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> |
| `first_release` | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> |
| `g_group` | 100% <sub>[89–100]</sub> | 13% <sub>[5–30]</sub> | 13% <sub>[5–30]</sub> | 0% <sub>[-0–11]</sub> |
| `group_members_count` | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> |
| `locus_field` | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> |
| `name_at_release` | 100% <sub>[89–100]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 0% <sub>[-0–11]</sub> |
| `near_miss` | 100% <sub>[84–100]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> | 100% <sub>[84–100]</sub> |
| `new_in_release` | 100% <sub>[89–100]</sub> | 3% <sub>[1–17]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[-0–11]</sub> |
| `null_trap` | 100% <sub>[84–100]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> |
| `p_group` | 100% <sub>[89–100]</sub> | 30% <sub>[17–48]</sub> | 30% <sub>[17–48]</sub> | 0% <sub>[-0–11]</sub> |
| `release_drift` | 100% <sub>[84–100]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> |
| `renamed_to` | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> | 0% <sub>[-0–11]</sub> |
| `resolve_chain` | 100% <sub>[84–100]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> | 0% <sub>[-0–16]</sub> |
| `same_group` | 100% <sub>[89–100]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 0% <sub>[-0–11]</sub> |
| `serology` | 100% <sub>[89–100]</sub> | 50% <sub>[33–67]</sub> | 50% <sub>[33–67]</sub> | 0% <sub>[-0–11]</sub> |
| `truncate` | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 0% <sub>[-0–11]</sub> |
| `typing_report_normalize` | 100% <sub>[84–100]</sub> | 30% <sub>[15–52]</sub> | 30% <sub>[15–52]</sub> | 0% <sub>[-0–16]</sub> |
| `valid_name` | 100% <sub>[89–100]</sub> | 53% <sub>[36–70]</sub> | 53% <sub>[36–70]</sub> | 0% <sub>[-0–11]</sub> |

## Fabricated names (top 10 per model)

- `oracle-reference` (all): none
- `baseline-confident-guesser` (all): `B*18:16`×2, `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1, `DRB1*07:02`×1, `B*51:47`×1, `DPB1*43:01`×1
- `baseline-naive-string` (all): `B*18:16`×2, `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1, `DRB1*07:02`×1, `B*51:47`×1, `DPB1*43:01`×1
- `baseline-cautious-abstainer` (all): none

## Failure modes (primary, per task)

| Model | Split | `clean_correct` | `correct_but_overconfident` | `fabricated_group` | `hallucinated_answer` | `legacy_nomenclature` | `resolution_mismatch` | `wrong_but_overconfident` | `refused` | `wrong_calibrated` |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `oracle-reference` | all | 550 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `baseline-confident-guesser` | all | 39 | 117 | 71 | 8 | 4 | 21 | 290 | 0 | 0 |
| `baseline-naive-string` | all | 39 | 117 | 71 | 8 | 4 | 21 | 290 | 0 | 0 |
| `baseline-cautious-abstainer` | all | 0 | 0 | 0 | 0 | 0 | 40 | 0 | 490 | 20 |

## Method

Tasks are generated from the pinned IPD-IMGT/HLA release (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, `Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`), stratified so unconfirmed and rare alleles are over-represented. The grader (`sci_envs/families/nomenclature/grade.py`) is deterministic: exact match after minimal normalization, legacy colon-less names count as wrong, a P group assigned to a null allele is `fabricated_group`, and every allele-like token in the answer and reasoning is checked against the release. Confidence intervals are Wilson 95%. The generator's own answers pass the grader at 100% (oracle test in CI).

Reference data: IPD-IMGT/HLA, Barker DJ et al., *Nucleic Acids Research* 2025 (CC-BY-ND; fetched at runtime, never redistributed). Scope: human clinical-genomics informatics only — no pathogen sequences, no wet-lab protocols.

Run your own model: `pip install -e . && hla-bench auto` (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY), or implement `answer(task) -> json` and pass it to `sci_envs.harness.run.run_model`.
