# TASK_SPEC — Family A: HLA Allele Nomenclature Resolution

*v0.1 · August 30, 2026 · Rung 1 of the credibility ladder. Companion: `GRADER_SPEC.md`. Reference facts verified against the ANHIG/IMGTHLA GitHub mirror on 2026-08-30: current release **3.65.0** (2026-07-14), **46,652** named alleles, **288** deleted alleles, `Allelelist_history.txt` columns back to 3.27.0.*

## 1. Purpose

A generated, versioned, deterministically graded task set that measures whether an agent can resolve HLA allele names the way a clinical immunogenetics lab must: to a specific release, at the requested resolution, honoring G/P group membership, serological equivalents, and the rename/delete history. Ground truth is public reference data; tasks ship without it (see §7).

Non-goals for v0.1: imputation (family B), matching (family C), sequences of any kind, non-human loci.

## 2. Reference data (the only inputs the generator reads)

All from `github.com/ANHIG/IMGTHLA` at a pinned tag (e.g. `v3.65.0-alpha`). Record tag + file `md5checksum.txt` in every task.

| File | Used for |
|---|---|
| `Allelelist.txt` — `AlleleID,Allele` | Universe of valid names in this release; HLA IDs (stable across renames) |
| `Allelelist_history.txt` — `HLA_ID,3650,3640,…,3270` | Name of each HLA ID in every release → renames, first-appearance release, "did this name exist at release R" |
| `Deleted_alleles.txt` — `AlleleID,Allele,Description` | Deleted/renamed names with the human-readable reason and date |
| `Allele_status.txt` — `Allele,Cells,Groups,Confirmed,Start,End,Partial,Type` | Confirmed vs Unconfirmed; full vs partial sequence (used for tiering, never as an answer) |
| `wmda/hla_nom_g.txt` — `locus;allele/allele/…;Ggroup` | G-group membership |
| `wmda/hla_nom_p.txt` — `locus;allele/allele/…;Pgroup` | P-group membership |
| `wmda/rel_dna_ser.txt` — `locus;allele;unambiguous;possible;assumed;expert` | Serological equivalents (WMDA assignment) |
| `wmda/rel_ser_ser.txt` | Broad/split serology relationships |

Loci in scope for v0.1: `A, B, C, DRB1, DRB3, DRB4, DRB5, DQA1, DQB1, DPA1, DPB1`. Everything else (E, F, G, H, MIC, TAP, KIR) excluded.

## 3. Task shape

Every task is one JSON object with two projections: `*.full.json` (grader, holds `answer`) and `*.agent.json` (agent, holds everything except `answer` and `scorer_notes`).

```json
{
  "task_id": "A.T2.0137",
  "family": "hla_nomenclature",
  "tier": 2,
  "subtype": "g_group",
  "reference": {"db": "IPD-IMGT/HLA", "release": "3.65.0", "tag": "v3.65.0-alpha", "md5": "…"},
  "instructions": "Using IPD-IMGT/HLA release 3.65.0, give the G group for the allele below. Respond with JSON: {\"answer\": \"<allele or group>\", \"confidence\": \"high|medium|low\", \"flags\": [..], \"reasoning\": \"...\"}. If the input cannot be resolved, answer \"UNRESOLVABLE\" and say why in flags.",
  "input": {"allele": "A*01:01:01:02N"},
  "answer": {"canonical": "A*01:01:01G", "accept": ["A*01:01:01G"], "expected_confidence": "high", "expected_flags": ["null_allele"]},
  "scorer_notes": {"hla_id": "HLA02169", "source_rows": {"hla_nom_g.txt": 7}}
}
```

Field rules: `input` keys vary by subtype (below). `answer.canonical` is the single correct string; `answer.accept` is the set the grader treats as exact-match correct (normally one element; more when nomenclature legitimately allows equivalent spellings). `expected_flags` are the flags a well-informed agent should raise; graded softly (§GRADER 3.3).

Agent response contract (all subtypes): `{"answer": str, "confidence": "high|medium|low", "flags": [str], "reasoning": str}`. Anything not parseable as this JSON scores 0 with failure mode `malformed_response`.

## 4. Tiers and subtypes

Each subtype is a generator function `gen_<subtype>(ref, rng) -> Task`. Difficulty tiers are properties of the subtype, not a knob.

### Tier 1 — Syntax and field structure (models should get most of these; establishes floor)
| Subtype | Input → expected answer | Notes |
|---|---|---|
| `truncate` | 4-field allele → 2-field | e.g. `A*01:01:01:01` → `A*01:01`. Preserve expression suffix rules: a suffix belongs to the full name; 2-field form drops it unless *all* alleles under that 2-field share it (grader computes). |
| `expand_ambiguity` | Given `B*15:01` and the release, count how many 4-field names fall under it | Integer answer; tests whether the model knows resolution ≠ identity. |
| `valid_name` | Is `DRB1*04:01:01:1` a valid allele name in 3.65.0? | Boolean; inputs mix valid names, near-miss typos (wrong separator count, leading-zero errors like `A*1:01`, deprecated 4-digit form `A*0101`), and never-existed names. |
| `locus_field` | Which locus does `DQB1*02:01:01` belong to; is it class I or II | Trivial floor; catches DRB1/DRB3 and DPA1/DQA1 confusions. |

### Tier 2 — Group resolution
| Subtype | Input → expected answer |
|---|---|
| `g_group` | allele (any resolution) → its G group, or `NONE` if the allele is not in any G group at this release |
| `p_group` | allele → P group (null/non-expressed alleles have no P group → `NONE`; this is a designed trap) |
| `same_group` | two alleles → are they in the same G group / same P group (boolean) |
| `group_members_count` | a G/P group → number of member alleles at this release |
| `serology` | allele → WMDA serological equivalent (`unambiguous` column; if empty, `possible`/`assumed`/`expert` with a required flag `serology_uncertain`) |

### Tier 3 — History (contamination-resistant; ground truth changes every release)
| Subtype | Input → expected answer |
|---|---|
| `renamed_to` | deleted/old name → current name (from `Deleted_alleles.txt` description + `Allelelist_history.txt`), or `DELETED_NO_SUCCESSOR` |
| `existed_at` | allele + release R → did this name exist in release R (boolean) |
| `first_release` | allele → first release in which the name appears |
| `name_at_release` | HLA ID + release R → the name at that release |
| `deleted_reason` | deleted name → categorical reason: `identical_sequence`, `renamed_extended`, `named_in_error`, `low_expression_renamed`, `other` (mapped from `Deleted_alleles.txt` description by regex; the mapping table is part of the grader) |
| `new_in_release` | release R → how many alleles at locus L were added vs R−1 (integer) |

### Tier 4 — Compositional and adversarial
| Subtype | Input → expected answer |
|---|---|
| `resolve_chain` | old name → current name → G group → serology, all in one answer object; graded per step |
| `typing_report_normalize` | a 6-locus typing string in mixed styles (`A*0201`, `A*02:01:01`, `B*44:02:01:01`, `Cw*07`, `DRB1*15:01`) → normalized 2-field report in current nomenclature with a per-locus flag for any deprecated or unresolvable input |
| `null_trap` | ask for the P group of a null allele (`…N`) or expression of a `Q`/`L`/`S` suffix allele — correct answer is `NONE` plus the right flag; tests refusal to fabricate |
| `near_miss` | an allele that does *not* exist but is one field-increment away from one that does (`A*02:1041` when only `A*02:1040:01` exists) → `UNRESOLVABLE` + `flags:["nonexistent_allele"]` |
| `release_drift` | task states release R, input allele was renamed after R → answer must be the name valid *at R*, not the current one |

## 5. Generation rules

- **Seeded and reproducible.** `task_id` = `{family}.{tier}.{subtype}.{seed:04d}`; generator is a pure function of (reference tag, seed).
- **Stratified sampling.** Per subtype, sample alleles uniformly over *loci*, then within locus weight 50% by `Confirmed` status and 50% uniformly, so rare and unconfirmed alleles are over-represented relative to their share (this is where models fail; research-02 §4).
- **Hard slices tagged.** Every task carries `slices: [...]` from {`null_allele`, `expression_suffix`, `unconfirmed`, `partial_sequence`, `renamed_since_3.50`, `added_since_3.60`, `class_II_secondary_locus` (DRB3/4/5, DPA1)}. Reporting is per slice.
- **Counts for v0.1.** T1: 120 (30/subtype). T2: 150 (30/subtype). T3: 180 (30/subtype). T4: 100 (20/subtype). Total 550. Dev split 110 (20%, published), sealed test 440.
- **No duplicates across splits** at the level of (subtype, input allele's HLA ID).
- **Contamination guard.** At least 25% of T3/T4 tasks must involve an allele added or renamed after the most recent frontier-model cutoff known at generation time (record the cutoff assumption in the run manifest). Regenerate the sealed split on every IPD release; the dev split is frozen per benchmark version.

## 6. Versioning

Benchmark version string: `HLA-Bench-A-v{major}.{minor}@IMGT-{release}` (e.g. `HLA-Bench-A-v0.1@IMGT-3.65.0`). `major` bumps on task-shape or grading changes; `minor` on regeneration; `@IMGT` is the pinned release. Every result table cites the full string. Keep a `CHANGELOG.md`.

## 7. What ships and what doesn't (licensing posture, from research-04)

Ships to a customer or the public: generator code, grader code, `*.agent.json` for the dev split, this spec, the run manifest, aggregate results. IPD-IMGT/HLA is CC-BY-ND: the raw files are *fetched by the grader at runtime* from the pinned tag (or from a server-side snapshot we control) and are never redistributed, and no modified copy of the database is written into any shipped artifact. `answer` fields in `*.full.json` are derived facts about single alleles and are kept server-side for the sealed split. Attribution line in every README and manifest: Barker DJ et al., *Nucleic Acids Research* 2025 (IPD-IMGT/HLA).

## 8. Formats

Author once in the JSON above; export via adapters (built in this order): `verifiers` (Prime Intellect; RL buyers), Inspect AI (eval buyers), Harbor/Terminal-Bench (only for `typing_report_normalize`, which has a natural file-in/file-out shape for a terminal task — this is the Terminal-Bench-Science v0.2 candidate, deadline Oct 5).

## 9. Deliverables for Rung 1

1. `sci_envs/reference/imgt.py` — loader for a pinned tag: parses the eight files, exposes `alleles(release)`, `history(hla_id)`, `g_group(allele)`, `p_group(allele)`, `serology(allele)`, `deleted(name)`, `exists_at(name, release)`; caches by tag+md5.
2. `sci_envs/families/nomenclature/generate.py` — the subtype generators and the stratified sampler.
3. `sci_envs/families/nomenclature/grade.py` — per `GRADER_SPEC.md`.
4. `tests/` — for every subtype: a fixed-seed golden task, and a property test that the generator's `answer` is reproducible from the reference alone (i.e. the grader agrees with the generator on its own output at 100%, the Terminal-Bench "oracle must pass" rule).
5. `runs/manifest.json` — tag, md5s, seed range, counts per subtype/slice, cutoff assumption.
6. `bench/HLA-Bench-A.md` — results page skeleton: per-tier, per-subtype, per-slice tables; hallucinated-allele list per model.

Estimated effort: ~20 hours. The reference loader is half of it.
