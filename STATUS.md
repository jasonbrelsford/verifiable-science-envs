# Status — verifiable-science-envs

| Field | Value |
|---|---|
| Stage | Public benchmark: HLA-Bench-A (nomenclature, 550 tasks) + HLA-Bench-C (donor–recipient matching, 205 pairs) |
| Reference | IPD-IMGT/HLA 3.65.0 (fetched at runtime, md5-verified — never redistributed; CC-BY-ND) |
| Licence | Apache-2.0, except `sci_envs/service/` under PolyForm Noncommercial 1.0.0 (see NOTICE) |
| Contact | Brelsford Software LLC — hello@hlaverify.com · [hlaverify.com](https://hlaverify.com) · [in-browser demo](https://hlaverify.com/demo) |

## What this is

Deterministic, executable-oracle evaluation environments for clinical genomics.
Every answer is computed from the pinned release's own files — no human labels,
no frequency data, no licensed tables. Full results with confidence intervals:
[`bench/HLA-Bench-A.md`](bench/HLA-Bench-A.md) · [`bench/HLA-Bench-C.md`](bench/HLA-Bench-C.md).

## Headline findings (HLA-Bench-A, all 550 tasks)

| Model | Accuracy [95% CI] | Hallucinated-name tasks |
|---|---:|---:|
| oracle (rules engine) | 100% | 0 |
| claude-sonnet-4-6 | 34.7%* | — |
| qwen2.5:7b | 31% [27–35] | 47 |
| mistral:7b | 29% [26–33] | 76 |
| naive-string baseline | 28% | 0 |
| qwen2.5:3b | 28% [24–32] | 27 |
| gemma3:12b | 28% [25–32] | 80 |
| qwen2.5:14b | 26% [23–30] | 39 |
| phi4-mini | 24% [21–28] | 35 |
| llama3.1:8b | 21% [18–25] | 43 |
| llama3.2:3b | 15% [12–18] | 57 |
| cautious-abstainer baseline | 4% | 0 |

\* lower bound — 187/550 responses were truncated at the original 600-token
budget; the harness now allows 1600 and a clean re-run is queued.

- **Every model family tested scores 0% on `expand_ambiguity`** — none knows
  that a 2-field name covers many full-resolution alleles (true counts 2–389).
  This is the core clinical ambiguity trap, and it is universal across
  Claude, Qwen, Mistral, Llama, Phi, and Gemma.
- A 3B model (15%) scores *below* the naive string-manipulation baseline (28%).
- **Scale does not fix it:** qwen2.5:14b (26%) lands below its own 7B sibling
  and below the string baseline, because it *refuses* 120/550 tasks (22%);
  on the tasks it answers it reaches 33%, no better than 7B — and it is still
  0% on `expand_ambiguity`. It is the best tested model on the null-allele
  trap (90%) and near-miss discrimination (80%).
- Models fabricate allele names at 0.05–0.14 per task: invented 4th fields,
  legacy colon-less forms, made-up G/P group names. The grader verifies every
  emitted name against the release's Allelelist.
- Reasoning models under `format:json` burn their entire token budget thinking
  (deepseek-r1:8b, cancelled); a think-then-parse client is planned.

## Suite facts

- **HLA-Bench-A** (nomenclature): 550 tasks, 20 subtypes, 4 tiers. Dev split
  committed (`runs/hla-bench-a/dev/`); the scored split is sealed and
  regenerated deterministically from (release tag, seed) — it never leaves the
  machine that grades. 32.7% of T3/T4 allele tasks are post-training-cutoff by
  construction (contamination-resistant).
## Headline findings (HLA-Bench-C, all 205 pairs)

| Model | Accuracy [95% CI] |
|---|---:|
| oracle (rules engine) | 100% |
| qwen2.5:14b | 11.7% [8.0–16.8] |
| qwen2.5:7b | 6.3% [3.7–10.6] |
| naive-string baseline | **0%** |
| cautious-abstainer baseline | 0% |

- Unlike nomenclature (family A), a matching verdict **cannot be reached by
  string manipulation** — the naive baseline falls from 28% to 0%.
- qwen2.5:14b (11.7%) nearly doubles 7B, but the entire gain is on the
  simplest counting subtype (60%); it still answers "4/4" for an 8/8 framework
  and "5/6" for 10/10 — wrong denominator, loci not chromosomes — and scores 0%
  on every clinically dangerous slice (null trap, directionality, antigen vs
  allele, resolution-insufficient). 181/205 answers wrong-but-overconfident;
  it never emitted a `potential` verdict.
- qwen2.5:7b counts matched *loci* instead of chromosomes (answers "4/8" when
  4 loci match) and contradicts its own per-locus verdicts. 0% on null-allele
  traps, GvH/HvG directionality, and resolution-insufficient typing — the
  clinically dangerous slices the bench was built to expose.

## Suite construction

- **HLA-Bench-C** (donor–recipient matching): 205 pairs, 8 subtypes, verdicts
  computed by an executable encoding of published matching rules (R1–R6 in
  `sci_envs/families/matching/rules.py`, written to be auditable by a lab
  director). Covers the classic traps: null alleles hiding inside serologic
  matches (A*24:09N), legacy-era typing, broad/split antigens, GvH/HvG
  directionality, resolution-insufficient typing where a confident count is
  itself the error.
- Family B (phasing/imputation) is specified (`docs/TASK_SPEC_FAMILY_B.md`)
  and queued behind a data-licence check.

## Run it

```bash
pip install -e ".[dev]"
hla-bench generate                 # family A (or --family c)
hla-bench run baseline-naive-string --suite runs/hla-bench-a --split dev
hla-bench run ollama/qwen2.5:7b --suite runs/hla-bench-a --split dev
hla-bench report --suite runs/hla-bench-a --out bench/HLA-Bench-A.md
```

Local models run free via Ollama; Anthropic/OpenAI/Gemini clients are included.
Adapters for `verifiers` (Prime Intellect) and Inspect AI are in
`sci_envs/adapters/`.

## Technical decisions log

- Grader treats a valid lower-resolution prefix (e.g. `DRB1*14:06`) as a valid
  name, not a hallucination; nonexistent G/P group strings are
  `fabricated_group`; `refused` suppresses the wrong-answer modes.
- WMDA serology `'0'` means null/no antigen and is an *unambiguous* assignment.
- Deleted-name resolution precedes prefix validity; 2-field names keep an
  expression suffix only when all full-resolution alleles share it; G group is
  AMBIGUOUS when a lower-resolution name spans groups.
- Suite generation is deterministic per task id via sha256-derived seeds
  (Python tuple hashing is process-randomized — a real bug we hit).
- Committed wrong-answer samples are stratified (≤3 per subtype) so every
  subtype's failure shape is auditable without publishing the sealed split.
- gemma3:12b (2026-09-09): the first pass returned 460/550 empty replies after
  Ollama's llama-server crashed under a 131k-token default context on the 8 GB
  card. Harness now pins `num_ctx` (8k), retries empty replies, and never reuses
  empty/errored cache entries; the re-run (0 empties, one backend crash absorbed
  by the retry) is the row in the table: 28% — a tie with the string baseline,
  the highest fabrication rate tested (0.20/task, 80 tasks), 0% on
  `expand_ambiguity` and on the null-allele trap.
- gemma3:12b on family C (2026-09-09): first pass invalid — 199/205 empty
  replies with the server up; probing showed the model emits nothing (or
  `<unused57>` token spam) on the ~800-token matching prompts under Vulkan
  partial offload at the default 512 prompt batch, while a 64-token batch or
  CPU-only inference answers normally. Harness now walks that fallback ladder
  on degenerate replies and records which rung answered; re-run queued.
- Reproducibility (2026-09-09): family C regraded to the identical score
  (13/205) under a third runner configuration (different service account,
  Python 3.14, harness via `python -m`); one raw response of 205 changed form
  at temperature 0 (backend nondeterminism), graded wrong both times.
- Reference loader has zero third-party deps; files fetched at runtime and
  md5-verified against the release's own checksum file.
