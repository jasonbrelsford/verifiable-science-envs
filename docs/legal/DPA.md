# HLA-Verify Data Processing Addendum (Template)

**DRAFT: prepared by an AI agent for attorney review. Not final. For use only when attached to a signed enterprise order form or pilot SOW.**

Version: 0.1-draft (2026-09-17)

This Data Processing Addendum ("DPA") supplements the Terms of Service (`TERMS_OF_SERVICE.md`) and the applicable order form or Statement of Work between Brelsford Software LLC ("Provider") and the customer named in that order form or SOW ("Customer"), to the extent Customer requires one for its own compliance purposes. In the event of a conflict between this DPA and the Terms, this DPA controls with respect to data processing only.

The Service performs nomenclature and reference-release validation of HLA allele names, typings, and match arithmetic against a pinned IPD-IMGT/HLA release; it is not clinical decision support (see `TERMS_OF_SERVICE.md` Section 3, which scopes any "decision support" language to the `/v1/compat` endpoint and the `donor_compat` MCP tool specifically).

## 1. Roles

1.1 For the limited data described in Section 2, Customer is the **controller** and Provider is the **processor**, acting only on Customer's documented instructions as set out in the Terms and this DPA.

1.2 **API and MCP inputs are processed transiently and are not stored.** Request bodies submitted to the REST endpoints (`/v1/verify`, `/v1/normalize`, `/v1/allele/{name}`, `/v1/match`, `/v1/typing/check`, `/v1/compat`, `/v1/glstring`) and to the equivalent MCP tool calls on `/mcp` are held in memory only for the duration needed to compute and return a response, and are discarded immediately after. Provider does not persist, log, or retain the content of these requests.

1.3 The only data persisted by Provider in connection with the Service are: (a) a per-key, per-request usage count, endpoint, and tier (Cloudflare Analytics Engine); (b) a key label, status, and Customer's billing contact email associated with the API key (Cloudflare KV); and (c) if Customer's users sign in to the MCP server via OAuth, short-lived single-use markers containing no personal data (Cloudflare KV, minutes to 30 days TTL — see `docs/MCP_OAUTH.md`). This is account-administration data, not Customer's substantive data, and Provider processes it as an independent controller for its own account-management and billing purposes, not as Customer's processor.

## 2. No PHI without a BAA

2.1 Customer will not submit protected health information (PHI), as defined under HIPAA, or any other data that would make Provider a "business associate" under HIPAA, through the Service unless a separate, signed Business Associate Agreement has been executed between the parties under a distinct enterprise agreement.

2.2 Provider does not offer a Business Associate Agreement at self-serve tiers (`starter`, `lab`, `scale`, or the legacy `pro` alias). A BAA is available, if at all, only as a bespoke addition to an enterprise agreement, negotiated case by case, and only where Provider determines the use case and its architecture can support that undertaking.

2.3 Absent an executed BAA, Customer will submit only de-identified allele names, typing strings, GL strings, and HLA report text, consistent with Section 5.1 of the Terms.

## 3. Security measures

Provider maintains the following technical and organizational measures for the Service:

- **Encryption in transit.** All endpoints are served over TLS.
- **No persistence of inputs.** Request bodies are processed in memory and discarded; there is no database of submitted content to secure, back up, or breach.
- **Least-privilege API keys.** Each key is scoped to a tier with a defined rate limit; keys can be revoked immediately on request or on subscription cancellation.
- **Revocation.** A compromised or unwanted key is revoked by Customer through the Stripe customer portal (self-serve tiers) or on request to hello@hlaverify.com (enterprise), taking effect immediately.
- **Reference data integrity.** Reference data are fetched from the official IPD-IMGT/HLA source and verified against the release's published checksum before use.
- **Infrastructure.** The Service runs on Cloudflare's edge network (Workers, KV, Analytics Engine); Provider relies on Cloudflare's platform-level security controls for the infrastructure layer.

## 4. Subprocessors

| Subprocessor | Function | Location (as publicly disclosed) |
|---|---|---|
| Cloudflare, Inc. | Hosting, edge compute, key storage, rate limiting, usage metering | Global edge network, US-headquartered |
| Stripe, Inc. | Payment processing, subscription and billing-contact records | US-headquartered, global processing |

Provider will notify Customer of any new subprocessor with access to Customer's account-administration data with reasonable advance notice, and Customer may object on reasonable data-protection grounds, in which case the parties will work in good faith to find a resolution.

## 5. Breach notification

Provider will notify Customer without undue delay, and in any event within 72 hours of confirming, any breach of security affecting Customer's account-administration data held by Provider (Section 1.3). Because API request content is not stored, the scope of any such notice is expected to be limited to account-administration data (key records, billing contact) rather than substantive input data, which does not exist in Provider's systems to be breached.

## 6. Deletion on termination

On termination of the applicable order form or SOW, Provider will, within 30 days of Customer's written request: (a) revoke all API keys issued to Customer; and (b) delete the key record and associated billing-contact data from Cloudflare KV, except to the extent retention is required for billing records, tax compliance, or legal claims, in which case that residual data will be retained only for the applicable statutory period and processed only for that purpose.

## 7. Audit

Provider will respond to a reasonable written security or compliance questionnaire from Customer, no more than once per 12-month period absent a security incident, describing Provider's technical and organizational measures under this DPA. Given the transient, non-persistent design of the Service, an on-site or system-access audit is not offered under the standard enterprise agreement; Customer requiring a more extensive audit right should raise it during commercial negotiation.

## 8. International transfers

8.1 Provider's subprocessors (Section 4) may process data in the United States. If Customer requires a cross-border transfer mechanism (for example, because Customer is subject to the EU GDPR or UK GDPR), the parties will incorporate the European Commission's Standard Contractual Clauses (Module 2, Controller-to-Processor), or the UK International Data Transfer Addendum, by reference into this DPA as an exhibit, on Customer's request, before any such transfer of personal data subject to those regimes occurs.

8.2 Given the Service's design (no persisted request content, minimal account-administration data), Provider expects most Customer engagements not to involve a reportable cross-border transfer of regulated personal data at all; this section exists for the enterprise Customer whose facts differ.

## 9. Term

This DPA remains in effect for as long as the underlying order form or SOW is in effect, and survives termination to the extent needed to give effect to Sections 5, 6, and 7.

## 10. Signatures

| Brelsford Software LLC | [Customer] |
|---|---|
| Name: Jason Brelsford | Name: |
| Title: Owner | Title: |
| Date: | Date: |

---

*This document is a draft template prepared by an AI agent for attorney review. It has not been reviewed by a licensed attorney and should not be executed with a customer until reviewed and, where needed, adapted to that customer's specific facts (particularly Section 8 if EU/UK personal data is genuinely involved).*
