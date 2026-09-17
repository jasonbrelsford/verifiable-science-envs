# Terms of Service — HLA-Verify (hlaverify.com / api.hlaverify.com)

*Drafted 2026-09-16 by an AI coding assistant, merged and reconciled with a second
draft on 2026-09-17, for Brelsford Software LLC (Jason Brelsford). **This is a
draft for attorney review, not a final or binding document.** Do not publish or
rely on this text until counsel has reviewed it against the operator's actual
entity structure, jurisdiction, and insurance position. Governing law and a few
entity details below are placeholders — see the bracketed notes.*

Effective date: [EFFECTIVE DATE, not yet published]

## 1. Who this covers

These Terms of Service ("Terms") govern access to and use of the HLA-Verify
API, MCP server, web demo, and documentation site (together, the "Service"),
operated by Brelsford Software LLC ("we," "us," "the operator") at
hlaverify.com and api.hlaverify.com. By sending a request to the Service —
anonymously, with an API key, or through an OAuth-authorized MCP client — you
("you," "the user") agree to these Terms.

## 2. Eligibility and authority to bind

2.1 The Service is offered for business and professional use only, not for
personal, family, or household use. By using the Service you represent that
you are acting in a business or professional capacity.

2.2 If you are accepting these Terms on behalf of a company or other legal
entity, you represent that you have the authority to bind that entity, and
"you" and "Customer" refer to that entity.

2.3 You must be at least 18 years old and capable of forming a binding
contract to use the Service.

## 3. What the Service is (and is not)

The Service computes deterministic HLA nomenclature and donor–recipient
matching verdicts from a pinned IPD-IMGT/HLA reference release, using rules
documented in the project's public generators and graders
(github.com/jasonbrelsford/verifiable-science-envs), delivered via a REST API
and an MCP server (`POST /mcp`) exposing the same lookups as tools. It answers
questions about whether an HLA allele name or a match assertion is consistent
with the reference database — it does not interpret clinical significance and
does not replace review by a qualified histocompatibility professional.

**Nomenclature and reference-release validation, not clinical decision
support.** The Service is a research-and-evaluation tool. It is not FDA-cleared
or approved, is not intended to diagnose, treat, cure, or prevent any disease
or condition, and must not be used as the sole basis for a clinical,
laboratory-release, or transplant decision. Output should be treated as an
automated cross-check against a specific dated release of a public reference
database, reviewed by qualified personnel before any clinical use. The phrase
"decision support only; not a medical device" as used in the Service's own
documentation and MCP tool descriptions is scoped specifically to the
donor/recipient compatibility feature (the `/v1/compat` endpoint and the
`donor_compat` MCP tool); every other endpoint and tool is nomenclature and
match-arithmetic checking against the pinned release, not decision support of
any kind.

## 4. Accounts, API keys, tiers, and OAuth sign-in

4.1 Anonymous use is available at the `free` tier, rate-limited per source IP
(see `/pricing` for the current figure, which may change).

4.2 Paid tiers (currently `starter`, `lab`, `scale`) are issued as API keys,
ordinarily through self-serve checkout via Stripe; `enterprise` keys and any
volume licensing are issued by separate arrangement. Keys previously issued
under the tier name `pro` continue to work and receive the `lab` tier's
limits. During the Service's free public beta, paid-tier keys may instead be
issued by hand, free for the duration of the beta; current availability is
stated at `/pricing` and `/docs`.

4.3 You may join the beta notification list (`POST /v1/beta-signup`, or the
`beta_signup` MCP tool) to be notified when self-serve checkout for a tier
opens. Joining the list does not itself issue a key or create a subscription.

4.4 The MCP endpoint (`/mcp`) additionally supports OAuth sign-in for clients
that support it: the consent flow asks you for an API key you already hold and
binds an access token to it, so no new account is created and no key is
disclosed to the client. Using an OAuth-authorized MCP client is use of the
Service under these Terms to the same extent as presenting the key directly.

4.5 You are responsible for safeguarding any API key issued to you, and for
all activity under it or under an OAuth token bound to it. Notify us promptly
at hello@hlaverify.com of any suspected unauthorized use.

4.6 We may suspend or revoke a key for abuse (attempted rate-limit evasion,
reselling access outside a signed agreement, or use that violates Section 3 or
Section 5), for non-payment, or on cancellation of the underlying Stripe
subscription, with notice where practicable.

4.7 Tier limits, pricing, and features are as published at
`https://api.hlaverify.com/pricing` and `/docs`, and control over anything
stated in these Terms in case of conflict.

## 5. Acceptable use

You agree not to, and not to permit any third party to:

5.1 Submit protected health information (PHI), patient names, medical record
numbers, or any other personal identifier to the Service. Submit de-identified
allele names, typing strings, GL strings, and HLA report text only.

5.2 Scrape, bulk-extract, or systematically reproduce the underlying
IPD-IMGT/HLA reference tables or any other dataset exposed by the Service,
other than through the documented API and MCP endpoints for your own permitted
use.

5.3 Reverse engineer, decompile, or disassemble the Service, except to the
extent such restriction is prohibited by applicable law.

5.4 Exceed the rate limits or daily call quota of your tier, attempt to
circumvent rate limiting or quota metering, or share a single API key or OAuth
credential across unrelated organizations.

5.5 Resell, sublicense, or offer the Service (or a product substantially
derived from it) to third parties without a separate commercial licence from
us covering that use.

5.6 Use the output of the Service as the sole basis for any clinical,
transplant, laboratory-release, or patient-care decision. The Service is a
research-and-evaluation verification tool; it supports and does not replace
clinical judgement, laboratory director review, or professional standards of
care.

5.7 Use the Service in a manner that violates applicable law, infringes
third-party rights, or interferes with the Service's operation or other
users' access.

Violation of this Section 5 is a material breach and grounds for immediate
suspension or termination.

## 6. Fees, billing, taxes, cancellation, refunds

6.1 Paid tiers are billed through Stripe on a subscription basis at the rates
published at `/pricing`. Enterprise fees are as stated in a signed order form.

6.2 You authorize Stripe to charge your payment method on file for recurring
fees. We do not receive or store your card number; see the Privacy Policy
(`PRIVACY.md`).

6.3 Fees are exclusive of taxes. You are responsible for any sales, use, VAT,
or similar taxes applicable to your purchase, other than taxes on our net
income.

6.4 You may cancel a subscription at any time through the Stripe customer
portal link in your receipt; cancellation takes effect at the end of the
current billing period, and your API key is revoked at that time or on
non-renewal.

6.5 Fees are non-refundable except as required by law or as expressly stated
in a signed order form.

## 7. Release pinning

7.1 Every verdict the Service returns is computed against a named, pinned
IPD-IMGT/HLA release, stated in every response (the `release` field) and at
`/healthz`. A verdict for the same input may change when the pinned release
changes — for example, at a quarterly IPD-IMGT/HLA update.

7.2 Keyed customers receive a diff of changed verdicts, or advance notice of a
pending release change, where practicable. You are responsible for tracking
which release a given verdict was computed against if that matters to your
use case, and for re-checking any hardcoded expected verdicts against the
current release before relying on them.

## 8. Data handling

The Service is designed to store nothing about the content of your requests:
request bodies (allele names, typing data, GL strings, match queries) are
processed in memory for the duration of the request and discarded; they are
not logged, not written to persistent storage, and not used to train any
model. Usage metering records aggregate counts per key/tier label (for
billing, rate-limiting, and abuse detection), never the content of a request.
This description is a summary; the Privacy Policy (`PRIVACY.md`) is the fuller
description and, in the event of a conflict about data handling specifically,
controls.

Because no personal health information is knowingly collected or retained,
you are responsible for not submitting data that would make a request itself
PHI under HIPAA or an equivalent regime in your jurisdiction — see Section 5.1.
Allele and typing strings alone are not, by themselves, treated as PHI by this
Service, but the operator makes no representation about your own regulatory
obligations for the data you choose to send. Enterprise and pilot customers
who require a data processing addendum may request one from
hello@hlaverify.com; it is issued alongside a signed order form, not as a
standing public document.

## 9. Intellectual property and third-party data

9.1 **Ours.** Brelsford Software LLC and its licensors own all right, title,
and interest in the Service, including the API, the MCP server, the matching
rules engine, and all software, other than the open-source and third-party
components identified below.

9.2 **Licence boundary for the Service's own code.** The hosted verification
Service itself (the API, the MCP server, and the `edge/` and
`sci_envs/service/` code that implement it) is licensed under the **PolyForm
Noncommercial License 1.0.0**. Using the *hosted* Service (api.hlaverify.com)
for your own purposes — including commercial purposes, via a paid key — is
permitted under these Terms; PolyForm Noncommercial restricts *self-hosting or
redistributing the underlying software* for a commercial purpose without a
separate commercial licence from the operator, not the ordinary use of the
hosted API. If you want to self-host the verification Service commercially, or
need redistribution rights broader than PolyForm Noncommercial allows, contact
the operator about a commercial licence.

9.3 **The benchmark.** The benchmark, task generators, and graders (HLA-Bench)
are separately released under **Apache License 2.0** and may be used,
modified, and redistributed under that licence's terms.

9.4 **Third-party reference data.** Allele names, nomenclature, and related
facts are derived from the IPD-IMGT/HLA database (Barker DJ et al., *Nucleic
Acids Research* 2025), licensed **CC-BY-ND** by its publisher, fetched from the
official source, and never redistributed in bulk by the Service — the Service
computes against it and returns verdicts, not the underlying database.
Attribution accompanies every API response and must not be removed from any
output you redistribute.

9.5 **Your data.** As between you and us, you retain all right, title, and
interest in the inputs you submit to the Service ("Customer Data") and in the
outputs generated for you ("Outputs"), subject to our and our licensors'
underlying rights in the Service and the reference data described in 9.4. We
claim no ownership of Customer Data or Outputs.

## 10. Warranty disclaimer

**[Draft language — counsel should confirm this against the operator's actual
insurance and entity structure before this is relied upon.]**

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE AND ALL OUTPUTS
ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND,
EXPRESS, IMPLIED, OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR COMPLETENESS. The operator
does not warrant that the Service will be uninterrupted or error-free, or that
every verdict is correct or fit for any particular clinical, regulatory, or
commercial purpose. **No reliance:** you may not rely on any Output as the
sole or primary basis for a clinical, laboratory-release, transplant,
regulatory, or other consequential decision, and you are solely responsible
for independently reviewing the basis for any Output before acting on it, and
for compliance with all laws and professional standards applicable to your
use of the Service.

## 11. Limitation of liability

11.1 TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE TO
THE OTHER FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY
DAMAGES, OR FOR LOST PROFITS, LOST DATA, OR LOSS OF GOODWILL, ARISING OUT OF OR
RELATING TO THESE TERMS OR THE SERVICE, REGARDLESS OF THE THEORY OF LIABILITY,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES — including any damages
arising from a clinical or treatment decision made in reliance on Service
output in violation of Section 3 or Section 5.6.

11.2 Except for your payment obligations and your indemnification obligations
under Section 12, each party's aggregate liability arising out of or relating
to these Terms will not exceed the greater of (a) the amount you paid the
operator for the Service in the 12 months preceding the claim, or (b) USD 100.

11.3 The limitations in this Section 11 do not apply to a party's gross
negligence, wilful misconduct, or fraud, or to liability that cannot be
limited or excluded as a matter of law.

## 12. Customer indemnification

You will defend, indemnify, and hold harmless Brelsford Software LLC and its
officers, employees, and agents from and against any third-party claim, and
associated damages, costs, and reasonable attorneys' fees, arising out of or
relating to: (a) your use of the Service; (b) any data you submit, including
any PHI or personal identifier submitted in breach of Section 5.1; (c) your
breach of these Terms or applicable law; or (d) any claim by a patient,
transplant recipient, or other third party arising from a clinical,
laboratory, or transplant decision made by you or your organization.

## 13. Term and termination

13.1 These Terms apply from your first use of the Service and continue until
terminated as described here.

13.2 You may terminate by cancelling your subscription (Section 6.4) or
ceasing use of the free tier.

13.3 We may suspend or terminate your access for breach of Section 5,
non-payment, or as required by law, with notice where practicable.

13.4 Sections 6.5, 7, 8, 9, 10, 11, 12, 15, and 16 survive termination.

## 14. Changes to the Service and these Terms

We may change pricing, rate limits, or the Service itself at any time; the
current state of `/pricing` and this document govern. We may modify these
Terms prospectively by posting an updated version at hlaverify.com/terms with
a new effective date; material changes will also be flagged in the API docs
or by email to keyed customers where we have contact information. Continued
use of the Service after the effective date of an update constitutes
acceptance of the revised Terms. Material changes will also be reflected in
this file's git history, which is public.

## 15. Governing law, venue, and dispute resolution

**[Placeholder — counsel to confirm.]**

15.1 These Terms are governed by the laws of the State of **[Minnesota —
placeholder; confirm against Brelsford Software LLC's actual state of
formation/registration]**, without regard to its conflict-of-laws principles.

15.2 The parties consent to the exclusive jurisdiction and venue of the state
and federal courts located in Hennepin County, Minnesota, for any dispute
arising out of or relating to these Terms, unless applicable law requires
otherwise.

15.3 [Optional, for counsel to consider: a binding arbitration clause with a
class-action waiver could be added here if counsel determines it is
advantageous and enforceable against the Customer base; not adopted in this
draft.]

## 16. General

16.1 These Terms, together with any signed order form or DPA, constitute the
entire agreement between you and us regarding the Service and supersede any
prior agreements on the subject.

16.2 If any provision of these Terms is held unenforceable, the remaining
provisions remain in full force, and the unenforceable provision will be
modified to the minimum extent necessary to make it enforceable.

16.3 You may not assign these Terms without our written consent; we may
assign these Terms in connection with a merger, acquisition, or sale of
assets.

16.4 Our failure to enforce a provision is not a waiver of our right to do so
later.

## 17. Contact

Brelsford Software LLC
hello@hlaverify.com
hlaverify.com

Questions about these Terms: hello@hlaverify.com.

---

*Status: draft only, not reviewed by an attorney, not yet published on
hlaverify.com. See also `docs/legal/PRIVACY.md`, the companion document this
Terms draft cross-references. A data processing addendum template and a
research memo on the reasoning behind Sections 10-12 (the AWS/Stripe/Twilio
liability-cap comparison and the FDA Clinical Decision Support analysis) are
maintained in the operator's private contract pack, not in this public
directory — see `docs/README.md`.*
