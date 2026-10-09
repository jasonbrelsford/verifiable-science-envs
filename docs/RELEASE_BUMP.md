# IPD-IMGT/HLA release-bump runbook

*Prepared 2026-09-11; rehearsed end to end against the current pin on 2026-10-05 (issue
#74) and corrected from what the rehearsal found. Procedure only — no code changes here.
Run this the next time IPD-IMGT/HLA cuts a new release (currently pinned:
`v3.65.0-alpha`, 46,652 alleles; 3.64.0 → 3.65.0 added 672 names and removed 25).
Nothing in this doc touches secrets, Stripe, or `wrangler deploy` directly — the only
release action an agent takes is editing pinned tag strings, regenerating fixtures, and
merging a PR into `main`, which triggers the existing `edge-deploy.yml` workflow.*

**Rehearsal wall time (2026-10-05, cloud sandbox):** fresh fetch + md5 verify 3 s;
`edge_export` 35 s; `gen_fixtures.py` 131 s; `node --test` 8 s; `pytest -q` 60 s;
`release_diff.py` 3 s; bench suite regeneration 3 s (A) and 9 s (C). About five minutes of
compute; the rest of a bump is editing pins and reading diffs. Every regeneration step is
deterministic — run twice against the same tag it produces byte-identical output — so
any diff you see after a bump is the release, not noise.

## 0. Before starting

- Confirm the new tag exists on the upstream mirror:
  `git ls-remote --tags https://github.com/ANHIG/IMGTHLA | grep -o 'v3\.[0-9]*\.[0-9]-alpha' | sort -u | tail -3`
  (works from the sandbox; `https://github.com/ANHIG/IMGTHLA/releases` in a browser is the
  fallback). IPD-IMGT/HLA tags are `vX.YY.Z-alpha`; verify the suffix on the real tag rather
  than assuming it.
- `sci_envs/reference/imgt.py`'s `ImgtReference.load()` fetches **ten** files from that
  exact tag over `raw.githubusercontent.com` — eight data files (`Allelelist.txt`,
  `Allelelist_history.txt`, `Allele_status.txt`, `Deleted_alleles.txt`,
  `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`)
  plus the two `md5checksum.txt` files it verifies them against (~32 MB). A typo'd or
  nonexistent tag fails loudly at fetch time; it does not silently pin the old data. To
  prove the new tag fetches and verifies before editing anything:

  ```bash
  python -c "from sci_envs.reference.imgt import ImgtReference as R; r=R.load('v3.66.0-alpha'); print(r.release, len(r.alleles()))"
  ```

  (The default cache is `~/.cache/sci_envs/imgt/<tag>/`; pass `cache_dir=` to fetch into a
  scratch directory instead.)
- Read `docs/TASK_SPEC.md` §2 and §9.1 for what the loader assumes about file shape; a
  release that changes file layout (rare) needs a code change, not just a tag bump.
- Run the verdict diff first (step 6's script) — it is the quickest read of how big the
  release is, and it needs no code change:
  `python scripts/release_diff.py v3.65.0-alpha v3.66.0-alpha --out /tmp/verdict-diff.md --json /tmp/verdict-diff.json`

## 1. Find every place the tag is pinned

The tag string (e.g. `v3.65.0-alpha`, cache key `imgt-v3.65.0-alpha`) and the release
number (`3.65.0`) are hardcoded as defaults in several places rather than read from one
shared constant. Before editing, enumerate the current occurrences so nothing is missed —
include html, js and txt, which the original grep did not:

```bash
grep -rln 'v3\.65\.0-alpha\|imgt-v3\.65\|3\.65\.0' --include='*.py' --include='*.yml' \
  --include='*.md' --include='*.mjs' --include='*.js' --include='*.html' --include='*.txt' . \
  | grep -v 'node_modules\|^./edge/public\|^./runs/'
```

As of the 2026-10-05 rehearsal that lists the following (grouped by what actually needs
to change on a bump):

**Runtime defaults — must change, these decide what the live service serves:**
- `sci_envs/service/edge_export.py` — `--tag` default (also reads `HLA_VERIFY_TAG`). **This
  is the one that moves api.hlaverify.com**: the Worker (`edge/src/**`) carries no pin of
  its own; it reads `manifest.release` from the tables this script exports.
- `sci_envs/service/app.py` — `TAG = os.environ.get("HLA_VERIFY_TAG", "v3.65.0-alpha")`
  (the Python oracle and the self-hosted service)
- `sci_envs/mcp_server.py` — `TAG = "v3.65.0-alpha"` (stdio MCP server)
- `sci_envs/adapters/common.py`, `sci_envs/adapters/inspect_task.py`,
  `sci_envs/adapters/verifiers_env.py` — `tag: str = "v3.65.0-alpha"` default parameters
- `sci_envs/harness/run.py` — three `--tag` defaults (`generate`, `run`, `auto`)
- `sci_envs/families/nomenclature/generate.py` — `__main__` default tag
- `edge/test/gen_fixtures.py` — `r = ImgtReference.load("v3.65.0-alpha")` (explicit, not a
  default — must be edited by hand)

**CI/CD cache keys — should change (a stale key just means a slower fetch, not a wrong
result, since the loader re-verifies checksums either way, but a fresh key avoids serving
a partially-cached old release during the transition):**
- `.github/workflows/ci.yml` (two steps), `.github/workflows/edge-deploy.yml`,
  `.github/workflows/bench.yml` — `key: imgt-v3.65.0-alpha` under the `actions/cache@v4`
  step for `~/.cache/sci_envs/imgt`

**Public copy in this repo that states the release — update in the same PR:**
- `README.md` — release number and allele count where they appear
- `assets/llms.txt` — mirrored by the website's drift check, see step 7
- `assets/demo.template.html` — `const TAG = "v3.65.0-alpha"` and the footer "Release
  pinned: IPD-IMGT/HLA 3.65.0" (the browser demo fetches the reference files itself, from
  this tag); `assets/landing.html` and `assets/product.html` quote the allele count
- `skills/hla-verify/SKILL.md` — two `ImgtReference.load("v3.65.0-alpha")` examples
- `docs/TASK_SPEC.md` — descriptive prose and the example task JSON; the benchmark version
  string `HLA-Bench-A-v0.1@IMGT-3.65.0` there belongs to the bench, see step 4

**Tests — re-run, edit only on a real failure:**
- `tests/test_*.py` — twelve files assert against the pinned release's actual data (allele
  counts, specific names, `release == "3.65.0"`). Re-run them after the bump (step 3) and
  only edit the expected values that fail, from the loader's own output, never guessed.

**Docs/results that describe a specific past release — do NOT bump, these are historical
records of what was measured under the old release and stay pinned:**
- `bench/HLA-Bench-A.md`, `bench/HLA-Bench-C.md`, `docs/pyard-concordance.md`,
  `docs/research-rel_dna_ser-3.65.md`, `docs/paper/hla-bench-draft.md` — leave as-is; a
  new release gets a new results run and a new dated entry, not an edit to old numbers.
- `scripts/pyard_concordance.py` — `REF_TAG, PYARD_VER` are a matched pair (py-ard's own
  data build); it is a dated comparison, not a runtime default.
- `scripts/train_grpo_modal.py` — training run, pinned to what it was trained on.
- `scripts/release_diff.py` — the tag strings there are usage examples only.
- `harbor/**` (`solution/solve.py`, `tests/build_truth.py`, `README.md`) — the Harbor
  task is frozen to the release it was authored against (`build_truth.py` asserts
  `release == "3.65.0"`), and `tests/test_harbor.py` loads `v3.65.0-alpha` explicitly, so
  it keeps passing after a bump (CI fetches the old release again under the new cache
  key, ~3 s). The exception: `harbor/*/solution/imgt.py` and `harbor/*/tests/imgt.py`
  must stay byte-identical to `sci_envs/reference/imgt.py` (that same test asserts it),
  so if a bump ever needs a loader change, copy the file to both places.
- `runs/hla-bench-a/**`, `runs/hla-bench-c/**` — the committed bench suites, see step 4.

## 2. Bump the tag

1. Edit the runtime-default locations above to the new tag string (keep the `-alpha`
   suffix pattern IPD/IMGT uses if the new release keeps it — verify against the actual
   tag name on the mirror, don't assume).
2. Update the four CI cache keys to `imgt-v<new>`.
3. Update `edge/test/gen_fixtures.py`'s explicit `ImgtReference.load(...)` call.
4. Update the public copy in this repo (README, `assets/llms.txt`, the demo template,
   `skills/hla-verify/SKILL.md`, `docs/TASK_SPEC.md` prose) to the new release number and
   the new allele count from step 0's `len(r.alleles())`.

## 3. Regenerate and verify

From the repo root, in a venv for this checkout (`pip install -e ".[dev,service]"`):

```bash
python -m sci_envs.service.edge_export      # ~35 s; regenerates the gitignored edge/public
                                             # tables from the new tag (the Worker's release
                                             # comes from here)
python edge/test/gen_fixtures.py            # ~130 s; regenerates edge/test/fixtures.json
                                             # from the Python oracle
cd edge && node --test && cd ..             # the whole Worker suite, not only golden.test.mjs:
                                             # docs-tools and unmet tests read the same data;
                                             # Worker output must stay byte-identical to the
                                             # oracle on the new release
pytest -q                                   # ~60 s; expect some allele-count / specific-name
                                             # assertions to need updating — that is expected,
                                             # not a bug
```

Only proceed to commit if all of them pass. If `pytest -q` fails on assertions that
hardcode the old release's specific allele counts or names, update those expected values
to match the new release's actual data (verified from the loader's own output, never
guessed), re-run, and only then continue. Skips for missing optional extras
(`verifiers`, `inspect_ai`, `mcp`) are normal in a `[dev,service]` venv; a skip anywhere
else is not.

The `edge_export` output lists ~2,156 skipped `DPB1*1000`-style names; that is the
expected five-digit-legacy exclusion, not a bump problem.

## 4. The benchmark is decoupled — do not regenerate it in the bump PR

The hosted API and the benchmark suites are decoupled: bumping the API's pinned tag does
not regenerate `runs/hla-bench-a/`, `runs/hla-bench-c/` or `bench/HLA-Bench-*.md`.

The committed suites (the `dev/` splits and `manifest.json`; the sealed `full/` split is
gitignored and never leaves the machine) are generated from the pinned tag by
`python -m sci_envs.harness.run generate --family a|c --tag v3.65.0-alpha` and the
rehearsal confirmed regeneration against the current tag is byte-identical. Against a
new tag the task ids, answers and the version string (`HLA-Bench-A-v0.1@IMGT-3.65.0`)
all change, which is a new benchmark revision with no published results — **that is
Jason's call, not part of the quarterly API bump.** Leave `runs/`, `bench/` and the
`@IMGT-3.65.0` strings alone; if a new bench revision is wanted, it is its own PR plus a
results run (`.tower-queue.json` for local Ollama models, a manual `bench.yml` dispatch
for API-keyed models — costs money, human-triggered only).

## 5. Branch, PR, merge

Never push to `main`. Commit as Jason Brelsford <jason.brelsford@gmail.com> with no
trailers:

```bash
git checkout -b work/<issue>-release-v<new>
git status --short                           # every line must be a file from step 1 or 2,
                                             # plus edge/test/fixtures.json; anything else
                                             # (a stray .env, .dev.vars, scratch output) stays out
git add sci_envs/service/edge_export.py sci_envs/service/app.py sci_envs/mcp_server.py \
        sci_envs/adapters/common.py sci_envs/adapters/inspect_task.py sci_envs/adapters/verifiers_env.py \
        sci_envs/harness/run.py sci_envs/families/nomenclature/generate.py \
        edge/test/gen_fixtures.py edge/test/fixtures.json \
        .github/workflows/ci.yml .github/workflows/edge-deploy.yml .github/workflows/bench.yml \
        README.md assets/llms.txt assets/demo.template.html assets/landing.html assets/product.html \
        skills/hla-verify/SKILL.md docs/TASK_SPEC.md
git add tests/<only the test files you edited in step 3>
git diff --cached --stat                     # fixtures.json is ~3.5 MB and is meant to be committed;
                                             # never stage with `git add -A` or `git add .` in this
                                             # public repo — stage the paths you changed, by name
git commit -m "release: bump pinned IPD-IMGT/HLA release to v<new>"
git push origin work/<issue>-release-v<new>
```

Open the PR (body: the issue, old → new tag, allele count delta from step 0's diff, the
test counts), let `edge`, `test` and `oracle` go green, then merge. Merging to `main`
with changes under `edge/src/**`, `edge/wrangler.jsonc`, `sci_envs/service/edge_export.py`
or `.github/workflows/edge-deploy.yml` triggers `edge-deploy.yml`, which re-runs
`edge_export`, the golden test and `wrangler deploy` itself, then smoke-tests the live
REST and MCP endpoints — this is the only deploy path; do not run `wrangler deploy`
locally. Because `edge_export.py`'s default changes in every bump, the deploy always
fires.

After the deploy: `GET https://api.hlaverify.com/healthz` (`uptime_s` near 0 means the
new build is serving) and `GET /v1/allele/<a name added in the new release>` from
`/tmp/verdict-diff.md` should return `status: valid` with `"release": "<new>"`.

## 6. Customer notice (drafted, never sent)

Keyed customers are told in the product docs that they "get a diff of changed verdicts
before each quarterly pin move" (see the product-facts note in the private hub). After
step 3 is green, draft — but do not send — a short notice using this template. Sending
is human-only (see the private hub's waiting-on list for the Gmail-drafts workflow); an
agent's job here stops at leaving the drafted text in a file or a Gmail draft, never at
clicking send.

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

Fill in `<old>`, `<new>`, `<date>`, `<N>` from the actual bump, and attach the real diff
from step 0:

```bash
python scripts/release_diff.py v<old> v<new> --out /tmp/verdict-diff.md --json /tmp/verdict-diff.json
```

This loads both pinned releases (same cached/md5-verified fetch as everything else) and
diffs the full allele table: names newly assigned (verdict `hallucinated`/`valid`-prefix
-> `valid`), names removed (verdict `valid` -> `deleted`, with successor when the release
records a rename), by locus. Rehearsed on 3.64.0 → 3.65.0: 672 added, 25 deleted, 1
renamed (`DQA1*05:54:02Q` -> `DQA1*05:149Q`), 3 s. No per-account query log is kept, so
this table-level diff *is* "a general before/after diff of the full allele table" per the
paragraph above — use its `added_count`/`deleted_count`/`added_by_locus` for `<N>` and
the notice body, and link or attach the rendered markdown. Only fall back to "a full diff
was not computed this cycle" if the script itself fails on the new tag (e.g. a
file-layout change — see step 0).

## 7. The website is a second PR, after the API deploy

hlaverify.com is deployed from `jasonbrelsford/hlaverify-website`, not from here, and it
states the release in its own copy. Its CI checks `src/llms.txt` against the *live* MCP
tool list, so open this PR only after step 5's deploy is verified. In that repo's `src/`:

- `llms.txt` (release number, twice)
- `standalone/demo.template.html` — `const TAG` and the footer, same as this repo's
  `assets/demo.template.html`
- `standalone/product.html`, `pages/beta.html`, `pages/index.html`,
  `pages/how-it-works.html` — release number and allele count
- `pages/api.html` and `pages/index.html` — the sample responses' `"release": "3.65.0"`

Leave `HLA-Bench-A-v0.1@IMGT-3.65.0` on the benchmark pages alone (step 4). Then
`python3 build.py && python3 check_links.py`, commit the rebuilt `public/`, PR, merge; a
push to `main` deploys and smoke-tests every page. `build.py`'s `ENGINE_REF` pins the
engine commit the browser demo bundles — bump it to the merged release commit so the demo
runs the same code the API does.
