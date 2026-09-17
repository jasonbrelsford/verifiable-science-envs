# Implementation notes: publishing the legal pages

*Checklist for the project board. Drafted 2026-09-17, companion to `LIABILITY_MEMO.md`,
`TERMS_OF_SERVICE.md`, `PRIVACY.md`, `DPA.md`. Updated 2026-09-17 during the terms merge
to reflect where things actually live. Not legal advice.*

**Do not action any item below until an attorney has reviewed `TERMS_OF_SERVICE.md`,
`PRIVACY.md`, and `DPA.md` and an effective date is set.** This file lists the follow-up
work only; it does not authorize publishing the drafts as-is.

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
  `DPA.md` before anything above goes live.
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
- [ ] **ATTORNEY.** Confirm the FDA CDS-exemption framing in `LIABILITY_MEMO.md` is
  correctly applied to `/v1/match` and `/v1/compat`'s actual current response shapes.
- [ ] **ATTORNEY.** Confirm the "no BAA at self-serve tiers" position and the DPA's HIPAA
  section are sound given actual enterprise use cases as they arise.
- [ ] **ATTORNEY.** Set the effective date and version number in `TERMS_OF_SERVICE.md`,
  `PRIVACY.md`, and `DPA.md` before publication.

---

*Drafted by an AI agent. Not legal advice. Nothing in this checklist authorizes publishing
the draft terms as binding before attorney review.*
