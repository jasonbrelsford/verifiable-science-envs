# HLA-Verify Privacy Policy

**DRAFT: prepared by an AI agent for attorney review. Not final.**

Effective date: [EFFECTIVE DATE, not yet published]
Version: 0.1-draft (2026-09-17)

This Privacy Policy describes how Brelsford Software LLC ("we," "us") handles information in connection with hlaverify.com, api.hlaverify.com, the HLA-Verify API, and the HLA-Verify MCP server (together, the "Service"). It is written to describe what the Service actually does, verified against its implementation as of this draft.

## 1. Who we are

Brelsford Software LLC, a [Minnesota — placeholder; confirm against Brelsford Software LLC's actual state of formation/registration, per `TERMS_OF_SERVICE.md` Section 15.1] limited liability company. Contact: hello@hlaverify.com.

## 2. What the website collects

- **Cloudflare edge logs.** hlaverify.com and api.hlaverify.com are served from Cloudflare's network. Cloudflare logs standard connection metadata (IP address, request path, timestamp, user agent) as part of operating the edge network and our Cloudflare account's own analytics. We do not add first-party cookies or a separate analytics script.
- **No cookies, no behavioral analytics.** The site does not set tracking cookies and does not run a third-party analytics or advertising script. Aggregate, anonymous traffic counts visible in Cloudflare's dashboard are the only "analytics" in use.

## 3. What the API and MCP server process

- **Request bodies are processed in memory only and are not stored.** The Cloudflare Worker that runs the API and the MCP server (`edge/`) computes a response from your input and the pinned IPD-IMGT/HLA release, returns it, and discards the request body. Source: `edge/src/index.js` header ("Stores nothing: request bodies are processed in memory and discarded"). This applies equally to REST calls and to MCP `tools/call` requests, which run the same handlers.
- **IP address for rate limiting, never retained.** Requests are rate-limited per source IP using Cloudflare's per-minute rate-limiting bindings. Anonymous (`free`-tier) requests are additionally subject to a daily call quota counted per IP: the counter is addressed by a salted SHA-256 digest of the UTC day, a server-side secret, and the address (`edge/src/quota.js`), not by the address itself, and a fresh digest applies at each UTC midnight — so no history of IP addresses is retained, and a digest from a prior day cannot be linked back to an address without the secret.
- **Per-key and per-request usage counts, not content.** We record, in Cloudflare Analytics Engine, a count of requests by key label, endpoint, response status, whether the caller was keyed or anonymous, and tier — for billing accuracy, reliability monitoring, and abuse detection (`edge/src/index.js` `meter()`). We do not record what you sent or what the Service returned.
- **Key label and billing email in Cloudflare KV.** For keyed access issued through Stripe, we store a key record consisting of a label (typically your checkout email or name), tier, status (active/revoked), the billing email associated with your Stripe subscription, creation date, the provider ("stripe"), and an internal reference used to look the record up again from a Stripe subscription or payment id (`edge/src/stripe.js`). This is account-administration data, not the content of your requests.
- **OAuth sign-in for the MCP server.** If you connect an MCP client via OAuth sign-in (`/oauth/*`), the consent step asks for an API key you already hold; the issued access and refresh tokens are self-contained encrypted values, not stored on our servers, and decrypt back to the same key record described above. The only KV entries this flow writes are short-lived, random single-use markers (e.g. `oauth/used/code/<random id>`, `oauth/revoked-family/<random id>`) that contain no personal data and expire on their own (minutes to 30 days) (`edge/src/oauth.js`, `docs/MCP_OAUTH.md`).
- **Beta signup list.** If you join the free public beta's notification list (`POST /v1/beta-signup`, or the `beta_signup` MCP tool), we store the email address you provide, any optional organization, use-case, and source fields you include, a timestamp, and your request's `CF-IPCountry` (a country code, not an IP address) in Cloudflare KV (`edge/src/handlers.js`). This record is not an API key and cannot be used to authenticate.
- **We never see your card number.** Stripe processes payment and holds your card details; we receive only a customer ID, subscription status, and the billing email, through Stripe's webhook and API.

## 4. The in-browser demo

The demo at hlaverify.com/demo runs entirely in your browser. Typing data you enter there is processed client-side and never transmitted to our servers or anyone else's. The same is true of the mirrored demo Space on Hugging Face.

## 5. Do not send us protected health information

The Service is designed so that nothing you send is stored, but it is not designed to detect or block protected health information (PHI) or other personal identifiers. **Do not submit patient names, medical record numbers, dates of birth, or any other identifier tied to a real person.** Submit de-identified allele names, typing strings, GL strings, and HLA report text only. See `TERMS_OF_SERVICE.md` Section 5.1. If you have a use case that you believe requires sending identifiable health information, contact us before doing so; see `DPA.md` for enterprise arrangements.

## 6. Subprocessors and third parties

| Subprocessor | Role |
|---|---|
| Cloudflare, Inc. | Hosts the website and API (Workers, KV, Analytics Engine, edge network, rate limiting). |
| Stripe, Inc. | Processes payments, manages subscriptions, and holds payment card data. We never receive full card numbers. |
| GitHub, Inc. | Hosts the public source repository (open-source components only; not a data processor for API traffic). |
| Hugging Face, Inc. | Hosts the public benchmark dataset and a mirrored copy of the in-browser demo Space. |

We do not sell personal information, and we do not share account-administration data (Section 3) with any party other than the subprocessors above and as required by law.

## 7. Retention

- Request bodies: not retained (processed in memory, discarded immediately after generating a response), for both REST and MCP calls.
- Usage counts and tier: retained for the life of the account plus a limited period for billing records and dispute resolution.
- Key label and billing email: retained until the key is revoked or the account is closed, plus a limited period thereafter for billing records.
- OAuth single-use markers: expire automatically within minutes to 30 days, per the table in `docs/MCP_OAUTH.md`; nothing about a completed sign-in is retained beyond that.
- Beta signup records: retained until self-serve checkout opens for the tier you asked about and you either obtain a key or ask us to remove the record, whichever is sooner; otherwise retained while the beta program continues.
- Edge logs held by Cloudflare: retained per Cloudflare's own standard retention practice for our account tier, not independently extended by us.

## 8. Your rights (GDPR / CCPA basics for business contacts)

Because the Service is sold to businesses and we hold minimal personal data (primarily a billing contact's name and email), our data-subject obligations are narrow, but we will honor a reasonable request from a business contact to:

- Access the account-administration data we hold about you (key label, tier, billing email).
- Correct inaccurate account-administration data.
- Delete your account-administration data on account closure, subject to legally required billing-record retention.

If you are located in the EU/EEA/UK or California and believe GDPR or the CCPA/CPRA applies to your relationship with us, contact hello@hlaverify.com and we will respond consistent with applicable law. We do not currently have a dedicated EU representative or a formal CCPA "Do Not Sell" mechanism, because we do not sell personal information and process a very limited data set; this will be revisited if our customer base or data practices change.

## 9. Children

The Service is not directed to, and we do not knowingly collect information from, anyone under 18. It is a B2B product intended for laboratory, registry, and platform-engineering use.

## 10. Changes to this policy

We may update this policy by posting a revised version at hlaverify.com/privacy with a new effective date. Material changes affecting keyed customers will be flagged in the API docs or by email where we have contact information.

## 11. Contact

Brelsford Software LLC
hello@hlaverify.com
hlaverify.com

---

*This document is a draft prepared by an AI agent for attorney review, checked against `edge/src/index.js`, `edge/src/stripe.js`, `edge/src/quota.js`, `edge/src/oauth.js`, `edge/src/handlers.js`, and `docs/MCP_OAUTH.md` as of 2026-09-17. It has not been reviewed by a licensed attorney and is not in effect until an effective date is set following that review and it is published at hlaverify.com/privacy.*
