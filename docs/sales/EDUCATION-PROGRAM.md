# Education & research key program — operating doc

*For Jason. Covers eligibility checks, issuance steps, reply templates, renewal, abuse
signals, tracking, and the SBIR tie-in. Program decided 2026-09-14 (COO office, recorded in
`coo/data/portfolio.json` hlaverify next_actions, owner vp-revenue): HLA-Verify API keys are
free for university students, faculty and other academic or non-profit researchers, for
research or teaching use only, not clinical or commercial use. Goal is traction and
citations. Universities get their own page: hlaverify.com/education.*

## Why this lines up with the existing licence

The Python verification service (`sci_envs/service/`) is already under PolyForm
Noncommercial 1.0.0, which permits use by "any charitable organization, educational
institution, public research organization…" (see `sci_envs/service/LICENSE`, repo
`high-valuation-startup/wt-lab-toolkit`). The free-key program formalizes access at the API
layer for the same population the licence already names. Say that plainly to a requester if
it comes up; it is not legal advice, and the licence text on GitHub is the source of record.

## Eligibility checks (2 minutes)

Do these in order; stop as soon as one fails and you know the answer.

1. **Institutional email domain.** The request should come from (or name) a `.edu`,
   national-lab, or recognizable non-profit/public-research-institute domain. A `gmail.com`
   address alone is a soft no — ask for an institutional address before issuing.
2. **Lab or faculty page.** A 30-second search for the requester's name plus institution
   should turn up a lab page, faculty directory listing, or department roster. If nothing
   turns up, ask for a link before issuing.
3. **PI confirmation for students.** If the requester is a student (undergrad, grad, or
   postdoc not yet PI), the named advisor/PI should be findable on the same lab or
   department page. You don't need the PI to reply — matching the name on a public page is
   enough for this tier of risk.
4. **Use fits the license.** Skim the one-paragraph research-use description. Research or
   teaching, not "we're building a product" or "for our clinic's daily typing review." If
   it's ambiguous, ask one follow-up question before issuing.

If all four pass, issue. If one is missing but the rest look legitimate (e.g., no lab page
yet for a brand-new postdoc), ask for the missing piece rather than declining outright.

## Issuing the key (steps only — do not run these yourself as an agent)

Keys live in the `KEYS` KV namespace the edge Worker reads (see `edge/src/keys.js`,
`edge/src/stripe.js` for the shape). For an education key:

1. Generate a key value the same way any manually-issued key is generated today (see the
   existing hand-issuance process — this doc does not change that mechanism).
2. Write a KV record with:
   - **tier**: `pro` (the free research key runs at the Pro tier's rate limit)
   - **label**: `edu:<institution>:<name>` — e.g. `edu:umn:j-smith` — short, no spaces,
     institution first so a KV list scan groups by institution.
   - **status**: `active`
   - Optionally an `email` field (institutional address) for renewal outreach next year.
3. Confirm the key authorizes at Pro-tier limits (a single `/v1/allele` call with the new
   key, checking the `x-hla-verify-tier` response header, is enough).
4. Reply to the requester with the key and the reply template below.

This doc describes the steps; it does not create keys, run `wrangler`, or handle key values.
That stays a manual Jason action or a scoped VP Platform task with the key value redacted
from any log.

## Reply templates

**Approval:**

> Subject: Re: Research key request
>
> Hi [name] — approved. Your HLA-Verify research key is below; it runs at our Pro tier's
> rate limit at no cost.
>
> `[key]`
>
> A couple of things to keep in mind: this key is for research and teaching use only — not
> clinical decisions or patient care, and not for commercial use or resale. If you publish
> results using it, please cite HLA-Verify and IPD-IMGT/HLA (suggested citation is on
> hlaverify.com/education). Keys are personal or per-lab, so please don't share this one
> outside your group — email us if a labmate needs their own. We'll check in around this
> time next year to renew it.
>
> API reference: https://hlaverify.com/api. MCP server details are in the same reference if
> you're wiring this into an agent.
>
> Let us know if anything doesn't work as expected.

**Decline (or request more info):**

> Subject: Re: Research key request
>
> Hi [name] — thanks for reaching out. Before I can issue a key, could you send [missing
> item: an institutional email address / a link to your lab or department page / a bit more
> detail on the research use]? The program is for research and teaching at accredited
> universities and non-profit/public research institutes, and I want to make sure I've got
> that right before issuing.
>
> [If clearly out of scope — commercial or clinical use:] Based on what you described, this
> sounds like [commercial / clinical] use rather than research or teaching, so the free
> program isn't the right fit — happy to talk about a paid key instead. See
> https://hlaverify.com/pricing or reply here and we'll figure out the right tier.

## Yearly renewal

Research keys are reissued on request, not silently expired. Roughly once a year from
issuance (use the KV record's issue date, or the `email` field to reach out), send a
one-line check-in: "Still using your HLA-Verify research key for [institution]? Reply and
we'll keep it active for another year." No reply after a reasonable window (a month, two
follow-ups) — mark the key `status: revoked` rather than leaving it live indefinitely.

## Abuse and red flags

Decline or ask follow-up questions when you see:

- **Commercial domains** in the email or the described use (a company name, a `.com`
  address with no institutional affiliation, language like "our product" or "our
  customers").
- **Clinical use** described directly — "for patient typing review," "to check reports
  before sign-out," "in our clinic." Redirect to the paid Laboratory tier and the trust page
  (not a medical device, but clearly a production use, not research).
- **Reselling or embedding** the key in another product or service, including an internal
  tool used company-wide rather than by one lab.
- **Volume far out of proportion** to a research/teaching use (e.g., "millions of requests
  per day" from a single named student) — worth a clarifying question before issuing at
  Pro-tier limits.
- **Vague or copy-pasted requests** with no institution, no lab page, and no specific
  research use — ask for specifics before issuing.

When in doubt, ask one more question. It costs a day; issuing a key that gets used
commercially costs more to unwind.

## What we track

For traction evidence (SBIR, investor conversations, and just knowing the program is
working), keep a running count of:

- **Number of active research keys issued.**
- **Number of distinct institutions represented.**
- Optionally: which are university labs vs. non-profit/public research institutes, and
  whether any have published or cited HLA-Verify or the benchmark (worth a quick search
  around renewal time).

This doesn't require new infrastructure — a running tally next to the KV label list (`edu:
<institution>:<name>`) is enough at this scale. Counts, never per-request content, matching
the "nothing is stored" posture on the rest of the product.

## SBIR narrative (broader impacts)

NSF SBIR full proposals ask for broader impacts beyond the commercial thesis. This program
is direct evidence: number of institutions and researchers using deterministic HLA
verification and the open benchmark, use in coursework (nomenclature exercises, benchmark as
a class project, agent/MCP teaching), and any resulting citations or student work. Frame it
as: the same engine that's commercializing in labs and with LIMS/AI vendors is also lowering
the barrier for academic researchers and training the next cohort of people who work with
HLA nomenclature — which is the "broader impacts beyond the funded firm" reviewers look for.
Keep the specific numbers current in the draft rather than reusing this doc's placeholders.
