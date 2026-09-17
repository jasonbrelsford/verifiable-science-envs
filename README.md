# verifiable-science-envs

**Deterministic, executable-oracle RL environments and evaluation suites for clinical genomics — starting with HLA/immunogenetics.**

Every answer is computed from the pinned IPD-IMGT/HLA release's own files. No human labels, no frequency data, no licensed tables — so the grader is auditable line-by-line, the sealed split regenerates on every release, and a model cannot have memorized the post-cutoff tasks.

## The benchmarks

| | Tasks | What it tests | Results |
|---|---:|---|---|
| **HLA-Bench-A** | 550 | Nomenclature: truncation, expression suffixes, G/P groups, serology, rename history, null-allele and near-miss traps | [`bench/HLA-Bench-A.md`](bench/HLA-Bench-A.md) |
| **HLA-Bench-C** | 205 | Donor–recipient matching: 6/6–12/12 frameworks, antigen vs allele level, hidden nulls, GvH/HvG direction, unresolvable typing | [`bench/HLA-Bench-C.md`](bench/HLA-Bench-C.md) |

*Working on this repo? Read [`CLAUDE.md`](CLAUDE.md) first: a push to `main` deploys
production, and the project's status, decisions and runbook live in the private
portfolio hub rather than here.*

Headline findings so far: every model family tested (Claude, Qwen, Mistral, Llama, Phi, Gemma) scores **0% on 2-field ambiguity expansion** (0 of 30 tasks per model on the full 550-task suite), the core clinical trap; models fabricate allele names at **0.06–0.20 per task**, and the `anthropic/claude-sonnet-4-6` figure of 0.09 is a lower bound because 187 of its 550 responses were truncated and graded malformed; on matching, the naive string baseline falls from 28% (family A) to **0%**, and open models reach 0–14% because they count matched loci instead of chromosomes. Full tables with Wilson CIs on the bench pages; current state in the bench pages below.

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/jasonbrelsford/verifiable-science-envs/blob/main/bench/reproduce.ipynb) Every headline figure above is recomputed from the committed run artifacts in
[`bench/reproduce.ipynb`](bench/reproduce.ipynb), which prints the published number next to the
recomputed one with a pass or fail for each claim. It needs no API key and no local checkout.

## HLA-Verify — the graders as an API

The same engine as a verification service (no LLM, no storage): `POST /v1/verify` checks every allele-shaped token in free text against the pinned release (fabricated / deleted-with-successor / legacy / valid, with G groups and flags); `POST /v1/normalize` fixes typing reports; `GET /v1/allele/<name>` returns the facts; `POST /v1/match` scores a donor–recipient pair under the published rules R1–R6.

**Hosted, live: [api.hlaverify.com](https://api.hlaverify.com/docs)** (also `https://hlaverify.com/v1/…`). Open for evaluation at 100 calls a day per IP (60 requests/minute, up to 250 typings per `/v1/normalize` call); keyed access for labs, LIMS vendors and agent platforms with higher daily quotas and larger batches (hello@hlaverify.com). Quotas reset at UTC midnight and every billable response carries `x-hla-verify-daily-limit`, `-daily-remaining` and `-daily-reset`.

```bash
curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' \
  -d '{"text": "A*0101, B*15:504:01, DQB1*05:03:26:99"}'
```

The hosted API is a Cloudflare Worker (`edge/`) that looks names up in tables exported from the pinned release by this repository's Python engine (`python -m sci_envs.service.edge_export`); a golden test (`edge/test/`) proves the Worker's output is byte-identical to the Python service on thousands of generated inputs. Self-hosted Python service:

```bash
pip install -e ".[service]" && uvicorn sci_envs.service.app:app
```

Live demo (runs entirely in your browser — typing data never leaves your machine): **[hlaverify.com/demo](https://hlaverify.com/demo)** · mirrored on Hugging Face: [Spaces/jason-brelsford/hla-verify](https://huggingface.co/spaces/jason-brelsford/hla-verify)

## For AI agents: MCP server

Any MCP-capable agent can add HLA-Verify as a tool server and verify HLA
content before presenting it (`verify_text`, `normalize_allele`, `allele_info`,
`match_score`, `check_typing`, `donor_compat`, `validate_gl_string`, `about`) —
as a remote server, or self-hosted over stdio (every tool except `allele_info`).
The remote server speaks MCP 2026-07-28 (`server/discover`) and the legacy
`initialize` handshake.

Remote (Streamable HTTP, JSON-RPC 2.0, stateless — nothing to install):

```json
{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}
```

Add `"headers": {"Authorization": "Bearer YOUR_KEY"}` for a keyed tier; anonymous
calls share the free tier's 100 calls a day and 60 req/min. Works in Claude Desktop, claude.ai
connectors, Cursor, and any other MCP-capable client.

Local (stdio):

```bash
pip install -e ".[mcp]"
python -m sci_envs.mcp_server        # stdio MCP server
```

Client config: `{"command": "python", "args": ["-m", "sci_envs.mcp_server"]}`.
Also see [`skills/hla-verify/`](skills/hla-verify/) (importable Claude skill) and
[hlaverify.com/llms.txt](https://hlaverify.com/llms.txt).

## Run the benchmark

```bash
pip install -e ".[dev]"
pytest -q                             # first run fetches ~33 MB of reference data
hla-bench generate                    # family A (or --family c); sealed split stays local
hla-bench run baseline-naive-string --suite runs/hla-bench-a --split dev
hla-bench run ollama/qwen2.5:7b --suite runs/hla-bench-a --split dev
hla-bench run anthropic/claude-sonnet-4-6 --suite runs/hla-bench-a --split all
hla-bench report --suite runs/hla-bench-a --out bench/HLA-Bench-A.md
```

Local models run free via Ollama; Anthropic/OpenAI/Gemini clients are included (keys via a gitignored `.env`). Raw responses and per-task scores never leave the machine; only aggregates and a stratified ≤3-per-subtype wrong-answer sample are committed.

## Layout

```
sci_envs/
  reference/imgt.py         # pinned IPD-IMGT/HLA loader: fetch → md5-verify → query
  families/nomenclature/    # family A: generators, grader, normalizer
  families/matching/        # family C: rules engine (R1–R6, documented for lab audit)
  harness/                  # runners, model clients, report
  adapters/                 # verifiers (Prime Intellect) + Inspect AI exports
  service/                  # HLA-Verify API: FastAPI service + edge table exporter (PolyForm-NC)
edge/                       # HLA-Verify API on Cloudflare Workers + golden test vs the Python oracle (PolyForm-NC)
environments/hla_nomenclature/   # pip-installable verifiers environment
harbor/                     # Terminal-Bench-style task
docs/                       # task + grader specs (families A, B, C)
```

## Data strategy & partners

Every graded answer is computed from public, versioned data — the pinned IPD-IMGT/HLA release, synthetic Mendelian truth, and open population resources — so anyone can regenerate the suites and audit every score. Restricted registry data stays with its licensed holders: our environments run on *their* machines. **We are seeking registry, lab, and model-developer partners** — hello@hlaverify.com.

## Licence

Open core: benchmark, generators, graders, harness, and adapters are **Apache-2.0** (LICENSE). The HLA-Verify service (`sci_envs/service/`, `edge/`) is **PolyForm Noncommercial 1.0.0** — free for research and evaluation; commercial use requires a licence from Brelsford Software LLC (hello@hlaverify.com). Reference data are fetched at runtime from IPD-IMGT/HLA under CC-BY-ND (Barker DJ et al., *NAR* 2025) and never redistributed.

Scope: human clinical-genomics informatics only. No sequences, no pathogens, no wet-lab protocols.
