# GRADER_SPEC — Family A: HLA Allele Nomenclature Resolution

*v0.1 · August 30, 2026 · Companion to `TASK_SPEC.md`. The grader is pure, deterministic Python with no model in the loop. It must reproduce the generator's own answers at exactly 100% (oracle rule) before any model is run.*

## 1. Contract

```python
def grade(task_full: dict, response: dict, ref: ImgtReference) -> Score
```

`Score`:
```json
{
  "task_id": "A.T2.g_group.0137",
  "correct": true,                 // primary: exact-match on canonical answer (bool)
  "partial": 1.0,                  // 0..1 for compositional subtypes; == correct for atomic ones
  "confidence_stated": "high",
  "confidence_expected": "high",
  "calibrated": true,              // stated rank <= expected rank
  "flags_expected": ["null_allele"],
  "flags_raised": ["null_allele"],
  "flags_missed": [], "flags_spurious": [],
  "hallucinated_names": [],        // allele-like strings in the answer that do not exist at the pinned release
  "failure_modes": ["clean_correct"],
  "grader_version": "A-0.1",
  "reference": {"release": "3.65.0", "md5": "..."}
}
```

The grader loads the reference from the pinned tag recorded in `task_full.reference`. Grading a task against a different release than it was generated from is an error, not a score.

## 2. Normalization before comparison (applied to the agent's `answer` string)

Applied identically to `answer.accept` at generation time, so both sides are canonical:

1. Strip whitespace; uppercase locus; keep `HLA-` prefix optional (`HLA-A*01:01` ≡ `A*01:01`).
2. Reject legacy 4-digit form (`A*0101`) — it is *not* normalized to `A*01:01`; a lab would not accept it. It counts as `wrong` with failure mode `legacy_nomenclature`.
3. Expression suffixes (`N`, `L`, `S`, `C`, `A`, `Q`) are significant and case-sensitive.
4. Group answers must carry the `G`/`P` suffix (`A*01:01:01G`, `A*01:01P`); a bare allele where a group was asked is `wrong`, failure mode `resolution_mismatch`.
5. Sentinels are exact: `NONE`, `UNRESOLVABLE`, `DELETED_NO_SUCCESSOR`, `TRUE`/`FALSE` (case-insensitive for booleans only), integers as digits.
6. Nothing else is forgiven. No fuzzy match, no Levenshtein, no "close enough" — the whole point of this family is that near-misses are wrong.

## 3. Scoring rules

### 3.1 Correctness
`correct = normalize(answer) in task.answer.accept`. For `resolve_chain` and `typing_report_normalize`, the answer is an object; `partial` = fraction of steps/loci exactly correct and `correct` = (partial == 1.0). A single fabricated allele anywhere in a compositional answer caps `partial` at 0.5 (see 3.4).

### 3.2 Calibration
Ranks `low=0, medium=1, high=2`. `calibrated = rank(stated) <= rank(expected)`. Over-confidence is the penalized direction; under-confidence is tolerated (carried over from the prototype's rule; it matches clinical risk). `expected_confidence` is set by the generator: `high` for T1/T2 unless the task is in a hard slice, `medium` for T3 and any `unconfirmed`/`partial_sequence` slice, `low` only for `serology` with no unambiguous assignment and for `release_drift`.

### 3.3 Flags (soft)
`flags_missed = expected − raised`, `flags_spurious = raised − expected`. Flags never change `correct`; they feed failure modes and the per-slice report. Recognized flag vocabulary (anything else is ignored, not spurious): `null_allele`, `expression_suffix`, `deprecated_name`, `nonexistent_allele`, `serology_uncertain`, `release_mismatch`, `ambiguous_input`, `unconfirmed_allele`.

### 3.4 Hallucination check (the headline metric)
Extract every token matching the allele grammar `^(HLA-)?[A-Z0-9]+\*\d{2,}(:\d{2,}){0,3}[NLSCAQ]?$` from `answer` **and** `reasoning`. Any token not present in `Allelelist.txt` at the pinned release and not in `Deleted_alleles.txt` is a **hallucinated name**. Tokens in `Deleted_alleles.txt` are counted separately as `deprecated_names_used`. Group names are checked against `hla_nom_g/p.txt`. This is reported per model as an absolute count and as a rate per task, and is the number that goes at the top of the benchmark page.

### 3.5 Failure modes (exactly one primary, plus any secondaries)
| Mode | Condition |
|---|---|
| `clean_correct` | correct, calibrated, no missed/spurious flags, no hallucinated names |
| `correct_but_overconfident` | correct, not calibrated |
| `correct_with_hallucinated_reasoning` | correct, but a hallucinated name appears in `reasoning` |
| `wrong_but_overconfident` | not correct, stated `high` |
| `wrong_calibrated` | not correct, stated `medium`/`low` with a relevant flag |
| `hallucinated_answer` | the answer itself is a nonexistent name |
| `legacy_nomenclature` | answer uses 4-digit or `Cw`-style legacy form |
| `resolution_mismatch` | right allele family, wrong field count or missing G/P suffix |
| `fabricated_group` | a P group given for a null allele, or a G/P group that doesn't exist |
| `missed_ambiguity` | expected flag not raised |
| `false_positive_flag` | flag raised with no basis (only for flags in the vocabulary) |
| `refused` | answered `UNRESOLVABLE` when a resolution existed |
| `malformed_response` | not parseable per the response contract |

Primary mode precedence: `malformed_response` > `hallucinated_answer` > `fabricated_group` > `legacy_nomenclature` > `resolution_mismatch` > `wrong_but_overconfident` > `wrong_calibrated` > `refused` > `correct_but_overconfident` > `correct_with_hallucinated_reasoning` > `clean_correct`.

## 4. Aggregation and reporting

For each model run produce `results.json` and a rendered table with:
- Accuracy per tier, per subtype, per slice (with Wilson 95% CI; n is small per cell).
- Hallucinated-name count and rate per model; the top-20 most common hallucinated names (these are the quotable ones).
- Calibration: fraction calibrated; a 3×3 confusion of stated vs expected confidence.
- Failure-mode histogram.
- `release_drift` and `near_miss` reported separately as the "contamination-resistant" subset.

Never report a single scalar as the headline. The per-slice table is the product.

## 5. Oracle and regression tests

- **Oracle:** for every generated task, `grade(task, {"answer": task.answer.canonical, "confidence": task.answer.expected_confidence, "flags": task.answer.expected_flags, "reasoning": ""})` must return `correct=True`, `calibrated=True`, `failure_modes=["clean_correct"]`. CI fails otherwise.
- **Anti-oracle:** for a sample of tasks, grading a random *other* valid allele must return `correct=False` and never `hallucinated_answer` (valid names are not hallucinations).
- **Sentinel tests:** null-allele P group → `NONE` correct; a P group string for a null allele → `fabricated_group`.
- **Legacy test:** `A*0101` for a `truncate` task → `legacy_nomenclature`, `correct=False`.
- **Release pin test:** grading a 3.65.0 task with a 3.64.0 reference raises.

## 6. Adapters (thin; no logic)

- `verifiers`: reward = `1.0 if correct else 0.0`, with `partial` as a secondary reward for compositional subtypes; expose `hallucinated_names` count as an info field.
- Inspect AI: `Task` with a custom `scorer` that returns `CORRECT/INCORRECT` plus metadata; group by `tier`, `subtype`, `slices`.
- Harbor (for `typing_report_normalize` only): input file `typing.txt`, expected output `normalized.json`, pytest compares via this grader.

## 7. Why these rules (one paragraph, for the benchmark page)

Clinical HLA nomenclature is a place where "almost right" is wrong: `A*02:01` and `A*02:01:01:02N` have different clinical meanings, `A*0201` is a 2010-era form no accredited lab accepts, and a P group assigned to a null allele is a fabrication. This grader therefore uses exact match, treats fabricated names as the primary error, and reports by slice so that the rare-allele and post-cutoff cases — where models are weakest and where clinical risk concentrates — are visible instead of averaged away.
