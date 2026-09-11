# HLA-Verify integration brief

*For lab IT leads and LIMS or caller product managers. One page. 2026-09-10. Full
reference: https://api.hlaverify.com/docs, OpenAPI: https://api.hlaverify.com/openapi.json.*

## What it is

A deterministic HTTP API that checks HLA allele names and donor-recipient match claims
against a pinned IPD-IMGT/HLA release (currently 3.65.0, 46,652 named alleles). No
language model anywhere. Same input plus same release gives the same JSON every time.
Every response carries the release tag and the attribution line.

Base URL `https://api.hlaverify.com` (also `https://hlaverify.com/v1/…`). Open without a
key at 60 requests per minute per IP. Keyed access (`X-API-Key: …` or
`Authorization: Bearer …`) removes the per-minute cap, adds per-key usage reporting, and
sends a diff of changed verdicts before each quarterly release. Starter/Pro keys are
self-serve at https://api.hlaverify.com/pricing (Stripe checkout, key issued within
seconds); enterprise keys and volume licensing: hello@hlaverify.com.

## Where it plugs into a typing pipeline

| Where | Call | Gate on |
|---|---|---|
| Typing report ingest (LIMS, HistoTrac/TIMS exports, PDF-to-text) | `/v1/normalize` per reported allele | `nonexistent_allele` reject; `deprecated_name` rewrite to `current_name` and log |
| Any LLM or agent output that mentions HLA | `/v1/verify` on the text | `clean == false` block or annotate before display |
| Search / match reports | `/v1/match` per pair | Compare with the lab's count; any `potential` or `null_allele*` flag routes to human review |
| Registry / data-warehouse QC | `/v1/normalize` in batches of up to 5,000 | Diff `reported` vs `current_name` per release |

## Endpoints and examples (copied from the API reference)

**POST /v1/verify.** Classifies every allele-shaped token as `valid`, `group` (G/P),
`deleted` (with successor), `fabricated_group`, or `hallucinated`. `clean` is true only
when nothing is fabricated, deleted, or a made-up group. Text up to 200,000 characters.

```
curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' \
  -d '{"text": "Patient typing: A*0101, B*15:504:01, DRB1*14:06. Assistant suggested DQB1*05:03:26:99 (DQB1*05:03:01G)."}'
```
```
{"release":"3.65.0","clean":false,
 "counts":{"valid":2,"deleted":1,"group":1,"fabricated_group":0,"hallucinated":1},
 "tokens":[{"token":"A*0101","status":"deleted","successor":"A*01:01:01:01","current_2field":"A*01:01",
            "g_group":"AMBIGUOUS","flags":["deprecated_name"],"note":"was assigned once, no longer current — see successor"},
           {"token":"DQB1*05:03:26:99","status":"hallucinated","note":"no such name in any release back to 1.05.0 — fabricated"}, …],
 "attribution":"Computed from IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Res 2025), …"}
```

**POST /v1/normalize.** Any era in, current release out: `current_name`, comparable
2-field name, G group (`NONE` / `AMBIGUOUS`), flags (`deprecated_name`, `null_allele`,
`nonexistent_allele`). Up to 5,000 typings per call.

```
curl -s https://api.hlaverify.com/v1/normalize -H 'content-type: application/json' \
  -d '{"typings": ["A*0101", "A*01:34N", "DRB1*1406", "A*24:09N", "B*9999"]}'
```

**GET /v1/allele/{name}.** `assigned` (G/P group, first release, confirmed status, WMDA
serology, null flag), `valid_prefix` (member count and sample), or `deleted` (successor).
404 for anything not in the release.

```
curl -s 'https://api.hlaverify.com/v1/allele/A*24:09N'
```

**POST /v1/match.** Two reported alleles per locus, any era. Frameworks `6/6`, `8/8`,
`10/10`, `12/12`, `antigen`. Counts per chromosome, not per locus; GvH and HvG reported
separately; a locus too coarse to call is `potential` and excluded from the denominator
with `resolution_insufficient`; a null hiding inside a serologic match raises
`null_allele_mismatch`. Rules R1-R6 are published for lab audit.

```
curl -s https://api.hlaverify.com/v1/match -H 'content-type: application/json' -d '{
  "framework": "8/8",
  "recipient": {"A": ["A*02:01", "A*24:02"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]},
  "donor":     {"A": ["A*02:01", "A*24:09N"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]}}'
```
```
{"release":"3.65.0","framework":"8/8","count":"7/8",
 "verdicts":{"A":"mismatch","B":"match","C":"match","DRB1":"match"},
 "hvg_mismatches":1,"gvh_mismatches":1,"flags":["null_allele"], "attribution":"…"}
```

**GET /healthz** returns `{"ok":true,"release":"3.65.0","alleles":46652,"uptime_s":…}`.
Errors are JSON `{"detail": "…"}`: 400 malformed JSON, 401 bad key, 404 unknown name or
route, 415 wrong content type, 422 invalid input, 429 anonymous rate limit, 500 (nothing
stored).

## Latency and availability expectations

- Edge-hosted: the service runs on Cloudflare's edge worldwide, so requests are served
  from a location near the caller rather than from one region. Measure from your own
  network with `curl -w '%{time_total}\n' https://api.hlaverify.com/healthz`; no formal
  SLA is published yet, and keyed customers should ask for one in the licence.
- Deterministic: no model inference, no per-request variance in output; responses depend
  only on input and release.
- Release-pinned: the pin moves quarterly with IPD-IMGT/HLA. Keyed customers receive the
  verdict diff first and can hold an older release on request. `/healthz` reports the
  live release, so a pipeline can assert on it.
- Anonymous callers hit 429 above 60 requests/minute per IP; plan on a key for
  anything beyond evaluation.

## Security posture

- Nothing stored: requests are processed in memory and discarded.
- Counts-only metering: per-key request counts, never content.
- API keys via `X-API-Key` or bearer header; TLS on every endpoint.
- No LLM, no third-party calls on the request path.
- Reference data fetched from the official IPD-IMGT/HLA source (CC-BY-ND), md5-verified
  against the release's own checksum file, never redistributed.
- Send de-identified data only. HLA-Verify is a research-and-evaluation tool and not a
  medical device; output supports and does not replace clinical judgement.

## Self-hosted option

The same engine that computed the benchmark tables runs without HTTP:

```
pip install "verifiable-science-envs @ git+https://github.com/jasonbrelsford/verifiable-science-envs"
from sci_envs.families.nomenclature.normalize import normalize
from sci_envs.families.matching.rules import score
```

Or run the service locally: `pip install -e ".[service]" && uvicorn sci_envs.service.app:app`.
Reference data are fetched once at runtime (about 33 MB) and md5-verified. Data never
leaves your machines. For AI agents there is an MCP server
(`python -m sci_envs.mcp_server`, tools `verify_text`, `normalize_allele`, `match_score`)
and an in-browser demo at https://hlaverify.com/demo that runs entirely client-side.

Licence: the service code is PolyForm Noncommercial 1.0.0; research and evaluation are
free, commercial use requires a licence from Brelsford Software LLC (from $15k/yr; a $12k
six-week pilot is credited to the first year). Benchmark, generators, graders, and harness
are Apache-2.0. Contact: hello@hlaverify.com.
