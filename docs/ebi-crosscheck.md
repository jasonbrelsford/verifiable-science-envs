# HLA-B leader cross-check against EBI's HLA Matching API

Run 2026-11-20 20:47Z against IPD-IMGT/HLA 3.66.0 (ours) and EBI's live `b_leader` endpoint (`https://www.ebi.ac.uk/cgi-bin/ipd/matching/b_leader`), 21 fixed pairs from `scripts/ebi_crosscheck.py`. Generated; do not hand edit.

Ours is `lab.compat`, the oracle the Worker's `/v1/compat` is tested against. `no_claim` means our `leader_match` is null (not a single HLA-B mismatch), which is not a disagreement.

| check | agree | disagree | no claim |
|---|---|---|---|
| allele_leaders | 21 | 0 | 0 |
| genotype_match | 21 | 0 | 0 |
| leader_match | 15 | 0 | 6 |

**No disagreements.**

| recipient | donor | ours (rec / donor) | EBI | allele leaders | genotype | leader_match |
|---|---|---|---|---|---|---|
| B*07:02 B*57:01 | B*07:02 B*44:02 | M/T / M/T (leader_match True) | Matched | agree | agree | agree |
| B*07:02 B*57:01 | B*07:02 B*08:01 | M/T / M/M (leader_match False) | Mismatched | agree | agree | agree |
| B*07:02 B*57:01 | B*44:02 B*08:01 | M/T / M/T (leader_match None) | Matched | agree | agree | no_claim |
| B*07:02 B*44:02 | B*07:02 B*44:02 | M/T / M/T (leader_match None) | Matched | agree | agree | no_claim |
| B*07:02 B*44:02 | B*44:02 B*07:02 | M/T / M/T (leader_match None) | Matched | agree | agree | no_claim |
| B*07:02 B*07:02 | B*07:02 B*44:02 | M/M / M/T (leader_match False) | Mismatched | agree | agree | agree |
| B*07:02 B*08:01 | B*07:02 B*08:01 | M/M / M/M (leader_match None) | Matched | agree | agree | no_claim |
| B*07:02 B*08:01 | B*07:02 B*40:01 | M/M / M/T (leader_match False) | Mismatched | agree | agree | agree |
| B*44:02 B*57:01 | B*44:02 B*35:01 | T/T / T/T (leader_match True) | Matched | agree | agree | agree |
| B*44:02 B*57:01 | B*44:03 B*58:01 | T/T / T/T (leader_match None) | Matched | agree | agree | no_claim |
| B*15:01 B*35:01 | B*15:01 B*51:01 | T/T / T/T (leader_match True) | Matched | agree | agree | agree |
| B*15:02 B*07:02 | B*15:02 B*35:01 | M/T / T/T (leader_match False) | Mismatched | agree | agree | agree |
| B*27:05 B*44:02 | B*27:05 B*07:02 | T/T / M/T (leader_match False) | Mismatched | agree | agree | agree |
| B*13:02 B*38:01 | B*13:02 B*39:01 | M/T / M/T (leader_match True) | Matched | agree | agree | agree |
| B*18:01 B*49:01 | B*18:01 B*50:01 | T/T / T/T (leader_match True) | Matched | agree | agree | agree |
| B*14:02 B*52:01 | B*14:02 B*55:01 | M/T / M/T (leader_match True) | Matched | agree | agree | agree |
| B*41:02 B*45:01 | B*41:02 B*47:01 | T/T / T/T (leader_match True) | Matched | agree | agree | agree |
| B*07:02 B*57:01 | B*35:01 B*08:01 | M/T / M/T (leader_match None) | Matched | agree | agree | no_claim |
| B*08:01 B*08:01 | B*08:01 B*57:01 | M/M / M/T (leader_match False) | Mismatched | agree | agree | agree |
| B*56:01 B*07:02 | B*56:01 B*44:02 | M/T / T/T (leader_match False) | Mismatched | agree | agree | agree |
| B*81:01 B*73:01 | B*81:01 B*07:02 | M/M / M/M (leader_match True) | Matched | agree | agree | agree |

## DPB1 T-cell-epitope matching

EBI also publishes a DPB1 TCE API. `/v1/compat` does not compute TCE groups (it answers HLA-B leader and KIR ligand), so there is no verdict of ours to compare; the check starts when a DPB1 TCE rule exists in the engine.
