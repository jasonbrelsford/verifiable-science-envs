# Handoff — HLA-Verify, as of 2026-10-05

Written for anyone — a person, or an agent on another machine — picking this up. First
written 2026-09-17; refreshed 2026-10-05 against `main` and the deployed system. Trust
the dated statements only as of that date; everything moves. **This repository is
public**, so the business, legal, credential and strategy half lives in the private hub —
see [Where the rest is](#where-the-rest-is).

## What this is

A deterministic verification service for HLA nomenclature. No model in the loop: every
verdict is a lookup into tables precomputed from a pinned IPD-IMGT/HLA release (3.65.0).
Sold as an API and an MCP server. The engine and benchmark are Apache-2.0; the hosted
service code is PolyForm Noncommercial.

| Repo | Owns | Visibility |
|---|---|---|
| `verifiable-science-envs` (this one) | engine, benchmark, the API Worker in `edge/`, the stdio MCP server | **public** |
| `hlaverify-website` | hlaverify.com (Worker `hlaverify-landing`), the daily signup digest | private |
| `ventures` → `01-science-envs-private/` | status, decisions, runbook, contracts, launch plan, evaluations | private |

## What is live right now

- **`https://api.hlaverify.com`** — REST (`/v1/verify`, `/normalize`, `/allele/{name}`,
  `/match`, `/typing/check`, `/compat`, `/glstring`, `/usage`, `/beta-signup`,
  `/research-access`, `/checkout`) and the MCP server at `/mcp`.
- **MCP**: dual-era. The 2026-07-28 revision (stateless, `server/discover`, per-request
  `_meta`, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers validated against the
  body) **and** the legacy `initialize` handshake. **10 tools**, each with input and output
  schemas and annotations. OAuth sign-in is on. Do not drop either era.
- **`https://hlaverify.com`** — the site, deployed from the website repo.
- **MCP Registry**: published as `com.hlaverify/hla-verify` v1.0.1 (`server.json`).
- **Discovery**: server card at `/mcp/server-card` (also `/.well-known/mcp/server-card.json`);
  both the API and the site serve `/.well-known/ard.json` (current spec) and
  `/.well-known/ai-catalog.json` (predecessor), generated from one source each.
- **Usage**: `GET /v1/usage` gives a keyed caller its own call volume (today / 7d / 30d, by
  endpoint and status); `/admin/usage` is the operator dashboard behind `ADMIN_TOKEN`, and
  includes the unmet-requests report — counts of request shapes the service could not
  fully serve, ranked by how many callers ask. Both need Analytics Engine read access
  configured or they answer 503.
- **Checkout**: self-serve, through Stripe, live since 2026-09-28 (the go-live test is
  recorded in the private hub). `/pricing` renders live prices with Subscribe buttons and
  `POST /v1/checkout` creates a Checkout Session. If `/pricing` ever shows the email path
  instead, the Worker's Stripe key has lost price-read access — see `RUNBOOK-infra.md`.
  The anonymous tier stays free.

## Tiers, as enforced in code (`edge/src/keys.js`)

| Tier | Calls/day | Typings per batch call | Burst |
|---|---|---|---|
| free (anonymous, no key) | 100 per IP | 250 | 60/min |
| starter ($49/mo) | 500 | 250 | 60/min |
| lab ($299/mo) | 10,000 | 5,000 | 600/min |
| scale ($1,999/mo) | 1,000,000 | 5,000 | 6,000/min |
| enterprise | uncapped | 5,000 | uncapped |
| academic (hand-issued, never sold) | 10,000 | 5,000 | 600/min |

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
  confirm production matches `main` (`/healthz` reports `uptime_s`; near 0 means the new
  build is serving); if not, re-run the deploy workflow.

## How to test before merging

```bash
python -m sci_envs.service.edge_export      # ~45s, writes the gitignored edge/public tables
cd edge && node --test                      # 261 tests as of 2026-10-05, incl. golden parity with the Python oracle
pytest -q                                   # 173 passed, 3 skipped as of 2026-10-05 (needs .[dev,service,mcp])
npx wrangler@4 dev --local --port <free>    # then exercise the change
node <path>/mcpclient/probe.mjs http://127.0.0.1:<port>/mcp
```

`probe.mjs` connects with the official `@modelcontextprotocol/client` in `auto`,
pinned-`2026-07-28` and `legacy` modes. Expect three lines and ten tools. It is the
fastest proof the MCP server still works.

Golden parity between the Python oracle (`sci_envs/`) and the Worker
(`edge/src/engine.js`) is enforced by `edge/test/golden.test.mjs` over
`edge/test/fixtures.json`, generated by `edge/test/gen_fixtures.py`. A behaviour change
lands in **both** implementations plus the fixture generator, in one PR.

Use **one venv per checkout**. An editable install points at a single directory, so a
shared venv silently tests the wrong code.

## Things that will bite you

Each of these cost real time to find.

- **Pull before you reason.** A stale checkout has produced confident, wrong work from at
  least three agents — one described tiers that no longer existed. This file is not
  exempt: check its dated claims against `main` before acting on them.
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
- **Every accepted input shape that is not a plain allele name leaves a flag**, so nothing
  is converted silently (the `HLA-` prefix, XX codes, lg notation, G/P groups, MAC codes
  and KIR names all follow this pattern — see `edge/src/engine.js`,
  `sci_envs/families/nomenclature/normalize.py` and `edge/src/unmet.js`). A new acceptance
  also retires its class from the unmet counters.
- **The published pages are claims with legal weight.** Before writing that the service
  does something, find it in `edge/src/`. The claims audit in the private hub is the
  record of what the pages may say.
- **Git identity.** Commits on this repo are authored as
  `Jason Brelsford <jason.brelsford@gmail.com>`. Check `git config user.email` before
  committing.

## Who else is working here

Scheduled Claude tasks run against this repo and the website repo around the clock; a
human picking this up should expect their footprints and leave them intact:

- **find work** (hourly) keeps a ranked queue of GitHub issues labeled `work-queue` on this
  repo, and files `needs-jason` issues for anything only Jason can decide.
- **do the work** (hourly) takes the top `work-queue` issue, posts "Taking this — run
  started …" on it, ships it on a `work/<issue>-<slug>` branch, merges within the gate
  below, verifies the deploy, closes the issue. A "Taking this" comment under 3 hours old,
  or an open PR referencing the issue, means it is owned — do not duplicate it.
- **evaluate** (hourly) exercises the live API and writes evaluations to
  `ventures/01-science-envs-private/evals/`. It relies on the free tier's 100 calls a
  day, so do not burn the anonymous quota with scripted probes.
- **merge green PRs** (hourly) sweeps every open PR on both repos and merges the ones that
  are green, mergeable, authored in-repo and inside the gate: nothing touching secrets,
  `wrangler.jsonc`, Stripe or pricing code or copy, `keys.js` tier limits, the privacy or
  terms pages, LICENSE/NOTICE, or the patient-data language; no test skipped or weakened;
  reversible by a plain revert. It leaves drafts and anything with a commit under 30
  minutes old alone, and explains a refusal in a "Merge check:" comment plus the
  `needs-jason` label. Mark a PR as a draft, or label it `hold`, to keep it out.

## What is not finished

1. **The site lags the API on checkout.** `hlaverify.com/pricing` and `/beta` still
   describe self-serve checkout as not open and point at the email path, while
   `api.hlaverify.com/pricing` sells. Fix the site, not the API.
2. **Research access approvals are manual** by design: `scripts/research_access.py list |
   show | approve`. Approval mints a single-use Stripe promotion code.
3. **Per-key release pinning does not exist.** One release is compiled into the Worker.
   It is on the roadmap and marked as such; do not let it creep back into copy as shipped.
4. **Usage is visible but not billed from.** `GET /v1/usage` and `/admin/usage` read
   Analytics Engine; Stripe meters nothing from them. Invoices follow the subscription,
   not the counts.
5. **No uptime commitment.** `uptime.yml` pings the API from GitHub Actions; that is a
   check, not an availability measurement, so nothing promises an SLA. `probe.yml` is the
   deeper read-only check (documents' release fields, a 14-name allele panel, fixed
   `/v1/verify` and `/v1/normalize` strings, the site's pages): dispatch it and read the
   `probe.json` log group of the run it starts, which is how the scheduled tasks see the
   live service from a sandbox that cannot reach it.
6. **Endpoint coverage on the site is complete except for one route.** `/api` documents
   every `/v1/*` route including the Lab Toolkit (`typing/check`, `compat`, `glstring`;
   site PR #26) and no longer quotes a count; `llms.txt` lists all nine routes (site PR
   #28). The one route `/api` leaves out is `POST /v1/research-access`, which is
   documented on `/research` and in `llms.txt` instead — deliberate, not a gap to fill.
7. **The MAC-code table is an NMDP dependency** and the privacy switch for anonymous
   buckets (`UNMET_ANON_BUCKETS`) is Jason's decision; neither is a queue item.
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
- Commit as `Jason Brelsford <jason.brelsford@gmail.com>`, with **no** `Co-Authored-By`
  or "Generated with" trailers.
- When the API's contract changes (inputs, statuses, flags, tools), update in the same PR:
  `edge/src/docs.js` (the `/docs` page and OpenAPI), `edge/src/mcp.js` tool descriptions
  and output schemas, `README.md`, and `docs/GRADER_SPEC.md` where it describes the rule;
  then the site (`src/llms.txt`, `src/pages/api.html`, `how-it-works.html`) as a second PR
  — its CI checks `llms.txt` against the live MCP tool list, so merge the API first.

## Where the rest is

The private hub `jasonbrelsford/ventures`, under `01-science-envs-private/`:

| File | What it holds |
|---|---|
| `HANDOFF-PRIVATE.md` | the companion to this file: accounts, credentials, what is pending |
| `STATUS-internal.md` | where the project stands, what is waiting on Jason, the work-queue log |
| `DECISIONS-2026-09.md` | what was decided and **why** — read before reversing anything |
| `RUNBOOK-infra.md` | deploy triggers, proxy traps, Cloudflare gotchas |
| `LAUNCH-CHECKLIST.md` | the parked promotion list and its gates |
| `from-public-repo/PROJECTS.md` | the board: what is next, what waits on a human |
| `evals/` | the evaluate task's reports on the live service |
| `legal/` | MSA, order form, DPA, security questionnaire, attorney brief, claims audit |
| `from-public-repo/` | the sales and status material moved out of this repo |

If you cannot reach that repo, ask Jason (hello@hlaverify.com) rather than guessing at
intent. Launch and promotion are gated by `LAUNCH-CHECKLIST.md`; nothing is announced or
submitted from this repo.
