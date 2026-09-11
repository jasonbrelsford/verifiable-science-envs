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
8. **Headwaters Genetics and Spin Renta starting info.** These have stub charters below
   (projects e and f) because this session has no repo or account access for them. When you
   have a few minutes, answer the "ask Jason" questions in each stub so an agent can start
   real work there.

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
1. Write the quarterly IPD-IMGT/HLA release-bump runbook as a doc (`docs/RELEASE_BUMP.md`):
   steps to bump the pinned release tag, re-run `edge_export`, regenerate golden fixtures,
   and the customer-notice email template (drafted, never sent) — no code yet, just the
   procedure, so it is ready before the next real release lands.
2. Implement a `/v1/usage` or dashboard endpoint reading from the `USAGE` Analytics Engine
   dataset already wired in `wrangler.jsonc`, scoped so a keyed customer sees only their own
   counts (start with a single aggregate JSON endpoint, not a UI).
3. Add an uptime check: a GitHub Actions scheduled workflow that curls
   `https://api.hlaverify.com/healthz` every 15 minutes and opens/updates a tracking issue
   (or commits a status line to `STATUS.md`) on failure.
4. Draft (design only, no billing code) how agent pay-per-call would work later via Stripe
   metered billing or an x402-style micropayment, in `docs/AGENT_BILLING_NOTES.md`; do not
   implement until Stripe live is proven.

**Blocked on human:** Stripe live secrets (#3) and sandbox key rotation (#2); platform work
above does not depend on either.

**Done log (last 5):**
- 2026-09-11 — site: product page at hlaverify.com/product, shared nav, /pricing redirect.
- 2026-09-11 — edge: sandbox Stripe payment links and price-to-tier map.
- 2026-09-11 — edge: Stripe-only self-serve keys, signed checkout webhook issues/revokes
  keys, /pricing and /checkout/success pages.
- 2026-09-11 — edge: remote MCP endpoint at /mcp, tiered keys with KV store, MCP path
  golden-tested against the same fixtures.
- 2026-09-10 — HLA-Verify API live at api.hlaverify.com (Cloudflare Worker over
  Python-exported tables, golden-tested); edge-deploy wired to run on push.

---

## (b) HLA-Verify go-to-market

**Goal:** turn the target list and outreach sequences into a working pipeline and, after
the first pilot, a case study.
**Owner agent role:** sales/outreach agent, Sonnet for drafting, Haiku for table upkeep.

**Current state (2026-09-11):** 60-target list (`docs/sales/TARGETS.md`), three-tier
outreach sequences (`docs/sales/OUTREACH.md`), pilot SOW template
(`docs/sales/PILOT_SOW.md`), integration brief, and launch posts
(`docs/launch/posts.md`) all written but unsent/unposted. `docs/sales/PIPELINE.md` now
exists with the top 10 targets, all at stage `draft`.

**Next agent actions:**
1. For each of the top 10 rows in `docs/sales/PIPELINE.md`, find a named buyer contact from
   public sources (LinkedIn search, org staff pages) and draft the tier-appropriate day-0
   email from `OUTREACH.md` as a Gmail draft; update the row's stage to `drafted-for-review`
   and date.
2. Extend `docs/sales/PIPELINE.md` with targets 11-20 (next tier-A/B/C rows from
   `TARGETS.md`), stage `draft`, no emails yet.
3. Add a day-5 and day-12 follow-up drafting step that only fires (as a next action) once a
   row has been at `sent` for 5 / 12 days respectively — encode this as a note in
   `PIPELINE.md` for the daily routine to check dates against, since there is no scheduler
   inside this repo.
4. Once a pilot from `docs/sales/PILOT_SOW.md` is signed (human-only, see below), draft a
   case-study outline in `docs/sales/CASE_STUDY_TEMPLATE.md` so it is ready to fill in.
5. Re-verify every number in `docs/launch/posts.md` against current `STATUS.md` and fix any
   that drifted (posting itself is human-only, see below).

**Blocked on human:** sending any drafted email (#7 above); posting to HN/Reddit/LinkedIn/X
under Jason's own accounts (his accounts, his voice — agents draft, he posts); signing a
pilot SOW (financial commitment).

**Done log (last 5):**
- 2026-09-11 — created `docs/sales/PIPELINE.md`, top 10 targets from `TARGETS.md`, stage
  `draft` (this session).
- 2026-09-10 — sales pack: 60-target list, three-tier outreach sequences, pilot SOW,
  integration brief.
- 2026-09-09 — launch posts: six families, 14B and Gemma rows, three-model matching
  results; X thread scale line.
- 2026-09-09 — card and launch-post grammar/number updates for the matching table.
- 2026-08-31 (approx.) — original outreach sequences and TARGETS.md drafted (see
  `docs/sales/OUTREACH.md` header date).

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
1. Queue the clean claude-sonnet-4-6 re-run at 1600 tokens: write a `.tower-queue.json` (or
   a `bench.yml` dispatch, since this uses a paid API key) entry and note it in this log —
   do not run it without confirming which workflow is meant to hold API-key spend
   (`bench.yml`, manual-dispatch-only by design).
2. Convert `docs/paper/hla-bench-draft.md` to PDF per the checklist's pandoc command; verify
   the pandoc/xelatex toolchain exists locally first, and if not, note the gap rather than
   guessing at output.
3. Write the competing-interests statement and CC-BY licence note into the draft's metadata
   section verbatim from `docs/PREPRINT_CHECKLIST.md` item 5, so the draft is submission-
   ready the moment Jason has an ORCID and bioRxiv account.
4. Add one figure (per-subtype accuracy bar chart or wrong-but-overconfident rate by model)
   to the draft, generated from committed `bench/` data, addressing the "no figures" gap.
5. Pick the next model for the tower queue to close out remaining family-C coverage gaps
   (check `bench/HLA-Bench-C.md` for missing rows) and write the `.tower-queue.json` entry.
6. Begin family B's graded core per `docs/TASK_SPEC_FAMILY_B.md` section 5 layer 1
   (synthetic-Mendelian-truth generator, no registry data needed) — not blocked on any
   licence.

**Blocked on human:** submitting the preprint (needs ORCID + bioRxiv account, #5 above); any
paid `bench.yml` run needs a manual `workflow_dispatch` click or Jason's standing approval.

**Done log (last 5):**
- 2026-09-11 — docs: trademark knockout memo and preprint submission checklist.
- 2026-09-10 — docs: prior-art memo for HLA-Verify and HLA-Bench.
- 2026-09-09 — results: phi4-mini on HLA-Bench-C, 0/205, 139 schema failures; matching now
  covers all five open families.
- 2026-09-09 — results: mistral:7b on HLA-Bench-C, 13.7%, best open model so far.
- 2026-09-09 — harness: fallback ladder for degenerate Ollama replies; cache rejects
  token-spam and records which rung answered.

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
1. Draft `docs/legal/TERMS_OF_SERVICE.md` for hlaverify.com covering: the free/keyed tiers,
   "nothing sent is stored" data handling, the PolyForm Noncommercial licence boundary,
   liability limitation (explicitly: not a medical device, not clinical decision support),
   and governing law placeholder — mark clearly as a draft for counsel review, not final.
2. Draft `docs/legal/PRIVACY_POLICY.md` matching what the Worker actually does (no PHI
   accepted, no request bodies logged/stored, Analytics Engine records aggregate counts
   only) — verify every claim against `edge/src/*.js` before writing it, don't assume.
3. Draft `docs/legal/DPA_TEMPLATE.md` for lab customers per the pilot SOW's data-handling
   section 4, for the self-hosted and hosted deployment options separately.
4. Re-run the prior-art web searches for anything new since 2026-09-10 and append findings
   to `docs/PRIOR_ART.md` rather than rewriting it.
5. Once Jason decides on trademark filing (#4 in Waiting on Jason), record the decision,
   date, and (if filed) serial number in `docs/TRADEMARK.md`'s recommendation section.

**Blocked on human:** the trademark filing decision and filing itself (#4); attorney review
of the drafted legal pages before they are trusted for a real dispute; MN filings (#6).

**Done log (last 5):**
- 2026-09-11 — docs: trademark knockout memo (`docs/TRADEMARK.md`).
- 2026-09-11 — docs: preprint submission checklist (`docs/PREPRINT_CHECKLIST.md`).
- 2026-09-10 — docs: prior-art memo (`docs/PRIOR_ART.md`).
- (no earlier legal-track entries before 2026-09-10)

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
