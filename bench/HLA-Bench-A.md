# HLA-Bench-A-v0.1@IMGT-3.65.0

**Can a model resolve HLA allele names the way a clinical immunogenetics lab must?** 550 generated tasks, 20 subtypes in 4 tiers, graded by exact match against IPD-IMGT/HLA release 3.65.0 (v3.65.0-alpha). No fuzzy credit. Fabricated allele names are the headline metric.

Dev split: 112 tasks (public, `runs/hla-bench-a/dev/`). Sealed split: 438 tasks (server-side). 33% of Tier 3/4 allele tasks concern names that did not exist at IMGT 3.58.0 (assumed model cutoff). Regenerated every IPD release; this page is versioned.

## Headline

| Model | Split | n | Accuracy | Tasks with fabricated names | Fabricated / task | Calibrated | Most common outcome |
|---|---|---:|---:|---:|---:|---:|---|
| `oracle-reference` | all | 550 | 100% <sub>[99–100]</sub> | 0 | 0.00 | 100% | `clean_correct` |
| `oracle-reference` | dev | 112 | 100% <sub>[97–100]</sub> | 0 | 0.00 | 100% | `clean_correct` |
| `ollama/qwen2.5:7b` | all | 550 | 31% <sub>[27–35]</sub> | 47 | 0.09 | 31% | `wrong_but_overconfident` |
| `ollama/qwen2.5:7b` | dev | 112 | 30% <sub>[23–39]</sub> | 6 | 0.05 | 30% | `wrong_but_overconfident` |
| `ollama/mistral:7b` | all | 550 | 29% <sub>[26–33]</sub> | 76 | 0.19 | 30% | `wrong_but_overconfident` |
| `baseline-confident-guesser` | all | 550 | 28% <sub>[25–32]</sub> | 8 | 0.01 | 29% | `wrong_but_overconfident` |
| `baseline-naive-string` | all | 550 | 28% <sub>[25–32]</sub> | 8 | 0.01 | 29% | `wrong_but_overconfident` |
| `baseline-confident-guesser` | dev | 112 | 26% <sub>[19–35]</sub> | 3 | 0.03 | 28% | `wrong_but_overconfident` |
| `baseline-naive-string` | dev | 112 | 26% <sub>[19–35]</sub> | 3 | 0.03 | 28% | `wrong_but_overconfident` |
| `ollama/llama3.2:3b` | all | 550 | 15% <sub>[12–18]</sub> | 57 | 0.11 | 42% | `wrong_but_overconfident` |
| `baseline-cautious-abstainer` | all | 550 | 4% <sub>[2–6]</sub> | 0 | 0.00 | 100% | `refused` |
| `baseline-cautious-abstainer` | dev | 112 | 4% <sub>[1–9]</sub> | 0 | 0.00 | 100% | `refused` |

## By tier

| Model | Split | T1 syntax | T2 groups | T3 history | T4 adversarial |
|---|---|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[97–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[96–100]</sub> |
| `oracle-reference` | dev | 100% <sub>[87–100]</sub> | 100% <sub>[88–100]</sub> | 100% <sub>[92–100]</sub> | 100% <sub>[82–100]</sub> |
| `ollama/qwen2.5:7b` | all | 39% <sub>[31–48]</sub> | 31% <sub>[24–39]</sub> | 26% <sub>[20–33]</sub> | 28% <sub>[20–37]</sub> |
| `ollama/qwen2.5:7b` | dev | 44% <sub>[27–63]</sub> | 32% <sub>[18–51]</sub> | 24% <sub>[13–39]</sub> | 24% <sub>[10–47]</sub> |
| `ollama/mistral:7b` | all | 40% <sub>[32–49]</sub> | 35% <sub>[28–43]</sub> | 22% <sub>[17–29]</sub> | 20% <sub>[13–29]</sub> |
| `baseline-confident-guesser` | all | 63% <sub>[54–71]</sub> | 26% <sub>[20–34]</sub> | 19% <sub>[14–26]</sub> | 6% <sub>[3–12]</sub> |
| `baseline-naive-string` | all | 63% <sub>[54–71]</sub> | 26% <sub>[20–34]</sub> | 19% <sub>[14–26]</sub> | 6% <sub>[3–12]</sub> |
| `baseline-confident-guesser` | dev | 60% <sub>[41–77]</sub> | 14% <sub>[6–31]</sub> | 24% <sub>[13–39]</sub> | 0% <sub>[0–18]</sub> |
| `baseline-naive-string` | dev | 60% <sub>[41–77]</sub> | 14% <sub>[6–31]</sub> | 24% <sub>[13–39]</sub> | 0% <sub>[0–18]</sub> |
| `ollama/llama3.2:3b` | all | 22% <sub>[16–31]</sub> | 15% <sub>[10–22]</sub> | 13% <sub>[9–19]</sub> | 6% <sub>[3–12]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–3]</sub> | 0% <sub>[0–2]</sub> | 0% <sub>[0–2]</sub> | 20% <sub>[13–29]</sub> |
| `baseline-cautious-abstainer` | dev | 0% <sub>[0–13]</sub> | 0% <sub>[0–12]</sub> | 0% <sub>[0–8]</sub> | 24% <sub>[10–47]</sub> |

## By slice (where clinical risk concentrates)

| Model | Split | `null_allele` | `unconfirmed` | `partial_sequence` | `post_cutoff` | `deleted_name` | `class_II_secondary_locus` | `expression_suffix` | `serology_uncertain` | contamination-resistant |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `oracle-reference` | all | 100% <sub>[90–100]</sub> | 100% <sub>[98–100]</sub> | 100% <sub>[97–100]</sub> | 100% <sub>[95–100]</sub> | 100% <sub>[96–100]</sub> | 100% <sub>[97–100]</sub> | 100% <sub>[65–100]</sub> | 100% <sub>[80–100]</sub> | 100% <sub>[97–100]</sub> |
| `oracle-reference` | dev | 100% <sub>[61–100]</sub> | 100% <sub>[93–100]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[82–100]</sub> | 100% <sub>[85–100]</sub> | 100% <sub>[86–100]</sub> | 100% <sub>[44–100]</sub> | 100% <sub>[21–100]</sub> | 100% <sub>[86–100]</sub> |
| `ollama/qwen2.5:7b` | all | 81% <sub>[65–90]</sub> | 46% <sub>[40–53]</sub> | 45% <sub>[37–53]</sub> | 59% <sub>[48–69]</sub> | 8% <sub>[4–15]</sub> | 37% <sub>[30–46]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[0–20]</sub> | 46% <sub>[37–55]</sub> |
| `ollama/qwen2.5:7b` | dev | 83% <sub>[44–97]</sub> | 42% <sub>[30–56]</sub> | 34% <sub>[20–52]</sub> | 47% <sub>[26–69]</sub> | 10% <sub>[3–29]</sub> | 30% <sub>[16–51]</sub> | 0% <sub>[0–56]</sub> | 0% <sub>[0–79]</sub> | 39% <sub>[22–59]</sub> |
| `ollama/mistral:7b` | all | 81% <sub>[65–90]</sub> | 48% <sub>[42–54]</sub> | 52% <sub>[44–60]</sub> | 58% <sub>[47–68]</sub> | 2% <sub>[1–7]</sub> | 37% <sub>[30–46]</sub> | 14% <sub>[3–51]</sub> | 0% <sub>[0–20]</sub> | 38% <sub>[30–47]</sub> |
| `baseline-confident-guesser` | all | 6% <sub>[2–18]</sub> | 35% <sub>[30–42]</sub> | 33% <sub>[26–41]</sub> | 22% <sub>[14–32]</sub> | 18% <sub>[12–27]</sub> | 30% <sub>[23–38]</sub> | 14% <sub>[3–51]</sub> | 100% <sub>[80–100]</sub> | 14% <sub>[9–22]</sub> |
| `baseline-naive-string` | all | 6% <sub>[2–18]</sub> | 35% <sub>[30–42]</sub> | 33% <sub>[26–41]</sub> | 22% <sub>[14–32]</sub> | 18% <sub>[12–27]</sub> | 30% <sub>[23–38]</sub> | 14% <sub>[3–51]</sub> | 100% <sub>[80–100]</sub> | 14% <sub>[9–22]</sub> |
| `baseline-confident-guesser` | dev | 0% <sub>[0–39]</sub> | 27% <sub>[17–40]</sub> | 28% <sub>[16–45]</sub> | 24% <sub>[10–47]</sub> | 14% <sub>[5–35]</sub> | 30% <sub>[16–51]</sub> | 33% <sub>[6–79]</sub> | 100% <sub>[21–100]</sub> | 17% <sub>[7–37]</sub> |
| `baseline-naive-string` | dev | 0% <sub>[0–39]</sub> | 27% <sub>[17–40]</sub> | 28% <sub>[16–45]</sub> | 24% <sub>[10–47]</sub> | 14% <sub>[5–35]</sub> | 30% <sub>[16–51]</sub> | 33% <sub>[6–79]</sub> | 100% <sub>[21–100]</sub> | 17% <sub>[7–37]</sub> |
| `ollama/llama3.2:3b` | all | 3% <sub>[0–14]</sub> | 19% <sub>[15–24]</sub> | 15% <sub>[10–21]</sub> | 29% <sub>[21–40]</sub> | 3% <sub>[1–8]</sub> | 14% <sub>[9–21]</sub> | 0% <sub>[0–35]</sub> | 7% <sub>[1–30]</sub> | 25% <sub>[18–33]</sub> |
| `baseline-cautious-abstainer` | all | 0% <sub>[0–10]</sub> | 0% <sub>[0–2]</sub> | 0% <sub>[0–3]</sub> | 0% <sub>[0–5]</sub> | 0% <sub>[0–4]</sub> | 0% <sub>[0–3]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[0–20]</sub> | 17% <sub>[11–25]</sub> |
| `baseline-cautious-abstainer` | dev | 0% <sub>[0–39]</sub> | 0% <sub>[0–7]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–18]</sub> | 0% <sub>[0–15]</sub> | 0% <sub>[0–14]</sub> | 0% <sub>[0–56]</sub> | 0% <sub>[0–79]</sub> | 17% <sub>[7–37]</sub> |

## By subtype

| Subtype | `oracle-reference` (all) | `oracle-reference` (dev) | `ollama/qwen2.5:7b` (all) | `ollama/qwen2.5:7b` (dev) | `ollama/mistral:7b` (all) | `baseline-confident-guesser` (all) | `baseline-naive-string` (all) | `baseline-confident-guesser` (dev) | `baseline-naive-string` (dev) | `ollama/llama3.2:3b` (all) | `baseline-cautious-abstainer` (all) | `baseline-cautious-abstainer` (dev) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `deleted_reason` | 100% <sub>[89–100]</sub> | 100% <sub>[57–100]</sub> | 10% <sub>[3–26]</sub> | 0% <sub>[0–43]</sub> | 3% <sub>[1–17]</sub> | 40% <sub>[25–58]</sub> | 40% <sub>[25–58]</sub> | 60% <sub>[23–88]</sub> | 60% <sub>[23–88]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> |
| `existed_at` | 100% <sub>[89–100]</sub> | 100% <sub>[57–100]</sub> | 63% <sub>[46–78]</sub> | 40% <sub>[12–77]</sub> | 67% <sub>[49–81]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 60% <sub>[23–88]</sub> | 60% <sub>[23–88]</sub> | 60% <sub>[42–75]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> |
| `expand_ambiguity` | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> | 0% <sub>[0–39]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> |
| `first_release` | 100% <sub>[89–100]</sub> | 100% <sub>[72–100]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–28]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–28]</sub> | 0% <sub>[0–28]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–28]</sub> |
| `g_group` | 100% <sub>[89–100]</sub> | 100% <sub>[65–100]</sub> | 57% <sub>[39–73]</sub> | 43% <sub>[16–75]</sub> | 57% <sub>[39–73]</sub> | 13% <sub>[5–30]</sub> | 13% <sub>[5–30]</sub> | 14% <sub>[3–51]</sub> | 14% <sub>[3–51]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–35]</sub> |
| `group_members_count` | 100% <sub>[89–100]</sub> | 100% <sub>[57–100]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> | 0% <sub>[0–43]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> |
| `locus_field` | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 20% <sub>[10–37]</sub> | 17% <sub>[3–56]</sub> | 33% <sub>[19–51]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 100% <sub>[61–100]</sub> | 57% <sub>[39–73]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> |
| `name_at_release` | 100% <sub>[89–100]</sub> | 100% <sub>[68–100]</sub> | 60% <sub>[42–75]</sub> | 62% <sub>[31–86]</sub> | 60% <sub>[42–75]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 38% <sub>[14–69]</sub> | 38% <sub>[14–69]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–32]</sub> |
| `near_miss` | 100% <sub>[84–100]</sub> | 100% <sub>[51–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–49]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–49]</sub> | 0% <sub>[0–49]</sub> | 0% <sub>[0–16]</sub> | 100% <sub>[84–100]</sub> | 100% <sub>[51–100]</sub> |
| `new_in_release` | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 3% <sub>[1–17]</sub> | 17% <sub>[3–56]</sub> | 0% <sub>[0–11]</sub> | 3% <sub>[1–17]</sub> | 3% <sub>[1–17]</sub> | 17% <sub>[3–56]</sub> | 17% <sub>[3–56]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> |
| `null_trap` | 100% <sub>[84–100]</sub> | 100% <sub>[44–100]</sub> | 100% <sub>[84–100]</sub> | 100% <sub>[44–100]</sub> | 100% <sub>[84–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–56]</sub> | 0% <sub>[0–56]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–56]</sub> |
| `p_group` | 100% <sub>[89–100]</sub> | 100% <sub>[57–100]</sub> | 43% <sub>[27–61]</sub> | 60% <sub>[23–88]</sub> | 50% <sub>[33–67]</sub> | 30% <sub>[17–48]</sub> | 30% <sub>[17–48]</sub> | 20% <sub>[4–62]</sub> | 20% <sub>[4–62]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–43]</sub> |
| `release_drift` | 100% <sub>[84–100]</sub> | 100% <sub>[34–100]</sub> | 40% <sub>[22–61]</sub> | 50% <sub>[9–91]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–66]</sub> | 0% <sub>[0–66]</sub> | 30% <sub>[15–52]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–66]</sub> |
| `renamed_to` | 100% <sub>[89–100]</sub> | 100% <sub>[68–100]</sub> | 17% <sub>[7–34]</sub> | 25% <sub>[7–59]</sub> | 3% <sub>[1–17]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–32]</sub> | 0% <sub>[0–32]</sub> | 7% <sub>[2–21]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–32]</sub> |
| `resolve_chain` | 100% <sub>[84–100]</sub> | 100% <sub>[65–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[0–35]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–35]</sub> |
| `same_group` | 100% <sub>[89–100]</sub> | 100% <sub>[65–100]</sub> | 37% <sub>[22–54]</sub> | 14% <sub>[3–51]</sub> | 67% <sub>[49–81]</sub> | 37% <sub>[22–54]</sub> | 37% <sub>[22–54]</sub> | 14% <sub>[3–51]</sub> | 14% <sub>[3–51]</sub> | 67% <sub>[49–81]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–35]</sub> |
| `serology` | 100% <sub>[89–100]</sub> | 100% <sub>[51–100]</sub> | 20% <sub>[10–37]</sub> | 50% <sub>[15–85]</sub> | 0% <sub>[0–11]</sub> | 50% <sub>[33–67]</sub> | 50% <sub>[33–67]</sub> | 25% <sub>[5–70]</sub> | 25% <sub>[5–70]</sub> | 10% <sub>[3–26]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–49]</sub> |
| `truncate` | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 93% <sub>[79–98]</sub> | 100% <sub>[61–100]</sub> | 63% <sub>[46–78]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[89–100]</sub> | 100% <sub>[61–100]</sub> | 100% <sub>[61–100]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–39]</sub> |
| `typing_report_normalize` | 100% <sub>[84–100]</sub> | 100% <sub>[21–100]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–79]</sub> | 0% <sub>[0–16]</sub> | 30% <sub>[15–52]</sub> | 30% <sub>[15–52]</sub> | 0% <sub>[0–79]</sub> | 0% <sub>[0–79]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–16]</sub> | 0% <sub>[0–79]</sub> |
| `valid_name` | 100% <sub>[89–100]</sub> | 100% <sub>[65–100]</sub> | 43% <sub>[27–61]</sub> | 57% <sub>[25–84]</sub> | 63% <sub>[46–78]</sub> | 53% <sub>[36–70]</sub> | 53% <sub>[36–70]</sub> | 43% <sub>[16–75]</sub> | 43% <sub>[16–75]</sub> | 33% <sub>[19–51]</sub> | 0% <sub>[0–11]</sub> | 0% <sub>[0–35]</sub> |

## Fabricated names (top 10 per model)

- `oracle-reference` (all): none
- `oracle-reference` (dev): none
- `ollama/qwen2.5:7b` (all): `B*18:16`×3, `DRB1*11:605`×1, `DRB5*0212`×1, `A*29:110:99`×1, `DPA1*01240`×1, `B*1487`×1, `P*1801`×1, `P*55:02`×1, `P*24:02`×1, `B*1501:05`×1
- `ollama/qwen2.5:7b` (dev): `B*1487`×1, `DQB1*05:03:26:99`×1, `DRB4*01:03:15:99`×1, `DRB3*01:75:99`×1, `A*33:02`×1, `DPB1*56:06`×1
- `ollama/mistral:7b` (all): `DRB5*01:03:02`×3, `DPA1*0201`×2, `B*02:02`×2, `DRB1*07:02`×2, `B*39:012`×2, `DRB4*0103`×1, `DRB5*0101`×1, `DRB1*11:605`×1, `DRB5*0212`×1, `A*29:110:99`×1
- `baseline-confident-guesser` (all): `B*18:16`×2, `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1, `DRB1*07:02`×1, `B*51:47`×1, `DPB1*43:01`×1
- `baseline-naive-string` (all): `B*18:16`×2, `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1, `DRB1*07:02`×1, `B*51:47`×1, `DPB1*43:01`×1
- `baseline-confident-guesser` (dev): `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1
- `baseline-naive-string` (dev): `C*12:03:01:42G`×1, `H*02:01:01:02G`×1, `DRB1*11:01:01:02G`×1
- `ollama/llama3.2:3b` (all): `DRB5*0101`×3, `DQB1*0601`×3, `DRB4*0101`×3, `DRB4*0103`×2, `DPB1*0101`×2, `DRB1*04:94:02`×2, `DQB1*0501`×2, `DPA1*0103`×1, `C*0701`×1, `C*1203`×1
- `baseline-cautious-abstainer` (all): none
- `baseline-cautious-abstainer` (dev): none

## Failure modes (primary, per task)

| Model | Split | `clean_correct` | `correct_but_overconfident` | `correct_with_hallucinated_reasoning` | `hallucinated_answer` | `refused` | `resolution_mismatch` | `wrong_but_overconfident` | `wrong_calibrated` | `legacy_nomenclature` | `fabricated_group` | `malformed_response` |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `oracle-reference` | all | 550 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `oracle-reference` | dev | 112 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `ollama/qwen2.5:7b` | all | 25 | 124 | 5 | 22 | 10 | 5 | 340 | 19 | 0 | 0 | 0 |
| `ollama/qwen2.5:7b` | dev | 4 | 24 | 1 | 2 | 3 | 0 | 73 | 5 | 0 | 0 | 0 |
| `ollama/mistral:7b` | all | 15 | 117 | 6 | 34 | 1 | 5 | 341 | 30 | 1 | 0 | 0 |
| `baseline-confident-guesser` | all | 39 | 117 | 0 | 8 | 0 | 21 | 290 | 0 | 4 | 71 | 0 |
| `baseline-naive-string` | all | 39 | 117 | 0 | 8 | 0 | 21 | 290 | 0 | 4 | 71 | 0 |
| `baseline-confident-guesser` | dev | 8 | 21 | 0 | 3 | 0 | 2 | 61 | 0 | 1 | 16 | 0 |
| `baseline-naive-string` | dev | 8 | 21 | 0 | 3 | 0 | 2 | 61 | 0 | 1 | 16 | 0 |
| `ollama/llama3.2:3b` | all | 13 | 42 | 3 | 23 | 29 | 39 | 337 | 52 | 10 | 0 | 2 |
| `baseline-cautious-abstainer` | all | 0 | 0 | 0 | 0 | 490 | 40 | 0 | 20 | 0 | 0 | 0 |
| `baseline-cautious-abstainer` | dev | 0 | 0 | 0 | 0 | 100 | 8 | 0 | 4 | 0 | 0 | 0 |

## Method

Tasks are generated from the pinned IPD-IMGT/HLA release (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, `Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`), stratified so unconfirmed and rare alleles are over-represented. The grader (`sci_envs/families/nomenclature/grade.py`) is deterministic: exact match after minimal normalization, legacy colon-less names count as wrong, a P group assigned to a null allele is `fabricated_group`, and every allele-like token in the answer and reasoning is checked against the release. Confidence intervals are Wilson 95%. The generator's own answers pass the grader at 100% (oracle test in CI).

Reference data: IPD-IMGT/HLA, Barker DJ et al., *Nucleic Acids Research* 2025 (CC-BY-ND; fetched at runtime, never redistributed). Scope: human clinical-genomics informatics only — no pathogen sequences, no wet-lab protocols.

Run your own model: `pip install -e . && hla-bench auto` (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY), or implement `answer(task) -> json` and pass it to `sci_envs.harness.run.run_model`.
