# TASK_SPEC — Family C: donor–recipient matching (v0.1 sketch, 2026-08-31)

*Companion to families A (nomenclature) and B (phasing/imputation). C is where an AI mistake most directly becomes a transplant mistake, and where the executable-oracle design shines: the rules are published, deterministic, and full of edge cases labs get wrong by hand.*

## 1. Task shape

**Input:** recipient typing + donor typing (2–6 loci among A, C, B, DRB1, DRB3/4/5, DQA1, DQB1, DPA1, DPB1; mixed resolutions and eras, exactly like family A's typing strings), match framework requested (`6/6`, `8/8`, `10/10`, `12/12`, or `antigen`), and the pinned release.

**Output:** match count (e.g. `7/8`), the per-locus verdict list (`match | mismatch | potential` with direction), and `flags` (`null_allele_mismatch`, `antigen_split_issue`, `resolution_insufficient`, `directional_gvh`, `directional_hvg`).

## 2. Ground truth: an executable encoding of the published rules

The oracle encodes, from public documents and WMDA files only: allele-level equality after family-A normalization (deleted names chased to successors first — this is why C builds on A); antigen-level equivalence via `rel_dna_ser.txt` (unambiguous column; `possible/assumed` become the `potential` verdict) and broad/split lineage via `rel_ser_ser.txt`; null alleles matching at antigen level but not expressing (the classic trap: A*24:09N types as A24 serologically but is a functional mismatch); homozygosity counting; and GvH vs HvG directionality when one side is homozygous. DPB1 TCE permissiveness is deliberately deferred to a versioned slice once the TCE table source and licence are checked. Where accredited labs demonstrably disagree (documented ambiguity-string edge cases), tasks carry an `edge_case` slice tag rather than pretending consensus.

## 3. Subtypes (draft)

T1: `count_simple` (clean 2-field, one framework), `same_after_normalize` (legacy vs current era, same alleles — family A inside family C). T2: `antigen_vs_allele` (allele mismatch that is an antigen match — the "looks fine serologically" trap), `broad_split` (A9 vs A23/A24). T3: `null_trap_match` (null allele hidden in a serological match), `direction` (homozygous recipient or donor; report both GvH and HvG counts), `resolution_insufficient` (typing too coarse to call; correct answer is `potential` + flag, a confident count is wrong). T4: `multi_framework` (same pair scored 6/6 and 10/10 with different verdicts), `near_miss_pair` (donor differing by one digit from a perfect match — fabrication-adjacent), `edge_case` (documented lab-disagreement inputs; graded only on flagging, not on the count).

## 4. Grading

Exact match on count + per-locus verdicts; partial credit structure like family A's object grading (count correct but a verdict wrong = `resolution_mismatch` analogue). New failure modes: `false_match` (called match on a mismatch — the dangerous direction, weighted in the reward), `false_mismatch`, `direction_confused`, `null_ignored`. Anti-reward-hacking: blanket `potential` on everything is penalized like blanket refusal.

## 5. Why C might ship before B

B needs a synthetic-population design review; C needs only files we already load (rel_dna_ser, rel_ser_ser, Deleted_alleles, Allelelist) plus rule encoding — no new data, no licence questions, and it reuses family A's normalizer as step one. Estimated build: comparable to family A (spec → generators → oracle → 550 tasks). It also unlocks the `/v1/match-check` Verify endpoint, the single most lab-relevant feature in PRODUCT.md. Proposal: implement C next, B after the NMDP licence reply.
