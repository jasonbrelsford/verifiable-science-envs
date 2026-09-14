# Claude Connectors Directory readiness — api.hlaverify.com/mcp

Re-verified 2026-09-14 against primary sources (not the 2026-09-14 research brief, which was
itself flagged as needing re-verification). Every claim below is sourced; anything I could not
confirm from a primary source is marked **UNVERIFIED**.

## 1. Is an authless connector acceptable, or is OAuth mandatory?

**Authless ("none") is officially supported for directory listing.** This overturns the
2026-09-14 research brief's framing of OAuth as a "hard requirement."

Source: [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication),
"Supported authentication types" table — `none` / "No authentication (authless server)" /
Availability: **Supported**. An optional partial-auth ("lazy auth") mode is experimental.

The submission-requirements list on
[claude.com/docs/connectors/building/submission](https://claude.com/docs/connectors/building/submission)
says "Authentication: Use OAuth 2.0 for **authenticated** services" — i.e. IF the connector
requires login, it must be OAuth 2.0, not some other scheme (API key in the URL, Basic auth,
etc). It does not say every connector must require login.

**Decision:** we still build full OAuth 2.1 (per the COO's design) because it lets an existing
HLA-Verify API-key holder authenticate through Claude's native "Connect" UI instead of pasting a
key into a custom-header field, and because it future-proofs a paid tier. But per-tool
authentication is **not** turned on for any tool: every tool stays reachable anonymously,
exactly as today, satisfying "authless is acceptable" *and* "backward compatibility is
mandatory" simultaneously. See §6.

## 2. Requirements checklist (source URLs inline)

| # | Requirement | Source | Status |
|---|---|---|---|
| 1 | Submission happens in the claude.ai org admin portal (Team/Enterprise org, Owner or delegated Directory role), not a public form. | [submission](https://claude.com/docs/connectors/building/submission) | Confirms brief. Jason must have/create a Team or Enterprise Claude org to submit. |
| 2 | Transport: "streamable HTTP or SSE" are both offered as connection options in the portal. | [submission](https://claude.com/docs/connectors/building/submission) ("Connection" step) | Our `/mcp` is already stateless Streamable HTTP (no SSE) — compliant; brief's claim that "SSE rejected" is **not what the current portal page says** (SSE is listed as a selectable transport) — correct the brief. |
| 3 | Every tool needs a `title` and the applicable `readOnlyHint`/`destructiveHint` annotation. | [submission](https://claude.com/docs/connectors/building/submission) + [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | **Implemented** — see §5. |
| 4 | Tool names ≤ 64 chars; descriptions must precisely match behavior; no catch-all read+write tool; freeform-query tools must link API docs. | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | All our tools are single-purpose read-only calls into fixed handlers (no freeform query tool) — compliant, no changes needed beyond annotations. |
| 5 | No prompt-injection patterns in tool descriptions (no instructions to call other tools, no hidden/encoded instructions, no behavior overrides). | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | Reviewed our 7 tool descriptions — none instruct Claude's behavior, all describe function only. Compliant. |
| 6 | Every tool must succeed on valid input with actionable errors on invalid input; no bare "Internal Server Error". | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | Existing `errResult()` returns descriptive `detail` strings (e.g. "name must be a string") — compliant. |
| 7 | Connector must call its own first-party API (or a legitimately proxied one); domain must match the service. | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | `api.hlaverify.com` is Brelsford Software LLC's own domain/API — compliant. |
| 8 | Unsupported use cases: no financial transactions, no AI-generated image/video/audio. | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | N/A — HLA-Verify does neither. |
| 9 | **Authentication**: OAuth 2.0 required *only if* the service is authenticated; `none` (authless) is a first-class supported option. | [authentication](https://claude.com/docs/connectors/building/authentication) | See §1. We add OAuth anyway (optional upgrade path). |
| 10 | Privacy policy: brief said "local connectors must include..." — that section of the submission page is titled for **local/desktop connectors (MCPB)** with a `manifest.json`/README requirement. For a **remote** MCP server the requirement instead surfaces in the portal's "Listing" step as a required **Privacy Policy URL** field, and a public docs URL. | [submission](https://claude.com/docs/connectors/building/submission) (Listing step; Privacy policy requirements section) | `https://hlaverify.com/privacy` must exist and be reachable before submission (VP Revenue is drafting per the COO's task note) — **BLOCKER, not done yet**. |
| 11 | Public documentation required by publish date (blog post or help-center article sufficient); can share privately with Anthropic during review. | [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | We ship `edge/src/docs.js` "Add to Claude" section (§7) as the docs page content; VP Revenue is also drafting a docs page with ≥3 example prompts on the website per the COO's brief. **Not yet published** — blocker. |
| 12 | Test credentials: reviewers need a **fully populated account**, not an empty shell, plus step-by-step setup instructions. | [testing](https://claude.com/docs/connectors/building/testing), [review-criteria](https://claude.com/docs/connectors/building/review-criteria) | HLA-Verify has no "account" concept (stateless, no stored data) — closest equivalent is a reviewer API key at `pro` or `enterprise` tier so rate limits don't interfere, or the free anonymous/OAuth-free path (already "fully populated" since there's no per-account data to populate). **Jason must decide/issue** — see §8. |
| 13 | Compliance step requires 7 acknowledgments (directory guidelines, first-party API usage, financial transactions, AI media generation, prompt injection, conversation data collection, public documentation) — all required, all Jason/org-owner actions in the portal. | [submission](https://claude.com/docs/connectors/building/submission) | Not something engineering can pre-fill; flagged for Jason at submission time. |
| 14 | OAuth, if implemented: MCP authorization spec (OAuth 2.1 + RFC 9728 Protected Resource Metadata + RFC 8414 AS Metadata + RFC 7591 DCR) with mandatory PKCE S256. | [modelcontextprotocol.io authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | **Implemented**, see §6. |
| 15 | 401 on invalid/expired token must carry `WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/oauth-protected-resource"`, on a **401 only** (Claude ignores the header on a 200). | [lazy-authentication](https://claude.com/docs/connectors/building/lazy-authentication), [authentication](https://claude.com/docs/connectors/building/authentication#cross-host-authorization-servers) | **Implemented** for the "credential presented but invalid" and "PUBLIC_ACCESS=0" cases; not forced on missing credentials by default. See §6. |
| 16 | Claude's `/token` endpoint calls use `application/x-www-form-urlencoded`; DCR (`/register`) uses `application/json`. | [authentication](https://claude.com/docs/connectors/building/authentication#token-refresh) | **Implemented** — `/token` parses form-urlencoded body. |
| 17 | Claude includes PKCE `code_challenge_method=S256` on every authorization request; AS metadata must advertise `code_challenge_methods_supported: ["S256"]`. | [authentication](https://claude.com/docs/connectors/building/authentication#dcr-and-cimd-details) | **Implemented**. |
| 18 | Redirect URIs Claude uses (see §3). | [authentication](https://claude.com/docs/connectors/building/authentication#callback-urls) | **Implemented** — registered dynamically via DCR; loopback matched port-agnostically for Claude Code. |
| 19 | Claude waits ≤10s for discovery/registration/token endpoints, ≤30s for refresh. | [authentication](https://claude.com/docs/connectors/building/authentication#endpoint-latency) | Metadata/DCR/`authorize`(GET) are stateless (WebCrypto only, no KV); `authorize`(POST) and `token` are at most one KV read + one KV write — all well under budget on Workers; **UNVERIFIED in production** (no live deploy in this branch). |
| 20 | Discovery documents are cached ~5 min, keyed by URL, globally. | [lazy-authentication](https://claude.com/docs/connectors/building/lazy-authentication#oauth-discovery-caching) | Informational — no code change needed. |
| 21 | Allowed link URIs: only relevant if the server calls `ui/open-link`. | [submission](https://claude.com/docs/connectors/building/submission#allowed-link-uris) | N/A — HLA-Verify's MCP tools return JSON, no `ui/open-link` capability. |

## 3. Redirect URIs to allow

Source: [authentication#callback-urls](https://claude.com/docs/connectors/building/authentication#callback-urls).

- Hosted Claude surfaces (claude.ai web, Desktop, mobile, Cowork): **exact match**
  `https://claude.ai/api/mcp/auth_callback`
- Claude Code (native, RFC 8252 loopback, ephemeral port): `http://localhost:3118/callback`-style
  URIs, but Claude Code's registered redirect URIs are `http://localhost/callback` and
  `http://127.0.0.1/callback` (via its own Client ID Metadata Document) — **the port must be
  ignored when matching**, per RFC 8252 §7.3. We do not restrict to a fixed port for
  `localhost`/`127.0.0.1` redirect URIs.
- Because our server uses **Dynamic Client Registration** (not a fixed allowlist), any client's
  `redirect_uris` submitted at `/register` time are accepted as that client's own registered
  set, then matched **exactly** (loopback host/port-agnostic per above) at `/authorize` and
  `/token`. We do not need to hardcode Claude's URL as a special case, but we validate every
  submitted `redirect_uris` entry is `https://` or a loopback (`http://localhost/...`,
  `http://127.0.0.1/...`) URI, rejecting anything else at registration time (open-redirect
  guard).

## 4. Transport requirements

Our `/mcp` is already **stateless Streamable HTTP** (one JSON response per POST, no SSE, no
sessions) per `edge/src/mcp.js`'s own header comment. The submission portal's Connection step
offers both "streamable HTTP" and "SSE" as choices — we select streamable HTTP. No change needed.
Source: [submission](https://claude.com/docs/connectors/building/submission) (Connection step).

## 5. Tool annotation requirements — implemented

Source: [submission](https://claude.com/docs/connectors/building/submission) requirement #2,
[review-criteria](https://claude.com/docs/connectors/building/review-criteria) "Provide tool
annotations". Every tool in `edge/src/mcp.js` (`tools/list`) and `sci_envs/mcp_server.py` now
carries:

```js
title: "Human-readable name",
annotations: { title: "Human-readable name", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
```

All seven tools (`verify_text`, `normalize_allele`, `allele_info`, `match_score`, `check_typing`,
`donor_compat`, `validate_gl_string`, `about`) are read-only (no writes, no external side
effects) — `readOnlyHint: true`, `destructiveHint: false` for all. `openWorldHint: false` because
each tool only consults our own pinned reference tables, never the open web. `idempotentHint` was
left unset (not required by the checklist; all tools are naturally idempotent given identical
input, but the field isn't part of Anthropic's stated requirement so it's omitted to avoid
asserting something not asked for).

## 6. OAuth design implemented

**Revised 2026-09-14 after COO review of commit 8ee9b50** found three blockers in the first
version of this design (rate-limit bypass via free OAuth tokens, a KV write budget that would
exhaust Cloudflare's free-plan daily cap in about a dozen users, and an unhardened consent page).
All three are fixed below; the free-plan write budget is now in section 6a.

### Endpoints (edge/src/oauth.js, wired into edge/src/index.js)

- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp`
  (RFC 9728) — advertise `resource: "https://api.hlaverify.com/mcp"`,
  `authorization_servers: ["https://api.hlaverify.com"]`. Static, no storage.
- `GET /.well-known/oauth-authorization-server` (RFC 8414) — advertises `/authorize`, `/token`,
  `/register`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`
  (we do **not** advertise `client_id_metadata_document_supported`, so Claude does not attempt
  CIMD and falls back to DCR, per
  [authentication#dcr-and-cimd-details](https://claude.com/docs/connectors/building/authentication#dcr-and-cimd-details)).
  Static, no storage.
- `POST /register` (RFC 7591 DCR) — public client only (`token_endpoint_auth_method: "none"`),
  requires ≥1 `redirect_uris` entry, each `https://` or loopback; rejects anything else.
  **Writes nothing to KV** (see "Stateless by design" below) and is rate-limited by IP.
- `GET /authorize` — validates `client_id`, exact `redirect_uri` match, `code_challenge_method=S256`
  required; renders the consent page (no password, ever — see below). No storage; the pending
  request is carried forward as a signed token in the form (see below), not a server-side record.
- `POST /authorize` — consent submission, rate-limited by IP; issues a single-use, 120-second
  authorization code (the one place before token issuance that still writes to KV).
- `POST /token` — `authorization_code` (validates PKCE `code_verifier` against `code_challenge`)
  and `refresh_token` (rotates the refresh token; re-checks the underlying API key's revocation
  status if the grant was minted from a pasted API key) grants. `content-type:
  application/x-www-form-urlencoded` per spec.

### Stateless by design (Cloudflare free-plan KV write budget)

Cloudflare's free plan caps Workers KV at **1,000 writes/day** account-wide, and **deletes count
as writes** ([developers.cloudflare.com/kv/platform/limits](https://developers.cloudflare.com/kv/platform/limits/)).
The first version of this design (commit 8ee9b50) wrote a KV record for every client
registration, every consent/CSRF round-trip, every access token, and every refresh token —
roughly 7 writes per new connection plus 3 per hourly refresh, meaning a dozen active users (or
one script looping `/register`) could exhaust the daily quota. The redesign below removes every
write that doesn't strictly need one:

- **`client_id` (DCR) is the client record.** It's a signed, expiring token —
  `hcid_<base64url(JSON{redirect_uris, client_name, iat, exp})>.<HMAC-SHA256 signature>` — verified
  on every `/authorize` call against the `OAUTH_SIGNING_KEY` secret. `/register` computes and
  returns it; nothing is written to KV. TTL: 1 year (DCR clients don't need to survive forever,
  just long enough to be used).
- **The pending-authorization ("csrf") token is the same idea.** `GET /authorize` signs the
  validated request (`client_id`, `redirect_uri`, `code_challenge`, `scope`, `resource`, `state`,
  `client_name`) into a token embedded as the consent form's hidden field, TTL 10 minutes. `POST
  /authorize` verifies the signature instead of looking anything up. Because the app has no
  cookies or sessions at all, there's no ambient authority for a cross-site POST to ride on — the
  entire request is self-contained and tamper-evident, which is what a CSRF token protects
  against in a traditional (session-cookie-based) app. No KV.
- **Access tokens are fully stateless.** `hoat_<base64url(JSON payload)>.<HMAC-SHA256 signature>`,
  TTL 24h. No KV read or write validates one. An access token minted from a pasted API key
  carries that key **AES-GCM-encrypted** (key derived from `OAUTH_SIGNING_KEY`, distinct from the
  HMAC key) — never plaintext — and `authorize()` in `index.js` decrypts it and re-validates
  against `HLA_VERIFY_API_KEYS`/`env.KEYS` **on every request** (a read, exactly like a legacy API
  key already gets). That means revoking the underlying key takes effect on the very next
  request, not after some TTL.
- **Refresh tokens keep one KV write category: rotation.** A refresh token embeds a `sessionId`;
  `OAUTH_KV["session:<sessionId>"]` holds the SHA-256 hash of the currently-valid refresh token
  (TTL 30d). Refreshing reads that record (1 read), compares hashes, and — if they match — mints a
  new access+refresh pair and overwrites the record with the new hash (1 write). A **mismatch
  means the presented token was already rotated away** (theft signal): the whole session is
  revoked immediately rather than silently ignored. This is the one place true statelessness gives
  up a real security property (reuse detection), so it's the one place we still pay a KV write.
- **Authorization codes are still KV-backed**, TTL 120s: 1 write on issuance, 1 write (delete) on
  single-use redemption. This is short-lived, low-volume (one per connection attempt), and the
  simplest way to guarantee true single-use.

### 6a. Write-budget table

| Event | KV writes (incl. deletes) | Frequency |
|---|---|---|
| `POST /register` (DCR) | **0** | once per new client (Claude re-registers per docs) |
| `GET /authorize` (render consent) | 0 | once per new connection |
| `POST /authorize` (consent → auth code) | 1 (`authcode:` put) | once per new connection |
| `POST /token`, `authorization_code` grant | 2 (`authcode:` delete + `session:` put) | once per new connection |
| `POST /token`, `refresh_token` grant (success) | 1 (`session:` put, overwrite) | ~once per active user per day (access token TTL 24h; Claude refreshes reactively on 401 + proactively up to 5 min before expiry) |
| `POST /token`, `refresh_token` grant (reuse detected) | 1 (`session:` delete) | only under attack/bug, not steady-state |
| Every `/mcp` or `/v1/*` request bearing an OAuth token | **0** | every request (fully stateless verification) |

**New connection, one-time cost: 3 KV writes** (1 for the auth code issuance, 1 for its
redemption/delete, 1 for the initial session pointer). **Steady state: 1 KV write per active user
per calendar day** (one refresh-rotation, since the access token lasts 24h).

**Free-plan ceiling** (1,000 writes/day, account-wide, shared with the existing `KEYS` namespace's
Stripe/Lemon-Squeezy writes, which are comparatively rare): roughly **1,000 steady-state active
OAuth users per day** before the refresh-rotation writes alone exhaust the quota, or a mix — e.g.
300 brand-new connections/day (900 writes) leaves 100 writes/day of headroom for refreshes. This
is a large improvement over the previous ~12-user ceiling, but it is still a **hard cap shared
across the whole account** (any other feature that writes to any KV namespace on this account
counts against the same 1,000/day).

**Workers Paid plan ($5/month)** removes the daily cap: **1 million writes/month included, then
$5.00 per additional million** ([developers.cloudflare.com/kv/platform/pricing](https://developers.cloudflare.com/kv/platform/pricing/)),
i.e. roughly 32,000 writes/day before any overage charge, and no hard ceiling after that (billed,
not blocked). At this design's ~1 write/user/day steady-state cost, that's on the order of 30,000+
daily active OAuth users before Jason would see any KV bill line item. **This is a business
decision for Jason**, not something to flip silently: stay on the free plan (accept the ~1,000
active-user ceiling shared with the rest of the account) or upgrade to Workers Paid ($5/mo flat,
plus the rare overage) before OAuth usage is expected to approach that ceiling.

### Consent page (no accounts, no passwords)

Two choices, exactly per the COO's spec:

- **"Continue with free access"** — the issued OAuth token maps to `{label: "anonymous-oauth",
  tier: "free"}`. **Rate-limited by IP (`env.RL`), the exact same bucket anonymous callers use** —
  not per-token. (The first version of this design rate-limited free OAuth tokens per-token or not
  at all, which let a script mint unlimited tokens via `/register` → `/authorize` → `/token` and
  bypass the anonymous rate limit entirely; fixed per COO review.)
- **"Use my HLA-Verify API key"** — the pasted key is validated with the *exact same* code path
  `authorize()` in `index.js` already uses (via the shared `lookupApiKey()` helper in
  `edge/src/keys.js`: `HLA_VERIFY_API_KEYS` secret map, then `env.KEYS` KV record, revoked check
  included); the issued token inherits that key's `label`/`tier` and is **rate-limited by the
  underlying key's identity** (`limiterFor(tier)`, keyed by the raw API key) — so a key and every
  OAuth token minted from it share one bucket, instead of each token getting its own tier
  allowance. The key itself is never echoed back to the browser and never logged; it is
  AES-GCM-encrypted into the token (never plaintext) solely so the revocation re-check above is
  possible.

Hardening added per COO review:

- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` on every
  `/authorize` response (GET and POST), so the consent page can't be framed/clickjacked.
- The redirect destination host is shown prominently: "After you authorize you'll return to
  `<host>`."
- If that host is not `claude.ai`, `claude.com`, or a loopback address, a warning appears above
  the API-key field: "Only paste your API key if you trust `<host>`."
- `/register` and `POST /authorize` are rate-limited by IP (`env.RL`, distinct key prefixes so
  they don't share a bucket with anonymous `/mcp` traffic under the same IP).
- The terms link (previously `https://hlaverify.com/terms`, which does not exist) now links the
  privacy policy and `https://hlaverify.com/research` (research-use conditions) instead; VP
  Revenue may add a dedicated terms page later.

Both paths show: "Research-and-evaluation tool. Not a medical device. Not for clinical use."

### Token format / how `/mcp` tells an OAuth token from an API key

- Existing API keys (from `HLA_VERIFY_API_KEYS` or Stripe/Lemon-Squeezy-issued KV keys) are
  opaque strings; self-serve ones are generated as `hlv_<random>` (`edge/src/stripe.js`
  `generateApiKey()`).
- OAuth access tokens are generated as **`hoat_<random>`**; OAuth refresh tokens as
  **`hort_<random>`**. Neither prefix can collide with `hlv_`-prefixed keys (different literal
  prefix, not merely improbable).
- In `authorize()` (`edge/src/index.js`), a presented credential starting with `hoat_` is verified
  statelessly (`verifyAccessToken()` in `oauth.js`: HMAC signature + expiry, no KV); anything else
  follows the existing `HLA_VERIFY_API_KEYS` → `env.KEYS` lookup chain, byte-for-byte unchanged.

### Secrets

- `OAUTH_SIGNING_KEY` (new, Jason sets via `wrangler secret put`) — a long random string (e.g.
  `openssl rand -base64 48`). Derives both the HMAC-SHA256 signing key and the AES-GCM encryption
  key (distinct derivations, see `hmacKeyFrom`/`aesKeyFrom` in `oauth.js`), so it is never used
  directly as either key. Rotating it invalidates every outstanding client_id, access token, and
  pending consent at once (all fail signature verification) — a deliberate, low-cost way to revoke
  everything OAuth-related if ever needed. Never logged, never echoed.

### Backward compatibility / the 401-vs-anonymous decision

Per §1, authless is fully acceptable for directory listing, so we did **not** pick the "challenge
only when the client signals OAuth support" or "separate `/mcp/oauth` path" fallback the task
anticipated — we didn't need to, because no fallback was necessary:

- `/mcp` and `/v1/*` continue to accept **no credential** exactly as before (free tier, per-IP
  rate limit) when `PUBLIC_ACCESS` is `"1"` (today's production setting, unchanged) — zero
  behavior change for existing anonymous callers, agents, and non-Claude MCP clients.
- `x-api-key` and `Authorization: Bearer <api key>` continue to work unchanged for existing
  customers.
- A **401 with `WWW-Authenticate: Bearer resource_metadata="https://api.hlaverify.com/.well-known/oauth-protected-resource/mcp"`**
  is returned in two cases, both spec-correct and neither breaking today's anonymous default:
  1. A credential *was* presented (`x-api-key` or `Authorization: Bearer ...`) but is invalid,
     unrecognized, expired, or revoked — previously a bare 401, now the same 401 plus the
     `WWW-Authenticate` header, satisfying [RFC 9728 §5.1](https://datatracker.ietf.org/doc/html/rfc9728#name-www-authenticate-response)
     and the MCP spec's "invalid or expired tokens MUST receive a 401" without changing status
     codes or bodies existing integrations already handle.
  2. `PUBLIC_ACCESS` is explicitly set to `"0"` (an existing, currently-unused opt-in flag in
     `wrangler.jsonc` for a fully-gated deployment) — missing credentials also 401 with the same
     header. This is not enabled today; it exists for Jason if a future paid-only MCP deployment
     is wanted.
- No tool is individually gated (`PROTECTED_TOOLS` is empty) — the "lazy auth" pattern Anthropic
  documents is available but unused, because nothing here needs per-tool step-up.

### Security checklist

- PKCE **required**: `/authorize` rejects any `code_challenge_method` other than `S256`; `/token`
  rejects a `code_verifier` that doesn't hash (SHA-256, base64url) to the stored `code_challenge`.
- `redirect_uri` exact match against the client's DCR-registered set (verified via the signed
  `client_id`), both at `/authorize` (before showing consent) and at `/token` (before issuing
  tokens) — no open redirects; unregistered or non-exact URIs are rejected without redirecting the
  browser anywhere.
- `state` is opaque to us and passed through unmodified in the final redirect.
- CSRF on the consent `POST`: see "Stateless by design" above — the pending-authorization token is
  HMAC-signed and expiring (10 minutes), so a forged or replayed-after-expiry submission fails
  signature/expiry verification; there is no session cookie for a cross-site request to exploit.
- Authorization codes are short-lived (120s) and single-use (deleted from KV immediately on
  redemption; a replay gets `invalid_grant`).
- Refresh tokens rotate on every use; presenting an already-rotated (reused) refresh token revokes
  the entire session rather than being silently ignored.
- API-key-backed access tokens are re-validated against the live key record on every request, so
  revocation is immediate, not bounded by a token TTL.
- `/register` and `POST /authorize` are rate-limited by IP; free-mode and apikey-mode OAuth access
  tokens are rate-limited exactly like their non-OAuth equivalents (anonymous-by-IP,
  key-by-identity respectively) so OAuth cannot be used to bypass existing rate limits.
- CORS on `/v1/*` and `/mcp` is unchanged; the new OAuth endpoints are same-origin
  browser/server-to-server calls and don't need the wildcard CORS the data API uses (Claude
  fetches them server-side, not from a browser origin that needs preflight).

## 7. "Add to Claude" docs section

Added to `edge/src/docs.js` (served at `GET /docs`): a short "Add to Claude" section with the
`/mcp` URL, a note that both anonymous and OAuth (via the consent page's two options) work, and
the OAuth endpoint list for anyone who wants to verify metadata by hand
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`).

## 8. Test-account requirements — UNVERIFIED / needs Jason

The portal's "Test & launch" step wants "credentials for a fully populated account where
relevant" ([submission](https://claude.com/docs/connectors/building/submission)) and
[review-criteria](https://claude.com/docs/connectors/building/review-criteria) repeats "Test
credentials are required and must be a fully populated account." HLA-Verify has no
account/data-ownership model to "populate" — every call is a stateless lookup against the same
pinned public reference release for every caller. The closest equivalent:

- Either point reviewers at the **free/anonymous path** (no credential needed, already "fully
  populated" since there's no user-specific data), or
- Issue a **named enterprise-tier reviewer API key** (`label: "anthropic-reviewer"`) so rate
  limits don't interfere with testing all 7 tools.

**I did not mint a key or KV namespace — that requires `wrangler kv namespace create OAUTH_KV`
and a secret update, which I was told not to run.** This is a `blocked-on-jason` item (see
`data/portfolio.json`).

## 9. Known limitations / things not implemented

- `client_id` tokens are valid for 1 year and cannot be individually revoked (there is no
  per-client KV record to delete) — only rotating `OAUTH_SIGNING_KEY` invalidates them, and that
  invalidates every other outstanding OAuth token/consent at the same time. Acceptable given
  Claude re-registers a DCR client per fresh connection, but flagging so it isn't a surprise later.
- Free-mode access/refresh tokens have nothing to revoke against (no underlying key), so they
  simply expire naturally (access 24h, refresh 30d) — there is no way to kill a specific free-mode
  session early short of rotating `OAUTH_SIGNING_KEY` (which kills all of them).
- Refresh-token reuse detection revokes the **entire session** (both the reused old token and the
  legitimate current one), which is the standard, recommended OAuth 2.1 response to a suspected
  leak, but means a false-positive (e.g. a client retrying a refresh call after a dropped response
  without realizing the first one succeeded) also forces the user to re-authorize.
- Endpoint latency (<10s discovery/registration/token, <30s refresh) is architecturally satisfied
  (stateless verification for most paths; at most one KV read + one KV write for the slowest
  path, refresh) but **UNVERIFIED against a live deployment** — this branch was never deployed per
  the task's constraints.
- `PUBLIC_ACCESS=0` strict mode is implemented but not enabled; enabling it is an infra/business
  decision, not an engineering one — left to Jason.
- The free-plan KV write ceiling (section 6a) is a real, shared-account-wide cap; Jason should
  decide free vs. Workers Paid ($5/mo) before OAuth usage is promoted or expected to grow quickly,
  not after hitting it.
