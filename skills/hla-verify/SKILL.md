---
name: hla-verify
description: Verify HLA allele names, typing strings, and donor-recipient match claims against the pinned IPD-IMGT/HLA release using deterministic rules — no LLM guessing. Use whenever output mentions HLA alleles (A*02:01, DRB1*15:01, legacy forms like A*0201), typing reports, G/P groups, serologic equivalents, or match counts (8/8, 10/10), to catch fabricated names, deleted alleles, legacy-era strings, and null-allele traps before they reach a document.
---

# HLA-Verify

LLMs fabricate HLA allele names at a measured 0.05–0.14 per task and score 0% on
2-field ambiguity across every model family tested (see bench/HLA-Bench-A.md in
this repository). Never present an HLA allele name, normalized typing, or match
verdict from model memory. Verify it.

## Setup (once per environment)

```bash
pip install -e ".[dev]"     # from this repository's root
python -c "from sci_envs.reference.imgt import ImgtReference; ImgtReference.load('v3.65.0-alpha')"
```

The second line fetches and md5-verifies the reference files (~33 MB, cached in
`~/.cache/sci_envs/`). Requires network to github.com on first run only.

## Verify allele names and typing strings

```python
from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize

ref = ImgtReference.load("v3.65.0-alpha")
result = normalize(ref, "A*0201")     # any reported name, any era
# result: allele_2field, g_group, p_group, serology, flags
# flags tell you: legacy_format, deleted_name (with successor), fabricated, ...
```

A name that normalizes to `UNRESOLVABLE` with no recognized legacy form is
fabricated — do not use it, and say so.

## Verify a donor-recipient match claim

```python
from sci_envs.families.matching.rules import score

s = score(ref, "8/8", recipient_typing, donor_typing)
# s["count"]  e.g. "7/8" — or "UNRESOLVABLE" when typing is too coarse to call
# s["verdicts"], s["hvg_mismatches"], s["gvh_mismatches"], s["flags"]
```

Rules R1–R6 are documented in `sci_envs/families/matching/rules.py` for audit.
Respect the `potential` verdict: when the engine says the typing cannot be
resolved, a confident count is wrong by definition — report `potential` and the
`resolution_insufficient` flag rather than a number.

## Or use the hosted service

Live, no install: `https://api.hlaverify.com` (reference at /docs, OpenAPI at
/openapi.json; open at 60 requests/minute, header `X-API-Key` for keyed access).
`POST /v1/verify {"text"}`, `POST /v1/normalize {"typings"}`, `GET /v1/allele/{name}`,
`POST /v1/match {"framework","recipient","donor"}`. Same verdicts as the Python engine
(golden-tested). Local API: `pip install -e ".[service]" && uvicorn sci_envs.service.app:app`.

## Rules

- Every allele name in your output must have passed `normalize` without a
  `fabricated` flag, at the release you state.
- Always report the release version alongside verdicts (facts change per release).
- Null alleles (suffix N) are never antigen matches, whatever serology suggests.
- This is a research-and-evaluation tool, not a medical device; verification
  output supports and does not replace clinical judgment.
