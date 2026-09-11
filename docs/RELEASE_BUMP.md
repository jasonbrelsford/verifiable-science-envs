# IPD-IMGT/HLA release-bump runbook

*Prepared 2026-09-11. Procedure only — no code changes here. Run this the next time
IPD-IMGT/HLA cuts a new release (currently pinned: `v3.65.0-alpha`, ~46,652 alleles,
roughly 600 added per quarter). Nothing in this doc touches secrets, Stripe, or
`wrangler deploy` directly — the only release action an agent takes is editing pinned
tag strings, regenerating fixtures, and pushing to `main`, which triggers the existing
`edge-deploy.yml` / `cloudflare.yml` workflows.*

## 0. Before starting

- Confirm the new tag exists on the upstream mirror: check
  `https://github.com/ANHIG/IMGTHLA/releases` (or `git ls-remote --tags
  https://github.com/ANHIG/IMGTHLA` if network access allows) for the new `vX.YY.Z-alpha`
  tag. `sci_envs/reference/imgt.py`'s `ImgtReference.load()` fetches eight files from that
  exact tag over `raw.githubusercontent.com` and verifies them against the release's own
  `md5checksum.txt` — a typo'd or nonexistent tag fails loudly at fetch time, it does not
  silently pin the old data.
- Read `docs/TASK_SPEC.md` §2 and §9.1 for what the loader assumes about file shape; a
  release that changes file layout (rare) needs a code change, not just a tag bump.

## 1. Find every place the tag is pinned

The tag string (e.g. `v3.65.0-alpha`, cache key `imgt-v3.65.0-alpha`) is hardcoded as a
default in several places rather than read from one shared constant. Before editing,
enumerate the current occurrences so nothing is missed:

```bash
grep -rln 'v3\.65\.0-alpha\|imgt-v3\.65' --include='*.py' --include='*.yml' \
  --include='*.md' --include='*.mjs' . | grep -v node_modules
```

As of this writing that lists (grouped by what actually needs to change on a bump):

**Runtime defaults — must change, these decide what the live service serves:**
- `sci_envs/service/app.py` — `TAG = os.environ.get("HLA_VERIFY_TAG", "v3.65.0-alpha")`
- `sci_envs/service/edge_export.py` — `--tag` default (also reads `HLA_VERIFY_TAG` env)
- `sci_envs/mcp_server.py` — `TAG = "v3.65.0-alpha"`
- `sci_envs/adapters/common.py`, `sci_envs/adapters/inspect_task.py`,
  `sci_envs/adapters/verifiers_env.py`, `sci_envs/harness/run.py` — `tag: str =
  "v3.65.0-alpha"` default parameters
- `edge/test/gen_fixtures.py` — `r = ImgtReference.load("v3.65.0-alpha")` (explicit, not a
  default — must be edited by hand)

**CI/CD cache keys — should change (a stale key just means a slower fetch, not a wrong
result, since the loader re-verifies checksums either way, but a fresh key avoids serving
a partially-cached old release during the transition):**
- `.github/workflows/ci.yml`, `.github/workflows/edge-deploy.yml`,
  `.github/workflows/bench.yml` — `key: imgt-v3.65.0-alpha` under the `actions/cache@v4`
  step for `~/.cache/sci_envs/imgt`

**Docs/results that describe a specific past release — do NOT bump, these are historical
records of what was measured under the old release and stay pinned:**
- `bench/HLA-Bench-A.md`, `bench/HLA-Bench-C.md`, `docs/pyard-concordance.md`,
  `docs/PRIOR_ART.md`, `docs/paper/hla-bench-draft.md` — leave as-is; a new release gets a
  new results run and a new dated entry, not an edit to old numbers.
- `harbor/**` — the Harbor task/solution fixtures are frozen to the release they were
  authored against; check `harbor/README.md` before touching anything there — it may be
  intentionally version-locked for reproducibility of a specific published task.
- `tests/test_*.py` — most assert against the pinned release's actual data (allele counts,
  specific names). These SHOULD be re-run after the bump (see step 3) but only edited if
  they fail — do not pre-emptively change expected values without seeing a real diff.
- `skills/hla-verify/SKILL.md`, `docs/TASK_SPEC.md` — check by hand; likely descriptive
  prose mentioning the release number rather than a pinned default, update if so.

## 2. Bump the tag

1. Edit the five runtime-default locations above to the new tag string (keep the
   `-alpha` suffix pattern IPD/IMGT uses if the new release keeps it — verify against the
   actual tag name on the mirror, don't assume).
2. Update the three CI cache keys to `imgt-v<new>`.
3. Update `edge/test/gen_fixtures.py`'s explicit `ImgtReference.load(...)` call.

## 3. Regenerate and verify

From the repo root:

```bash
pip install -e ".[dev,service]"
pytest -q                                   # full suite against the new release; expect
                                             # some allele-count / specific-name assertions
                                             # to need updating — that is expected, not a bug
python -m sci_envs.service.edge_export      # regenerates edge/public/data shards
python edge/test/gen_fixtures.py            # regenerates edge/test/fixtures.json
cd edge && node --test test/golden.test.mjs # Worker output must stay byte-identical
                                             # to the Python oracle on the new release
```

Only proceed to commit if all three pass. If `pytest -q` fails on assertions that
hardcode the old release's specific allele counts or names, update those expected values
to match the new release's actual data (verified from the loader's own output, never
guessed), re-run, and only then continue.

## 4. Regenerate benchmark results (separate from the API bump)

The hosted API and the benchmark suites are decoupled: bumping the API's pinned tag does
not by itself regenerate `bench/HLA-Bench-A.md` / `-C.md`. A new benchmark run against
the new release is its own next-agent-action (see project (c) in `docs/PROJECTS.md`) —
queue it via `.tower-queue.json` for local Ollama models (free) or a manual `bench.yml`
dispatch for API-keyed models (costs money, human-triggered only). Do not conflate the
two: a quarterly release bump alone only needs steps 1-3 above.

## 5. Commit and push

```bash
git add -A
git commit -m "release: bump pinned IPD-IMGT/HLA release to v<new>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

Pushing to `main` with changes under `edge/src/**`, `edge/wrangler.jsonc`, or
`sci_envs/service/edge_export.py` triggers `edge-deploy.yml`, which re-runs
`edge_export`, the golden test, and `wrangler deploy` itself — this is the only deploy
path; do not run `wrangler deploy` locally.

## 6. Customer notice (drafted, never sent)

Keyed customers are told in the product docs that they "get a diff of changed verdicts
before each quarterly pin move" (see `docs/sales/TARGETS.md`'s product-facts note). After
step 3 produces a clean diff, draft — but do not send — a short notice using this
template. Sending is human-only (see `docs/PROJECTS.md` "Waiting on Jason" for the
Gmail-drafts workflow); an agent's job here stops at leaving the drafted text in a file
or a Gmail draft, never at clicking send.

```
Subject: HLA-Verify: IPD-IMGT/HLA release v<new> now live (verdict diff attached)

Hi [Name],

HLA-Verify's pinned reference release moved from v<old> to v<new> on <date>. This
release adds roughly <N> new allele names and may change the verdict for names that
were previously valid-prefix, deleted, or hallucinated.

Attached / linked: a diff of every verdict that changed for names your account has
queried in the last 90 days (or, if no per-account query log is kept, a general
before/after diff of the full allele table).

No action is needed unless your ingest pipeline hardcodes expected verdicts for
specific names — in that case, re-run your test names against
https://api.hlaverify.com/v1/normalize before your next report cycle.

— HLA-Verify (Brelsford Software LLC)
```

Fill in `<old>`, `<new>`, `<date>`, `<N>` from the actual bump, and either attach a real
diff (compute one by running the Python oracle against both tags and diffing per-name
verdicts — not yet scripted; a follow-on action) or state plainly that a full diff was
not computed this cycle, rather than fabricating numbers.
