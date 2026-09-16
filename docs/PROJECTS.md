# Project board — HLA-Verify / HLA-Bench and related ventures

*Read this file first, every session. It is the single source of truth for what to work on
and what is blocked. Written 2026-09-11.*

## How this board works

- **Statuses** used throughout: `TODO` (not started), `IN PROGRESS`, `BLOCKED-HUMAN`
  (needs Jason or the overseer; see "Waiting on Jason"), `DONE` (in a done log).
- **The one rule:** anything tagged `HUMAN` or listed under a project's "blocked on human"
  is Jason's or the overseer's to do. Everything else on this board is agent-owned — pick
  it up and do it without asking. Agents never wait on Jason for anything not explicitly
  listed here.
- **Recording progress:** when you finish a next-agent-action, move it to that project's
  "done log" with today's date (keep the 5 most recent, drop the oldest), and add any
  follow-on action it revealed to "next agent actions." If you hit something only a human
  can do, add it to that project's "blocked on human" list AND to the top-level "Waiting on
  Jason" list below (numbered list is regenerated from the union of all projects' blocked
  items — see `docs/ROUTINE.md`).
- **The daily routine's job** (`docs/ROUTINE.md`, run "VP standup"): read this file, do a
  capped number of the top unblocked next-agent-actions with the smallest model that can,
  run tests, commit with the required co-author line, push to `main` (which deploys via
  `edge-deploy.yml` / `cloudflare.yml`), update this file, regenerate "Waiting on Jason,"
  and leave Jason a short note only if something new needs him. It never touches secrets,
  payments, or sends mail.

---

## Waiting on Jason

## Latest note to Jason (2026-09-16)

Nothing urgent. Three small, safe things shipped today: a draft
`docs/legal/TERMS_OF_SERVICE.md` for hlaverify.com (tiers, the "stores nothing" data
handling, the PolyForm/Apache-2.0 licence boundary, a not-a-medical-device liability
limit, governing-law placeholder) — it's a draft for counsel, not published anywhere; a
competing-interests statement and a CC-BY licence note added to the preprint draft's
metadata section, verbatim from the checklist; and a check of the uptime workflow's actual
run history (11/11 scheduled checks succeeded since it shipped, zero real failures, so its
issue-open/close code has never fired for real). Two new low-priority items on the numbered
list below: #13, whether you want a deliberate test of that uptime workflow (it would create
a real, visible GitHub issue on the repo, so this routine won't trigger that on its own);
and #14, this cloud session has no pandoc/TeX toolchain installed, so the preprint's
PDF-conversion step needs either your own machine or a future session with that toolchain.
Neither is blocking anything else. Everything else below is unchanged from before.

*Numbered, prioritized, copy-paste-ready. Ordered: credential exposure first, then
revenue-blocking, then legal/compliance, then everything else.*

1. **Rotate the exposed GitHub PAT now.** A broad classic personal access token was pasted
   into a chat session on 2026-09-10. Go to https://github.com/settings/tokens, find it, and
   click Revoke. If anything of yours locally uses it (`git credential-manager`, `gh auth
   status`), replace it with a fine-grained token scoped only to this repo with the minimum
   permissions (contents: read/write is enough for what agents push; no admin, no other
   repos). Also glance at https://github.com/settings/security-log for any activity you
   don't recognize between 2026-09-10 and today.
2. **Rotate the Stripe sandbox secret key to a restricted key.** In the Stripe dashboard
   (test mode) go to Developers -> API keys -> Create restricted key, grant only "Checkout
   Sessions: Read" and "Customers: Write," then run:
   ```
   cd edge
   wrangler secret put STRIPE_SECRET_KEY
   ```
   and paste the new restricted test key when prompted. No code change needed.
3. **Activate Stripe live mode and set the live secrets.** This is the one item blocking
   real revenue.
   - In the Stripe dashboard, complete live-mode activation (business details, bank
     account) for the HLA-Verify brand's own Stripe account (one account per brand, per
     your own rule — do not reuse Spin Renta's account).
   - Create a live webhook endpoint pointing to `https://api.hlaverify.com/webhooks/stripe`
     and copy its signing secret, then run from the repo root:
     ```
     cd edge
     wrangler secret put STRIPE_WEBHOOK_SECRET
     wrangler secret put STRIPE_SECRET_KEY
     ```
     pasting the live webhook signing secret and a live **restricted** key (Checkout
     Sessions read, Customers write) respectively.
   - Tell the overseer once both secrets are set; it then re-runs its idempotent Stripe
     setup script to create the live products, payment links, and price-to-tier map (agents
     cannot do this themselves — it needs the live secret to exist first).
4. **Trademark filing decision for HLA-VERIFY.** Read `docs/TRADEMARK.md`. Decide: (a) file
   now on the Principal Register, standard-character word mark, Nice classes 42 and 44,
   1(a) use-in-commerce basis (~$700 USPTO fee for 2 classes, self-filed; add $500-1,500 if
   you retain counsel — budget $700-2,200 total), or (b) wait. Recommendation in the memo is
   to file now. If you approve, either file pro se at
   https://www.uspto.gov/trademarks/apply or engage a trademark attorney; an agent cannot
   file or pay on your behalf.
5. **Create an ORCID and a bioRxiv account, then submit the preprint.** Read
   `docs/PREPRINT_CHECKLIST.md`. Register free at https://orcid.org (2 minutes), then create
   a bioRxiv account at https://biorxiv.org with jason.brelsford@gmail.com or
   hello@hlaverify.com. Agents can prepare the PDF and metadata; only you can create the
   accounts and click submit.
6. **Minnesota assumed-name (DBA) filings.** Confirm which brands operate as a DBA under
   which legal entity (Brelsford Software LLC for HLA-Verify at minimum; check Headwaters
   Genetics and Spin Renta / Minnesota Rentals too) and file each assumed name with the
   Minnesota Secretary of State (https://mblsportal.sos.state.mn.us, ~$50/name, renews every
   10 years). An agent can draft the filing text; you or the overseer must submit and pay.
7. **Review and send outreach drafts.** Agents will prepare cold-outreach emails as Gmail
   drafts (see `docs/sales/PIPELINE.md`) — they never send. Check your Gmail Drafts folder
   periodically and send (or edit and send) the ones you approve; that is the entire
   human-in-the-loop step for go-to-market.
8. **Post the prepared launch content.** `docs/launch/posts.md` has six ready-to-post pieces
   (Hacker News, r/bioinformatics, LinkedIn, X thread, r/MachineLearning, r/LocalLLaMA),
   drafted 2026-09-08 and fact-checked as still accurate as of today. Agents draft and
   fact-check; posting under your own accounts, in your own voice, is yours to do whenever
   you have time — no deadline, nothing else is blocked on it.
9. **Headwaters Genetics and Spin Renta starting info.** These have stub charters below
   (projects e and f) because this session has no repo or account access for them. When you
   have a few minutes, answer the "ask Jason" questions in each stub so an agent can start
   real work there.
10. **Trigger (or standing-approve) the clean claude-sonnet-4-6 re-run.** Low priority. Go to
    the repo's Actions tab -> `bench` workflow -> Run workflow, with `models = anthropic/
    claude-sonnet-4-6` and `split = test` (or `all`); this spends your Anthropic API key, so
    no agent triggers it on its own. Confirmed the free `.tower-queue.json` path only ever
    dispatches local Ollama models and cannot carry this one. Once it lands, the `*`
    lower-bound caveat on the claude-sonnet-4-6 row in `STATUS.md` and the preprint draft
    can be removed.
11. **Enable the Gmail connector in-chat for the scheduled VP-standup session.** Low
    priority, but it is the only thing standing between the go-to-market track and actually
    drafting outreach emails. The connector shows as installed and authenticated
    (`installState: connected`) but `enabledInChat: false` for this scheduled session, so
    go-to-market action #1 (draft the top-10 day-0 emails) falls through every run. Whenever
    you want outreach drafting to start, enable the Gmail connector for this session/agent
    in your claude.ai connector settings; no code or repo change needed.
12. **Create a Cloudflare Analytics Engine read token for a future `/v1/usage` endpoint.**
    Low priority. The Worker already writes per-request metering to the `USAGE` Analytics
    Engine dataset (`edge/src/index.js` / `stripe.js`), but that binding is write-only —
    there is no way to query it back from inside the Worker. Reading it needs Cloudflare's
    separate Analytics Engine SQL API, which needs its own API token created in the
    Cloudflare dashboard and stored via `wrangler secret put` — an agent cannot create
    secrets under this routine's rules, so a usage-visibility endpoint (platform action)
    stays parked until you do this once.
13. **Decide whether to test the uptime workflow's failure/recovery path for real.** Low
    priority. `.github/workflows/uptime.yml` has run cleanly 11/11 times since 2026-09-14
    (per Actions history) and no `uptime`-labeled issue has ever been opened, so the
    issue-open/comment/close code has never actually fired. Confirming it works means either
    (a) waiting for a genuine outage, or (b) a deliberate `workflow_dispatch` test that
    temporarily points the check at a URL that will fail, which will create a real, publicly
    visible GitHub issue on the repo — this routine treats that as "posting" and won't do it
    without your go-ahead. If you want it tested now, say so and an agent can run it and
    clean up the test issue afterward.
14. **Preprint PDF conversion needs a pandoc/TeX toolchain.** Low priority, not blocking
    anything (submission itself still waits on your ORCID/bioRxiv account, #5). This cloud
    session checked and has neither `pandoc` nor `xelatex`/`pdflatex` installed, so it
    can't run the conversion command in `docs/PREPRINT_CHECKLIST.md` step 2. Either run that
    command yourself locally once you have pandoc + a TeX distribution, or mention it and a
    future session can try installing the toolchain if one supports that.

---

## (a) HLA-Verify platform

**Goal:** keep the hosted API/MCP service (api.hlaverify.com) live, correct, and growing
toward real revenue (Stripe live, usage visibility, quarterly release currency).
**Owner agent role:** platform engineer (edge Worker + Python service), Sonnet.

**Current state (2026-09-11):** API and remote MCP (`/mcp`) live on Cloudflare Workers,
golden-tested against the Python oracle. Tiered keys (free/starter/pro/enterprise) in a KV
store. Stripe sandbox fully proven end-to-end (purchase -> webhook -> key -> 200 at pro
tier -> cancel -> 401 revoked). Live Stripe not yet activated (see Waiting on Jason #3).
Product page and shared nav shipped; `/pricing` redirects correctly.

**Next agent actions:**
1. If go-to-market or research outreach (PIPELINE.md row 9/19) surfaces real interest in
   agent pay-per-call, revisit `docs/AGENT_BILLING_NOTES.md` and pick Option A or B rather
   than leaving both open.

**Blocked on human:** Stripe live secrets (#3 in Waiting on Jason) and sandbox key rotation
(#2 in Waiting on Jason); a `/v1/usage` dashboard endpoint (new finding, 2026-09-15) — the
`USAGE` binding in `wrangler.jsonc` is Analytics Engine's Worker binding, which is
**write-only** (`writeDataPoint`, see `edge/src/index.js` / `stripe.js`); reading it back
needs Cloudflare's separate Analytics Engine SQL API, which needs its own API token stored
as a new `wrangler secret` — an agent cannot create that secret under this routine's rules
(#12 in Waiting on Jason), so this stays blocked until Jason creates the token. Testing the
uptime workflow's failure/recovery path for real (new finding, 2026-09-16, #13 in Waiting on
Jason) — see done log.

**Done log (last 5):**
- 2026-09-16 — confirmed the uptime workflow has run cleanly 11/11 times since 2026-09-14
  (all `success` per Actions) and found zero `uptime`-labeled issues, open or closed — the
  failure/open-issue/close-issue branch has never fired against real traffic and remains
  unexercised. A deliberate test means running `workflow_dispatch` against a broken URL,
  which creates a real, publicly-visible GitHub issue; this routine treats creating public
  content as "posting" and doesn't do it on its own initiative, so moved to blocked-on-human
  instead of self-authorizing a test issue.
- 2026-09-15 — scripts: `scripts/release_diff.py`, full allele-table diff (added / deleted
  / renamed, by locus) between two release tags, wired into `RELEASE_BUMP.md` step 6 so the
  quarterly customer notice can cite a real diff; smoke-tested against the pinned tag itself
  (zero diff) and the prior quarter's tag (672 added / 25 deleted / 1 rename).
- 2026-09-15 — investigated the `/v1/usage` next-action: the `USAGE` Analytics Engine
  binding turned out to be write-only from the Worker, so reading it back needs a new
  Cloudflare API token (a secret) — moved to blocked-on-human instead of built.
- 2026-09-14 — docs: agent pay-per-call billing design notes (`docs/AGENT_BILLING_NOTES.md`),
  Stripe metered billing vs. x402-style micropayment compared against the current tier/key
  code; no billing code written.
- 2026-09-14 — ci: uptime check workflow (`.github/workflows/uptime.yml`), curls
  `/healthz` every 15 minutes, opens/comments/closes a tracking issue on failure/recovery.

---

## (b) HLA-Verify go-to-market

**Goal:** turn the target list and outreach sequences into a working pipeline and, after
the first pilot, a case study.
**Owner agent role:** sales/outreach agent, Sonnet for drafting, Haiku for table upkeep.

**Current state (2026-09-14):** 60-target list (`docs/sales/TARGETS.md`), three-tier
outreach sequences (`docs/sales/OUTREACH.md`), pilot SOW template
(`docs/sales/PILOT_SOW.md`), integration brief, and launch posts
(`docs/launch/posts.md`) all written but unsent/unposted. `docs/sales/PIPELINE.md` still
has 20 targets (rows 1-20), all at stage `draft`; none have moved to `sent` yet. Note:
drafting rows into Gmail requires a session with a Gmail connector enabled in-chat — the
connector is installed and authenticated at the org level but `enabledInChat: false` on
this run (as on 2026-09-11), so it again could not complete action #1 below and fell
through to the next available action; this is a tooling gap, not something Jason needs to
do anything about (enabling the Gmail connector for the scheduled session, if he wants
action #1 to actually run, is the only lever here).

**Next agent actions:**
1. For each of the top 10 rows in `docs/sales/PIPELINE.md`, find a named buyer contact from
   public sources (LinkedIn search, org staff pages) and draft the tier-appropriate day-0
   email from `OUTREACH.md` as a Gmail draft; update the row's stage to `drafted-for-review`
   and date. Requires a Gmail connector enabled in-chat.
2. Once any row reaches stage `sent`, apply the day-5/day-12 follow-up schedule now encoded
   in `docs/sales/PIPELINE.md`'s "Follow-up schedule" section (checks `Date` against today,
   drafts via `OUTREACH.md`, notes the draft in `Next step` to avoid duplicates). Nothing to
   act on yet — no row is at `sent`.
3. Once a pilot from `docs/sales/PILOT_SOW.md` is signed (human-only, see below), draft a
   case-study outline in `docs/sales/CASE_STUDY_TEMPLATE.md` so it is ready to fill in.
4. Extend `docs/sales/PIPELINE.md` with targets 21-30 (remaining tier-A/B/C rows from
   `TARGETS.md` not yet in the pipeline), stage `draft`, once rows 1-20 move past `draft`.

**Blocked on human:** sending any drafted email (#7 in Waiting on Jason); posting the
prepared launch content to HN/Reddit/LinkedIn/X under Jason's own accounts (#8 in Waiting
on Jason — his accounts, his voice, agents only draft); signing a pilot SOW (financial
commitment); enabling the Gmail connector in-chat for this scheduled session so action #1
can run at all.

**Done log (last 5):**
- 2026-09-15 — re-verified every number in `docs/launch/posts.md` against current
  `STATUS.md` / `bench/` / `docs/pyard-concordance.md`: 46,652 alleles, 99.3% py-ard
  concordance, 32.7% post-cutoff share, and every per-model accuracy figure for both
  families still match exactly — no drift, nothing changed.
- 2026-09-14 — encoded a day-5/day-12 follow-up schedule in `docs/sales/PIPELINE.md`
  (no in-repo scheduler, so the daily routine checks `Date` against today by hand); no rows
  were at `sent` yet so nothing fired.
- 2026-09-11 — extended `docs/sales/PIPELINE.md` with targets 11-20 (rows 11-20 from
  `TARGETS.md`, orgs not already in the top 10), stage `draft`, no emails yet.
- 2026-09-11 — created `docs/sales/PIPELINE.md`, top 10 targets from `TARGETS.md`, stage
  `draft` (this session).
- 2026-09-10 — sales pack: 60-target list, three-tier outreach sequences, pilot SOW,
  integration brief.

---

## (c) HLA-Bench research

**Goal:** grow model coverage, ship the preprint, and prepare family B behind a data
licence check.
**Owner agent role:** research/harness agent, Sonnet; TOWER runs are free local compute.

**Current state (2026-09-11):** Family A (550 tasks) and Family C (205 pairs) both have
results for 8 open models plus the naive/abstainer baselines and a lower-bound Claude row
(token-truncated at 600, re-run pending at 1600 per STATUS.md). Preprint draft v0.1 is
structurally complete but has `[PENDING]` GRPO results and no clean Claude re-run; trademark
and prior-art memos are done; Hugging Face dataset card and demo Space are live.

**Next agent actions:**
1. Queue the clean claude-sonnet-4-6 re-run at 1600 tokens. Confirmed this run:
   `.tower-queue.json` / `relay.yml` only ever dispatches `tower.yml` (self-hosted, Ollama
   models only) by design — it cannot carry a `claude-sonnet-4-6` spec. This re-run can only
   go through a manual `bench.yml` `workflow_dispatch` (paid API key), which no agent session
   should trigger on its own. Next step is a `bench.yml` dispatch with `models=anthropic/
   claude-sonnet-4-6 split=test` (token budget is already 1600 in the harness per STATUS.md)
   — needs Jason's standing approval or a manual click; see "Waiting on Jason" below.
2. Convert `docs/paper/hla-bench-draft.md` to PDF per the checklist's pandoc command.
   Checked 2026-09-16: neither `pandoc` nor a LaTeX engine (`xelatex`/`pdflatex`) is
   installed in this cloud session's environment, so the conversion can't run here; needs
   either a session with that toolchain installed or Jason to run the documented command
   locally.
3. Add one figure (per-subtype accuracy bar chart or wrong-but-overconfident rate by model)
   to the draft, generated from committed `bench/` data, addressing the "no figures" gap.
4. Begin family B's graded core per `docs/TASK_SPEC_FAMILY_B.md` section 5 layer 1
   (synthetic-Mendelian-truth generator, no registry data needed) — not blocked on any
   licence.

**Blocked on human:** submitting the preprint (needs ORCID + bioRxiv account, #5 above); any
paid `bench.yml` run needs a manual `workflow_dispatch` click or Jason's standing approval
(#1 above — newly confirmed this cannot be routed through the free `.tower-queue.json` path);
the pandoc/xelatex PDF conversion (#2 above, new finding 2026-09-16 — no TeX toolchain in
this environment).

**Done log (last 5):**
- 2026-09-16 — docs: wrote the competing-interests statement and a manuscript-licence note
  into `docs/paper/hla-bench-draft.md`'s metadata section, verbatim from
  `docs/PREPRINT_CHECKLIST.md` item 5; also confirmed (see blocked-on-human) that this
  environment has no pandoc/TeX toolchain for the PDF-conversion step.
- 2026-09-15 — queued `ollama/llama3.2:3b` on HLA-Bench-C via `.tower-queue.json` (tower
  run 18) — the last model tested on Family A still missing from Family C; once it lands,
  Family C will have full model parity with Family A except the paid claude-sonnet-4-6 row.
- 2026-09-11 — queued `ollama/qwen2.5:3b` on HLA-Bench-C via `.tower-queue.json` (tower run
  #42) — closes half of the family-C vs family-A model-coverage gap.
- 2026-09-11 — docs: trademark knockout memo and preprint submission checklist.
- 2026-09-10 — docs: prior-art memo for HLA-Verify and HLA-Bench.

---

## (d) IP and legal

**Goal:** protect the HLA-VERIFY mark, keep the prior-art position current, and give the
site the legal pages a paying customer expects.
**Owner agent role:** documentation/research agent, Sonnet; all output is a memo for Jason
or counsel, never a filing.

**Current state (2026-09-11):** Prior-art memo and trademark knockout memo both complete
(research memos, not opinions). No terms of service, privacy page, or DPA template exist
yet on the site or in `docs/`.

**Next agent actions:**
1. Draft `docs/legal/PRIVACY_POLICY.md` matching what the Worker actually does (no PHI
   accepted, no request bodies logged/stored, Analytics Engine records aggregate counts
   only) — verify every claim against `edge/src/*.js` before writing it, don't assume.
2. Draft `docs/legal/DPA_TEMPLATE.md` for lab customers per the pilot SOW's data-handling
   section 4, for the self-hosted and hosted deployment options separately.
3. Re-run the prior-art web searches for anything new since 2026-09-10 and append findings
   to `docs/PRIOR_ART.md` rather than rewriting it.
4. Once Jason decides on trademark filing (#4 in Waiting on Jason), record the decision,
   date, and (if filed) serial number in `docs/TRADEMARK.md`'s recommendation section.

**Blocked on human:** the trademark filing decision and filing itself (#4); attorney review
of the drafted legal pages before they are trusted for a real dispute; MN filings (#6).

**Done log (last 5):**
- 2026-09-16 — docs: drafted `docs/legal/TERMS_OF_SERVICE.md` — free/keyed tiers, the
  "stores nothing" data-handling claim (verified against `edge/src/index.js`), the PolyForm
  Noncommercial vs. Apache-2.0 licence boundary, a not-a-medical-device liability
  limitation, and a governing-law placeholder; marked as a draft for counsel review only.
- 2026-09-11 — docs: trademark knockout memo (`docs/TRADEMARK.md`).
- 2026-09-11 — docs: preprint submission checklist (`docs/PREPRINT_CHECKLIST.md`).
- 2026-09-10 — docs: prior-art memo (`docs/PRIOR_ART.md`).

---

## (e) Headwaters Genetics — stub charter

**Goal (as far as known):** Minnesota cannabis seed venture. No repo access from this
session; artifacts live in Google Drive and "CEO Brief" emails, domain parked on
Cloudflare.
**Owner agent role:** whichever agent Jason grants Drive/email access to first.

**What an agent should ask Jason for before doing anything here:**
1. Read access (or a shared folder) to the Google Drive artifacts and "CEO Brief" email
   history for context.
2. Current state of the seed business (pre-revenue? SKUs?), Minnesota cannabis-program
   licensing status (separate from general business registration), and whether a DBA filing
   is needed (see Waiting on Jason #6).
3. Whether the parked domain should get a landing page now, and whether this venture wants
   its own repo or stays Drive-and-email native.

**Blocked on human:** everything above; this stub does no work until Jason answers it.

---

## (f) Spin Renta / Minnesota Rentals — stub charter

**Goal (as far as known):** an existing rentals business with its own Stripe account
already in use. No repo access from this session.
**Owner agent role:** whichever agent Jason grants access to first (likely a
small-business-operations agent rather than a software one, given the `small-business:*`
skills available).

**What an agent should ask Jason for before doing anything here:**
1. Where the business's records live (spreadsheet, property-management SaaS, email).
2. Read-only access to the existing Stripe account (reporting only, no payment actions) if
   a cash-flow or bookings snapshot is wanted — its credentials stay fully separate from
   HLA-Verify's per the one-Stripe-account-per-brand rule.
3. The actual pain point right now (tenant/booking communication, pricing, listings,
   maintenance tracking) to scope a first small task.

**Blocked on human:** everything above; this stub does no work until Jason answers it.
