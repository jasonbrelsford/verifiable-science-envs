# Terms of Service — HLA-Verify (hlaverify.com / api.hlaverify.com)

*Drafted 2026-09-16 by an AI coding assistant, for Brelsford Software LLC
(Jason Brelsford). **This is a draft for attorney review, not a final or binding
document.** Do not publish or rely on this text until counsel has reviewed it
against the operator's actual entity structure, jurisdiction, and insurance
position. Governing law and a few entity details below are placeholders — see
the bracketed notes.*

## 1. Who this covers

These Terms of Service ("Terms") govern use of the HLA-Verify API, MCP server,
web demo, and documentation site (together, the "Service"), operated by
Brelsford Software LLC ("we," "us," "the operator") at hlaverify.com and
api.hlaverify.com. By sending a request to the Service — with or without an API
key — you ("you," "the user") agree to these Terms.

## 2. What the Service is (and is not)

The Service computes deterministic HLA nomenclature and donor–recipient
matching verdicts from the pinned IPD-IMGT/HLA reference release, using rules
documented in the project's public generators and graders
(github.com/jasonbrelsford/verifiable-science-envs). It answers questions about
whether an HLA allele name or a match assertion is consistent with the
reference database — it does not interpret clinical significance, does not
recommend a course of treatment, and does not replace review by a qualified
histocompatibility professional.

**Not a medical device. Not clinical decision support.** The Service is a
reference-verification and nomenclature tool. It is not FDA-cleared or
approved, is not intended to diagnose, treat, cure, or prevent any disease or
condition, and must not be used as the sole basis for a clinical
transplantation, donor-selection, or patient-care decision. Output should be
treated as an automated cross-check against a specific dated release of a
public reference database, reviewed by qualified personnel before any clinical
use.

## 3. Tiers and access

- **Free tier (unkeyed):** requests without an API key are rate-limited by
  source IP (currently 60 requests/minute; see `/pricing` for the current
  figure, which may change).
- **Keyed tiers (starter, pro, enterprise):** issued after a Stripe checkout,
  rate-limited per key at a higher ceiling than the free tier; enterprise keys
  are currently uncapped. Current tier limits and pricing are published at
  `https://api.hlaverify.com/pricing` and control over anything stated here in
  case of conflict.
- We may suspend or revoke a key for abuse (attempted rate-limit evasion,
  reselling access outside a signed agreement, or use that violates §2 or §5)
  or on cancellation of the underlying Stripe subscription.

## 4. Data handling

The Service is designed to store nothing about the content of your requests:
request bodies (allele names, typing data, match queries) are processed in
memory for the duration of the request and discarded; they are not logged, not
written to persistent storage, and not used to train any model. Usage metering
records aggregate counts per key/tier label (for billing and rate-limiting)
never the content of a request. This description matches the implementation as
of this draft (`edge/src/index.js`, `edge/src/stripe.js`) — see
`docs/legal/PRIVACY_POLICY.md` (once drafted) for the fuller privacy
description and how to verify this claim against the deployed code, which is
open source.

Because no personal health information is knowingly collected or retained,
users are responsible for not submitting data that would make the request
itself PHI under HIPAA or an equivalent regime for their jurisdiction (e.g.,
do not include patient names, MRNs, or other direct identifiers in a query —
allele and typing strings alone are not, by themselves, treated as PHI by this
Service, but the operator makes no representation about your own regulatory
obligations for the data you choose to send).

## 5. Licence boundary — what you may and may not do

- The **verification Service itself** (the hosted API, MCP server, and the
  `edge/` and `sci_envs/service/` code that implement it) is licensed to run
  as a hosted service under the **PolyForm Noncommercial License 1.0.0**. Using
  the *hosted* Service (api.hlaverify.com) for your own purposes — including
  commercial purposes, via a paid key — is permitted under these Terms; PolyForm
  Noncommercial restricts *self-hosting or redistributing the underlying
  software* for a commercial purpose without a separate commercial licence from
  the operator, not the ordinary use of the hosted API.
- The **benchmark, task generators, and graders** (HLA-Bench) are separately
  released under **Apache-2.0** and may be used, modified, and redistributed
  under that licence's terms.
- Reference data (IPD-IMGT/HLA) is licensed CC-BY-ND by its publisher and is
  never redistributed by the Service; the Service computes against it and
  returns verdicts, not the underlying database.
- If you want to self-host the verification Service commercially, or need
  redistribution rights broader than PolyForm Noncommercial allows, contact the
  operator about a commercial licence.

## 6. Liability limitation

**[Draft language — counsel should confirm this against the operator's actual
insurance and entity structure before this is relied upon.]**

To the maximum extent permitted by applicable law: the Service is provided "as
is" and "as available," without warranties of any kind, express or implied,
including merchantability, fitness for a particular purpose, and
non-infringement. The operator does not warrant that the Service will be
uninterrupted, error-free, or that its verdicts are complete or fit for any
particular clinical, regulatory, or commercial purpose. To the maximum extent
permitted by law, the operator's total liability for any claim arising out of
or relating to the Service is limited to the greater of (a) the amount you
paid the operator for the Service in the 12 months preceding the claim, or (b)
USD $100. The operator is not liable for indirect, incidental, consequential,
special, or punitive damages, including any damages arising from a clinical or
treatment decision made in reliance on Service output in violation of §2.

## 7. Changes to the Service and these Terms

We may change pricing, rate limits, or the Service itself at any time; the
current state of `/pricing` and this document govern. We may update these
Terms; continued use of the Service after an update constitutes acceptance of
the revised Terms. Material changes will be reflected in this file's git
history, which is public.

## 8. Governing law

**[Placeholder — counsel to confirm.]** These Terms are governed by the laws of
the State of **[Minnesota — placeholder; confirm against Brelsford Software
LLC's actual state of formation/registration]**, without regard to its
conflict-of-laws principles, and any dispute will be resolved in the state or
federal courts located in that state, unless applicable law requires
otherwise.

## 9. Contact

Questions about these Terms: hello@hlaverify.com.

---

*Status: draft only, not reviewed by an attorney, not yet published on
hlaverify.com. See also `docs/legal/PRIVACY_POLICY.md` and
`docs/legal/DPA_TEMPLATE.md` (to be drafted) for the companion documents this
Terms draft cross-references.*
