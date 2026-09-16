# Working in this repository

## This repo is public

The engine, benchmark, Worker source and technical docs belong here. Business material
does not: pipeline, prospect names, pricing negotiations, launch copy, internal status and
IP memos live in the private portfolio hub, `jasonbrelsford/ventures`, under
`01-science-envs-private/`. They were moved out of here on 2026-09-16 because this
repository is readable by anyone, including the organisations they discuss. Do not add
them back. See `docs/README.md`.

## Read the private context first

If you have access to `jasonbrelsford/ventures`, read these before changing anything:

| File (in `01-science-envs-private/`) | What it gives you |
|---|---|
| `STATUS-internal.md` | Where the project stands, and what is waiting on Jason |
| `DECISIONS-2026-09.md` | What was decided and **why** — do not reverse a decision without reading its reasoning |
| `RUNBOOK-infra.md` | Deploy triggers, proxy traps, Cloudflare gotchas, how to test |
| `LAUNCH-CHECKLIST.md` | The parked promotion list and the gates before it |

Without that access, ask Jason (hello@hlaverify.com) rather than guessing at intent.

## Things that will bite you

- **A push to `main` deploys production.** Touching `edge/src/**`, `edge/wrangler.jsonc`,
  `sci_envs/service/edge_export.py` or `.github/workflows/edge-deploy.yml` deploys
  api.hlaverify.com. There is no staging. Branch, open a PR, let CI pass, then merge.
- **Test before you merge**: `python -m sci_envs.service.edge_export` (writes the gitignored
  `edge/public` tables, ~45s), then `cd edge && node --test`, then `pytest -q`. Use a venv
  per checkout — an editable install points at one directory, so a shared venv tests the
  wrong code.
- **The MCP server is dual-era**: MCP 2026-07-28 (stateless, `server/discover`) *and* the
  legacy `initialize` handshake. Do not drop either. Tool descriptions and schemas are the
  only pitch an agent ever reads, so treat their wording as product, not comments.
- **Never invite patient data.** Tools ask for allele names, typing strings, GL strings and
  HLA report text, with identifiers removed first. The service is nomenclature and
  reference-release validation, not clinical decision support. "Decision support only; not
  a medical device" stays scoped to `donor_compat`.
- **The `KEYS` KV namespace mixes API keys, Stripe records, OAuth markers and the beta
  list.** A `beta/` record was once presentable as an API key at a paid tier. If you add a
  prefix there, check the same class of bug.
- **hlaverify.com is deployed from `jasonbrelsford/hlaverify-website`**, not from here.
  This repo's `cloudflare.yml` is manual-only and configures DNS and email routing only.
- **Check `gh auth status` before pushing.** Jason's Mac has both a personal and a work
  GitHub account authenticated, and it has switched on its own mid-session.
