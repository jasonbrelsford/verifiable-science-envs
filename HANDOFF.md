# Handoff — HLA-Verify, as of 2026-09-17

Written for another machine (the tower) picking this up. Everything here is checked
against the deployed system, not remembered. **This repository is public**, so the
business, legal, credential and strategy half lives in the private hub — see
[Where the rest is](#where-the-rest-is).

## What this is

A deterministic verification service for HLA nomenclature. No model in the loop: every
verdict is a lookup into tables precomputed from a pinned IPD-IMGT/HLA release (3.65.0).
Sold as an API and an MCP server. The engine and benchmark are Apache-2.0; the hosted
service code is PolyForm Noncommercial.

| Repo | Owns | Visibility |
|---|---|---|
| `verifiable-science-envs` (this one) | engine, benchmark, the API Worker in `edge/`, the stdio MCP server | **public** |
| `hlaverify-website` | hlaverify.com (Worker `hlaverify-landing`), the daily signup digest | private |
| `ventures` → `01-science-envs-private/` | status, decisions, runbook, contracts, launch plan | private |

## What is live right now

- **`https://api.hlaverify.com`** — REST (`/v1/verify`, `/normalize`, `/allele/{name}`,
  `/match`, `/typing/check`, `/compat`, `/glstring`, `/beta-signup`, `/research-access`,
  `/checkout`) and the MCP server at `/mcp`.
- **MCP**: dual-era. The 2026-07-28 revision (stateless, `server/discover`, per-request
  `_meta`, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers validated against the
  body) **and** the legacy `initialize` handshake. **10 tools**, each with input and output
  schemas and annotations. OAuth sign-in is on. Do not drop either era.
- **`https://hlaverify.com`** — the site, deployed from the website repo.
- **MCP Registry**: published as `com.hlaverify/hla-verify` v1.0.1.
- **Discovery**: server card at `/mcp/server-card`; the site serves `/.well-known/ard.json`
  (current spec) and `ai-catalog.json` (predecessor), generated from one source.
- **Free public beta.** Paid tiers exist and are enforced, but self-serve checkout is not
  open yet (see [What is not finished](#what-is-not-finished)).

## Tiers, as enforced in code

| Tier | Calls/day | Typings per batch call | Burst |
|---|---|---|---|
| free (anonymous, no key) | 100 per IP | 250 | 60/min |
| starter ($49/mo) | 500 | 250 | 60/min |
| lab ($299/mo) | 10,000 | 5,000 | 600/min |
| scale ($1,999/mo) | 1,000,000 | 5,000 | 6,000/min |
| enterprise | uncapped | 5,000 | uncapped |

`pro` is a live alias for `lab`. Quotas reset at UTC midnight, counted in a Durable
Object, and **fail open** — a counter outage serves the request uncounted rather than
taking the API down. Every billable response carries `x-hla-verify-daily-*` headers.

## Deploys fire on push. There is no staging.

- **This repo**: a push to `main` touching `edge/src/**`, `edge/wrangler.jsonc`,
  `sci_envs/service/edge_export.py` or `.github/workflows/edge-deploy.yml` **deploys
  production**. The workflow then smoke-tests the live REST API *and* the live MCP endpoint
  (modern `server/discover`, a modern `tools/call`, a legacy `initialize`).
- **Website repo**: every push to `main` builds, deploys and smoke-tests every page plus
  `hlaverify.com/v1/verify`. `public/` is committed; CI fails if it is stale.
- Always branch, open a PR, wait for CI, merge. Never push to `main`.
- Concurrent merges can race: an older commit's deploy can finish last. After merging,
  confirm production matches `main`; if not, re-run the deploy workflow.

## How to test before merging

```bash
python -m sci_envs.service.edge_export      # ~45s, writes the gitignored edge/public tables
cd edge && node --test                      # 207 tests as of 2026-09-17
pytest -q                                   # 139 passed, 2 skipped (needs .[dev,service,mcp])
npx wrangler@4 dev --local --port <free>    # then exercise the change
node <path>/mcpclient/probe.mjs http://127.0.0.1:<port>/mcp
```

`probe.mjs` connects with the official `@modelcontextprotocol/client` in `auto`,
pinned-`2026-07-28` and `legacy` modes. Expect three lines and ten tools. It is the
fastest proof the MCP server still works.

Use **one venv per checkout**. An editable install points at a single directory, so a
shared venv silently tests the wrong code.

## Things that will bite you

Each of these cost real time to find.

- **Pull before you reason.** A stale checkout has produced confident, wrong work from at
  least three agents — one described tiers that no longer existed.
- **Cloudflare sends every matching `_headers` CSP rule and browsers enforce all of them.**
  The site therefore has no `/*` policy: `build.py` writes one per route. A blanket policy
  silently breaks `/demo`, `/product`, `/beta` and `/research`.
- **Cloudflare returns 403 to the default `Python-urllib` user agent.** A script that
  fetches the API without a named UA degrades to "skipped" and looks green forever.
- **`workers.dev` is production under another name**, not staging. It is off. Use
  `wrangler versions upload` for a per-version preview URL, or `wrangler dev` locally.
- **The `KEYS` KV namespace mixes API keys, Stripe records, OAuth markers, the beta list
  and research applications.** A `beta/` record was once presentable as an API key at a
  paid tier. `authorizeKey()` now refuses reserved prefixes. **If you add a prefix, check
  the same class of bug and test it.**
- **Anonymous quota subjects are hashed with `QUOTA_IP_SALT`.** Without the salt a per-day
  digest over IPv4 is brute-forceable, so an absent salt fails open rather than counting
  under a guessable name.
- **`MAX_TEXT` is 200,000 and is a published contract** in the OpenAPI, the MCP schema and
  the self-hosted service. A cap is not a privacy control; do not shrink it as one.
- **Ask for allele strings, never patient identifiers.** That is in the tool schemas, the
  docs, the terms and the privacy policy. Do not add PHI detection or redaction — it would
  imply a compliance guarantee the service does not make.
- **The published pages are claims with legal weight.** Before writing that the service
  does something, find it in `edge/src/`. Several published claims have already had to be
  retracted; see the claims audit in the private hub.
- **Git identity.** Commits were being authored under a work email; history was rewritten
  on 2026-09-17 and every SHA from 2026-09-15 onward changed. Check `git config user.email`
  before committing, and **re-clone rather than reusing an old checkout**.

## What is not finished

1. **Self-serve checkout is not open.** `/pricing` renders from Stripe when the Worker can
   read prices; today its key cannot, so the page serves fallback prices with no buy
   buttons and `POST /v1/checkout` returns 503 naming the email path. Installing a
   restricted Stripe key switches it on within ~10 minutes with no deploy.
2. **Research access approvals are manual** by design: `scripts/research_access.py list |
   show | approve`. Approval mints a single-use Stripe promotion code.
3. **Per-key release pinning does not exist.** One release is compiled into the Worker.
   It is on the roadmap and marked as such; do not let it creep back into copy as shipped.
4. **No customer-visible usage report.** Counts are metered to Analytics Engine; nothing
   exposes them.
5. **No uptime commitment**, because there is no availability measurement.
6. **`/api` on the site documents 4 of the 9 `/v1/*` routes** and still says "three
   endpoints".
7. **`api.hlaverify.com` serves only the predecessor discovery path** and its catalog entry
   lacks required ARD fields. The site repo is already fixed; the API is not.
8. **Compatibility scoring may become a separate product** (drug manufacturers and
   research, sold and disclaimed differently). Until that is decided, keep the current
   framing: computing a published rule, not determining suitability.

## Conventions

- Branch, PR, green CI, merge, then verify production. Report what you verified live versus
  locally, and never claim a deploy succeeded without checking.
- No new npm dependencies in the Worker: CI and the deploy never run `npm install`.
- Preserve each file's line endings; several are CRLF.
- Plain voice in prose and copy. No marketing adjectives.
- **Never put business material in this repo** — pipeline, prospects, pricing negotiations,
  internal status. It was moved out on 2026-09-16 and `docs/README.md` says where it went.
- End commits with the co-author line the session is given.

## Where the rest is

The private hub `jasonbrelsford/ventures`, under `01-science-envs-private/`:

| File | What it holds |
|---|---|
| `HANDOFF-PRIVATE.md` | the companion to this file: accounts, credentials, what is pending |
| `STATUS-internal.md` | where the project stands, what is waiting on Jason |
| `DECISIONS-2026-09.md` | what was decided and **why** — read before reversing anything |
| `RUNBOOK-infra.md` | deploy triggers, proxy traps, Cloudflare gotchas |
| `LAUNCH-CHECKLIST.md` | the parked promotion list and its gates |
| `legal/` | MSA, order form, DPA, security questionnaire, attorney brief, claims audit |
| `from-public-repo/` | the sales and status material moved out of this repo |

If you cannot reach that repo, ask Jason (hello@hlaverify.com) rather than guessing at
intent. Nothing external has been posted, submitted or announced anywhere yet; that is
deliberate and waits on his go-live signal.
