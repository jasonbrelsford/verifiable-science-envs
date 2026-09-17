# docs/legal/

Business-adjacent legal drafts for HLA-Verify. Per `docs/README.md`, this is the one
category of business-adjacent material allowed in this public repository — everything
else (pipeline, prospect names, pricing negotiations, launch copy, internal status, IP
memos) lives in the private portfolio hub, `jasonbrelsford/ventures`, under
`01-science-envs-private/`. Nothing in this directory may name a prospect or quote a
negotiated (non-public) price; public list prices from `/pricing` are fine.

**Status: draft for attorney review. Nothing here is final, binding, or published.**
Effective dates are bracketed placeholders in every document below until counsel signs
off and a real date is set.

## Files

| File | What it is |
|---|---|
| `TERMS_OF_SERVICE.md` | The single Terms of Service document — the merged result of an earlier `TERMS_OF_SERVICE.md` draft (nomenclature-validation positioning) and a since-removed `TERMS.md` draft (AWS/Stripe/Twilio-style B2B terms). Covers eligibility, tiers and OAuth sign-in, acceptable use, fees and billing, release pinning, IP and third-party attribution, warranty disclaimer, limitation of liability, customer indemnification, termination, changes, and governing law. |
| `PRIVACY.md` | The Privacy Policy: what the website, API, and MCP server collect and retain, checked line-for-line against the deployed Worker code. |
| `DPA.md` | Data Processing Addendum template, for enterprise and pilot customers who need one attached to a signed order form. Not offered at self-serve tiers. |
| `LIABILITY_MEMO.md` | Research memo (not legal advice) on why the Terms take the shape they do: the AWS/Stripe/Twilio liability-cap comparison, and the FDA Clinical Decision Support exemption and HIPAA analysis for a nomenclature-validation tool with one decision-support-adjacent feature (`donor_compat`). |
| `IMPLEMENTATION_NOTES.md` | Checklist for what has to happen before any of the above goes live: what this repo's agents can touch (`edge/src/docs.js`, `edge/src/mcp.js`), what belongs to the separate `jasonbrelsford/hlaverify-website` repo (publishing the actual `/terms` and `/privacy` pages), what is Jason's to do (Stripe Payment Link settings), and what is the attorney's to clear. |

## Rules for this directory

- Every document here is a **draft for attorney review**, not a final or binding
  instrument, until its own status line says otherwise.
- **No prospect names, no negotiated or pilot pricing, no sales pipeline.** Public list
  prices (from `/pricing`) are fine to cite; a specific customer's deal terms are not.
- Keep the positioning consistent with the rest of this repository: the Service is
  nomenclature and reference-release validation, not clinical decision support. The one
  exception — "decision support only; not a medical device" — is scoped specifically to
  the `/v1/compat` endpoint and the `donor_compat` MCP tool, never to the Service as a
  whole. See `CLAUDE.md` and `TERMS_OF_SERVICE.md` Section 3.
- Keep factual claims (what is stored, what tiers exist, what endpoints do) checked
  against the actual code in `edge/src/*`, not against an earlier draft or an assumption.
  When code and an existing draft disagree, the code wins and the draft gets corrected.
- Do not add other business material here — sales, pipeline, launch copy, and internal
  status still belong in the private portfolio hub, not in this directory.
