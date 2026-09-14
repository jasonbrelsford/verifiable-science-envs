# Research & Education access — operating doc

*For Jason. Covers eligibility checks, approval criteria for the broadened categories,
issuance steps, reply templates, renewal, abuse signals, tracking, and the SBIR tie-in.
Program decided 2026-09-14 (COO office, recorded in `coo/data/portfolio.json` hlaverify
next_actions, owner vp-revenue) and broadened the same day per Jason: "I want anyone using
it for research to be able to use it for free with our approval." HLA-Verify API keys are
free for anyone doing research — students at any level, independent researchers, academic
and non-profit researchers, and research teams at companies evaluating or studying HLA/LLM
behavior — for research use only, approved by Jason case by case. Still excluded: clinical
use or patient care, production or commercial pipelines, and resale. Goal is traction and
citations. The public page is hlaverify.com/research (hlaverify.com/education redirects
there).*

## Why this lines up with the existing licence

The Python verification service (`sci_envs/service/`) is already under PolyForm
Noncommercial 1.0.0, which permits use by "any charitable organization, educational
institution, public research organization…" (see `sci_envs/service/LICENSE`, repo
`high-valuation-startup/wt-lab-toolkit`). The free-key program formalizes access at the API
layer for a broader research population than the licence names by category, under the same
noncommercial spirit, with Jason approving each request individually. Say that plainly to a
requester if it comes up; it is not legal advice, and the licence text on GitHub is the
source of record.

## Eligibility categories (2026-09-14 broadening)

The program is no longer limited to universities or non-profits. It covers:

- **Students at any level** — high school, undergraduate, graduate, or postdoc.
- **Independent researchers** with no institutional affiliation, working on their own
  project.
- **Academic and non-profit researchers** — the population the program originally covered,
  unchanged.
- **Research teams at companies** evaluating or studying HLA or LLM behavior — e.g., a model
  developer benchmarking hallucination rates, or a team studying nomenclature handling as
  research, not as part of a product they ship.

**Still excluded — these belong on a paid tier:**

- **Clinical use or patient care.** Any use that touches a real patient's typing review,
  case discussion, or sign-out, in a classroom, teaching hospital, or anywhere else.
- **Production or commercial pipelines.** A LIMS vendor shipping HLA-Verify to customers, or
  a lab running it routinely on client reports as part of a paid service. The underlying
  question can be scientific and the use still be commercial — it's the pipeline that
  matters, not the topic.
- **Resale.** Reselling access, embedding a research key in another paid product, or sharing
  one key across an organization in place of that organization buying its own key.

Every request is approved case by case by Jason. There is no automatic qualification by
category — the categories above describe who is *eligible to ask*, not who is auto-approved.

## Eligibility checks (2 minutes)

Do these in order; stop as soon as one fails and you know the answer. The checks below are
calibrated per category — an independent researcher won't have an institutional email or a
lab page, and that's expected, not a red flag by itself.

1. **Identity and affiliation, whatever it is.** Institution, company, or "independent" —
   the request should say which, plainly. A bare `gmail.com` address with no other detail is
   a soft no; ask what the affiliation is (or confirm "independent") before issuing.
2. **A public trace, sized to the claim.**
   - Academic/non-profit: a lab or faculty page, or a department roster listing.
   - Student: the named advisor/PI (if not yet a PI themselves) findable on the same lab or
     department page.
   - Independent researcher: a public writeup, repo, preprint, or profile (e.g. GitHub,
     ORCID, a blog post describing the project) — something that shows the project is real,
     since there's no institution to vouch for it.
   - Company research team: the company's public site or a team member's public profile
     showing they do research/ML work, not just that the company exists.
   If nothing turns up for the category, ask for a link before issuing.
3. **Minors need a named parent or teacher contact.** If the requester identifies as a minor
   (or the description reads that way — e.g. a specific high school named as "my school"),
   the request must include a parent or teacher's name and a way to reach them. Don't issue
   without this; if it's missing, ask for it as the one follow-up.
4. **Use fits research, not production or clinical.** Skim the one-paragraph description
   against the excluded list above. Watch especially for a company request that's actually
   "we want to run this in front of customers" dressed up as "evaluating HLA/LLM behavior" —
   if the output would touch a real customer-facing pipeline rather than an internal study,
   it's commercial, not research. If it's ambiguous, ask one follow-up question before
   issuing.

If all checks pass, issue. If one is missing but the rest look legitimate (e.g., a
brand-new independent researcher with only a GitHub repo so far), ask for the missing piece
rather than declining outright.

## Issuing the key (steps only — do not run these yourself as an agent)

Keys live in the `KEYS` KV namespace the edge Worker reads (see `edge/src/keys.js`,
`edge/src/stripe.js` for the shape). For a research key:

1. Generate a key value the same way any manually-issued key is generated today (see the
   existing hand-issuance process — this doc does not change that mechanism).
2. Write a KV record with:
   - **tier**: `pro` (the free research key runs at the Pro tier's rate limit)
   - **label**: `research:<category>:<name>` — e.g. `research:indie:j-smith`,
     `research:umn:j-doe`, `research:acme-labs:team` — category first (`indie`, an
     institution/company slug, etc.) so a KV list scan groups sensibly. `edu:<institution>:
     <name>` records issued before this broadening keep working unchanged.
   - **status**: `active`
   - Optionally an `email` field (best contact address) for renewal outreach next year, and
     for a minor, a note of the parent/teacher contact in the label or a comment where the
     approval was tracked.
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
> A couple of things to keep in mind: this key is for research use only — not clinical
> decisions or patient care, and not for a production/commercial pipeline or resale. If you
> publish results using it, please cite HLA-Verify and IPD-IMGT/HLA (suggested citation is
> on hlaverify.com/research). Keys are personal or per team, so please don't share this one
> outside your project — email us if someone else needs their own. We'll check in around
> this time next year to renew it.
>
> API reference: https://hlaverify.com/api. MCP server details are in the same reference if
> you're wiring this into an agent.
>
> Let us know if anything doesn't work as expected.

**Decline (or request more info):**

> Subject: Re: Research key request
>
> Hi [name] — thanks for reaching out. Before I can issue a key, could you send [missing
> item: a bit more on your affiliation / a link showing the project or your work / a parent
> or teacher contact, since you mentioned you're a minor / a bit more detail on the research
> use]? The program covers research use by students, independent researchers, academic and
> non-profit researchers, and company research teams, and I want to make sure I've got that
> right before issuing.
>
> [If clearly out of scope — commercial, production, or clinical use:] Based on what you
> described, this sounds like [commercial/production pipeline / clinical] use rather than
> research, so the free program isn't the right fit — happy to talk about a paid key
> instead. See https://hlaverify.com/pricing or reply here and we'll figure out the right
> tier.

## Yearly renewal

Research keys are reissued on request, not silently expired. Roughly once a year from
issuance (use the KV record's issue date, or the `email` field to reach out), send a
one-line check-in: "Still using your HLA-Verify research key? Reply and we'll keep it active
for another year." No reply after a reasonable window (a month, two follow-ups) — mark the
key `status: revoked` rather than leaving it live indefinitely.

## Abuse and red flags

Decline or ask follow-up questions when you see:

- **Commercial domains or language** in the email or the described use (a company name with
  no research framing, a `.com` address with no stated affiliation, language like "our
  product," "our customers," or "we're shipping this to").
- **Clinical use** described directly — "for patient typing review," "to check reports
  before sign-out," "in our clinic." Redirect to the paid Laboratory tier and the trust page
  (not a medical device, but clearly a production use, not research).
- **A company request that's really a production pipeline in research clothing** — "we want
  to evaluate HLA/LLM behavior" that, on the follow-up question, turns out to mean running
  the key inside a customer-facing feature. Ask directly whether the key would ever touch a
  shipped product or a paying customer's data; if yes, it's commercial.
- **Reselling or embedding** the key in another product or service, including an internal
  tool used company-wide rather than by one research team.
- **A minor's request with no parent/teacher contact**, or one that doesn't check out on a
  follow-up ask.
- **Volume far out of proportion** to a research use (e.g., "millions of requests per day"
  from a single named independent researcher) — worth a clarifying question before issuing
  at Pro-tier limits.
- **Vague or copy-pasted requests** with no affiliation, no public trace, and no specific
  research use — ask for specifics before issuing.

When in doubt, ask one more question. It costs a day; issuing a key that gets used
commercially or clinically costs more to unwind.

## What we track

For traction evidence (SBIR, investor conversations, and just knowing the program is
working), keep a running count of:

- **Number of active research keys issued.**
- **Number of distinct institutions, companies, and independent researchers represented.**
- Optionally: a breakdown by category (student, independent, academic/non-profit, company
  research team), and whether any have published or cited HLA-Verify or the benchmark (worth
  a quick search around renewal time).

This doesn't require new infrastructure — a running tally next to the KV label list
(`research:<category>:<name>`, plus legacy `edu:<institution>:<name>` records) is enough at
this scale. Counts, never per-request content, matching the "nothing is stored" posture on
the rest of the product.

## SBIR narrative (broader impacts)

NSF SBIR full proposals ask for broader impacts beyond the commercial thesis. This program
is direct evidence: number of institutions, companies, and independent researchers using
deterministic HLA verification and the open benchmark, use in coursework (nomenclature
exercises, benchmark as a class project, agent/MCP teaching), and any resulting citations or
published work. Frame it as: the same engine that's commercializing in labs and with
LIMS/AI vendors is also lowering the barrier for anyone doing research on HLA nomenclature or
LLM behavior — students, independent researchers, academic labs, and company research teams
alike — which is the "broader impacts beyond the funded firm" reviewers look for. Keep the
specific numbers current in the draft rather than reusing this doc's placeholders.
