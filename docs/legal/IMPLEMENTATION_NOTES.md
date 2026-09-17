# Implementation notes: publishing the legal pages

*Checklist for the project board. Drafted 2026-09-17, companion to
`TERMS_OF_SERVICE.md` and `PRIVACY.md`. Updated 2026-09-17 during the terms merge to
reflect where things actually live, and again the same day to fold in the code/doc
accuracy items from the operator's private claims audit (see the new section below).
The Data Processing Addendum template and the liability research memo referenced
throughout this checklist now live in the operator's private contract pack, not in
this repository's `docs/legal/` — see `docs/legal/README.md`. Not legal advice.*

**Do not action any attorney-blocked item below until an attorney has reviewed
`TERMS_OF_SERVICE.md`, `PRIVACY.md`, and the private DPA, and an effective date is
set.** The code/doc accuracy section is not attorney-blocked: those items are
corrections to match what the code already does, not changes in legal position. This
file lists follow-up work only; it does not authorize publishing the drafts as-is.

## Correction from the earlier draft of this checklist

The earlier version of this file assumed a "site agent" in this repository would publish
`/terms` and `/privacy` pages and edit `edge/src/docs.js` and `edge/src/mcp.js` directly.
That is not how this project is actually split:

- **hlaverify.com (including `/terms` and `/privacy` pages) is deployed from a separate
  repository, `jasonbrelsford/hlaverify-website`, not from this one** (see this repo's
  `CLAUDE.md`). Publishing the terms and privacy pages, and linking them in that site's
  footer, is that repository's job. An agent working in *this* repo cannot do it and
  should not try.
- **API docs and pricing for api.hlaverify.com live in `edge/src/docs.js` in this repo**
  (`DOCS_HTML`, `PRICING_HTML`, `CHECKOUT_SUCCESS_HTML`, and the `openapi()` schema). Any
  change to what the API's own docs/pricing pages say is made here, and a push to `main`
  touching `edge/src/**` deploys api.hlaverify.com directly — branch and PR, per this
  repo's `CLAUDE.md`.
- **The MCP `about` tool lives in `edge/src/mcp.js`** (`aboutBody()`, and the `about` tool's
  `outputSchema` `ABOUT_OUT`), also in this repo, also deployed the same way.

## This repo: code/doc accuracy corrections (not attorney-blocked — fix regardless)

The operator's private claims audit checked what `hlaverify.com`, `api.hlaverify.com/docs`,
and the MCP server say against what the code actually does, and found several
self-contradictions inside this repo's own `edge/src/docs.js` and `edge/src/mcp.js`.
These are factual accuracy fixes, not legal-position changes, so they do not need to
wait on attorney review the way the rest of this checklist does.

- [ ] **AGENT.** `edge/src/docs.js`'s `DOCS_HTML` says a keyed customer can have "an
  older release... kept for a customer on request" and receives "a diff of changed
  verdicts before the pin moves." Neither is implemented: the key record has no
  release field, and `/pricing`'s own "Not built yet" list already says "a key cannot
  be held on an older release." Delete the two `/docs` claims (or replace with
  `/pricing`'s wording) so the API's own two pages stop contradicting each other.
- [ ] **AGENT.** `edge/src/docs.js`'s `DOCS_HTML` lists "per-key usage reporting" as
  something a key gets. There is no usage-read endpoint — the Analytics Engine
  binding is write-only from the Worker — and `/pricing` already correctly lists this
  under "Not built yet." Remove the `/docs` claim.
- [ ] **AGENT.** `edge/src/mcp.js`'s `about` tool (`aboutBody()`) states a fabrication-rate
  range of "0.05-0.14 per task," matching text in `assets/llms.txt` and
  `docs/paper/hla-bench-draft.md`. The committed benchmark data
  (`bench/HLA-Bench-A.md`, full split) shows a range of 0.06-0.20 per task; `0.14`
  matches no row, and `0.05` is a dev-split-only figure. Correct all three locations
  to the full-split range, starting with `mcp.js` because it is served live by the
  production API.
- [ ] **AGENT.** `edge/src/mcp.js`'s hard-coded "free public beta" / "issued on request"
  language (the `INSTRUCTIONS` constant and the `about` response) does not switch to
  self-serve wording the way `edge/src/docs.js`'s HTML surfaces already do based on
  whether Stripe checkout is live. Make the MCP surface read the same live/beta state
  so it does not tell a connected agent self-serve does not exist after checkout opens.
- [ ] **AGENT.** The `attribution` string baked into every API response and MCP tool
  output (originating in `sci_envs/service/edge_export.py`, flowing into
  `edge/public/manifest.json`) says reference data are "fetched at runtime." For the
  hosted edge API this is inaccurate: the edge build fetches and derives the tables at
  *export/build* time and ships them with the deployment (the Python service in
  `sci_envs/service/app.py` does fetch at runtime — leave that wording alone). Fix the
  string used for the edge build specifically; attribution accuracy is what the
  upstream IPD-IMGT/HLA licensor relies on.
- [ ] **AGENT.** `edge/src/keys.js` silently falls back an unrecognized tier to
  `starter` (`canonicalTier()`). A mis-mapped `$299` (lab) or `$1,999` (scale) Stripe
  price would be served, and displayed to the buyer, as the cheaper Starter tier with
  no error surfaced anywhere. Consider failing loudly (a 500 with a clear log/metric)
  instead of a silent downgrade, or at minimum add a metering signal so a mis-mapped
  price is visible.
- [ ] **AGENT.** `pyproject.toml` has no `license` field or classifier, even though the
  repository root `LICENSE` is Apache-2.0 and `edge/package.json` correctly declares
  `PolyForm-Noncommercial-1.0.0`. Add one so packaging tools and license scanners do
  not report the Python package as unlicensed.

## This repo: owns `edge/src/docs.js` and `edge/src/mcp.js` content (blocked on attorney review first)

- [ ] **AGENT.** Once a `terms_url` is live on hlaverify.com, add it to the Terms paragraph
  in `DOCS_HTML` (`edge/src/docs.js`, the `<h2>Terms</h2>` section, currently line 150-151)
  and to the OpenAPI `info.description` (same file, the `openapi()` export, currently
  around line 248-260).
- [ ] **AGENT.** Add a `terms_url` field alongside the existing `disclaimer` field in the
  MCP server's `about` tool response (`edge/src/mcp.js`: the `aboutBody()` function,
  currently line 526-559, and its `disclaimer` field at line 557; also add `terms_url` to
  the `ABOUT_OUT` output schema, currently line 330-336, so it stays a documented,
  schema-checked field rather than an undeclared extra key).
- [ ] **AGENT.** Add a one-line acceptance/notice statement to the checkout success page
  (`CHECKOUT_SUCCESS_HTML` in `edge/src/docs.js`, currently line 206-242), e.g. "By using
  your key you agree to the Terms of Service," linking the published terms URL.
- [ ] **AGENT.** Confirm the `/v1/compat` and `donor_compat` "Decision support only; not a
  medical device" lines (`edge/src/docs.js` line 105 and line 318; `edge/src/mcp.js` line
  464) stay scoped to that one endpoint/tool and are not broadened to describe the rest of
  the Service, consistent with `TERMS_OF_SERVICE.md` Section 3.
- [ ] **AGENT.** Confirm `edge/src/docs.js`'s Terms paragraph (line 150-151) and
  `edge/src/mcp.js`'s `INSTRUCTIONS` constant (line 30-46) stay accurate to whatever
  `TERMS_OF_SERVICE.md` and `PRIVACY.md` say once counsel finalizes them (particularly: no
  PHI, not clinical decision support except where scoped, request bodies not stored).

## `jasonbrelsford/hlaverify-website` repo: owns publishing and linking (a separate task, in a separate repo; blocked on attorney review first)

- [ ] Publish `TERMS_OF_SERVICE.md`'s content as a page at `hlaverify.com/terms`.
- [ ] Publish `PRIVACY.md`'s content as a page at `hlaverify.com/privacy`.
- [ ] Link both pages in the footer of every page on hlaverify.com.
- [ ] Link both pages from wherever that site links api.hlaverify.com/docs and /pricing.
- [ ] Update `llms.txt` (served from that site, redirected to from `/llms.txt` on the API
  per `edge/src/index.js`) to include the terms URL so agents reading the machine-readable
  summary see it too.

## Jason: owns account-level Stripe settings and legal sign-off

- [ ] **JASON.** Engage an attorney to review `TERMS_OF_SERVICE.md`, `PRIVACY.md`, and
  the private contract pack's DPA before anything above goes live.
- [ ] **JASON.** In the Stripe Dashboard, turn on "Require customers to accept your terms
  of service" on the self-serve Payment Links (currently `STRIPE_STARTER_LINK` and
  `STRIPE_PRO_LINK` in `edge/wrangler.jsonc`, sold to customers as the Starter and Lab
  tiers — see `edge/src/docs.js`'s `PRICING_HTML`), pointing at the published
  `hlaverify.com/terms` URL once it exists. (Payment Links settings, not code; cannot be
  done by an agent.) Note that as of this checklist the Payment Links are Stripe TEST
  links per `edge/src/docs.js`'s comment above `PRICING_HTML`, so this can be set up
  against the test links now and re-confirmed when they are swapped for live ones.
- [ ] **JASON.** Confirm with the attorney whether the Minnesota/Hennepin County
  governing-law and venue choice, and the fee-paid/$100 liability cap, are acceptable as
  drafted or need adjustment before publishing.
- [ ] **JASON.** Decide whether to add the optional arbitration clause noted in
  `TERMS_OF_SERVICE.md` Section 15.3.

## Attorney: must clear before publish

- [ ] **ATTORNEY.** Confirm enforceability of the limitation-of-liability cap and
  carve-outs under Minnesota law (or whichever state is confirmed as the actual state of
  formation — see the bracketed placeholder in `TERMS_OF_SERVICE.md` Section 15.1).
- [ ] **ATTORNEY.** Confirm the customer-indemnification clause's scope is appropriate
  (not broader or narrower than intended).
- [ ] **ATTORNEY.** Confirm the FDA CDS-exemption framing in the private contract
  pack's liability memo is correctly applied to `/v1/match` and `/v1/compat`'s actual
  current response shapes.
- [ ] **ATTORNEY.** Confirm the "no BAA at self-serve tiers" position and the private
  DPA's HIPAA section are sound given actual enterprise use cases as they arise.
- [ ] **ATTORNEY.** Set the effective date and version number in `TERMS_OF_SERVICE.md`,
  `PRIVACY.md`, and the private DPA before publication.

---

*Drafted by an AI agent. Not legal advice. Nothing in this checklist authorizes publishing
the draft terms as binding before attorney review.*
