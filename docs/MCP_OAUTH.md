# OAuth sign-in for the remote MCP endpoint

Status: **shipped OFF.** Code in `edge/src/oauth.js`, tests in `edge/test/oauth.test.mjs`.
Nothing changes in production until the operator sets a secret *and* a variable (see
[Turning it on](#turning-it-on)).

## Why

Today an agent reaches `https://api.hlaverify.com/mcp` anonymously (60 req/min per IP) or
with a pasted API key (`X-API-Key` / `Authorization: Bearer <key>`). MCP clients such as
Claude, Claude Code, the Cloudflare Agents SDK and the official TypeScript SDK can instead
run the standard MCP OAuth flow: the user clicks "connect", a browser page opens, they
approve, and the client receives tokens. This lets agent traffic sign in to a paid key
without anyone copying the key into a config file.

## Scope

Implements the MCP 2026-07-28 authorization spec
(`docs/specification/2026-07-28/basic/authorization/` in modelcontextprotocol/modelcontextprotocol):

| Requirement | How |
|---|---|
| RFC 9728 protected resource metadata | `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| 401 `WWW-Authenticate` with `resource_metadata` | Every 401 from `/mcp` (flag on only) |
| RFC 8414 authorization server metadata | `GET /.well-known/oauth-authorization-server` (issuer = `https://<host>`) |
| OAuth 2.1 authorization code + PKCE | `S256` only; `code_challenge` mandatory; `plain` refused |
| Client ID Metadata Documents (preferred) | `client_id` = https URL; fetched and validated on `/oauth/authorize` |
| Dynamic Client Registration (deprecated, kept for older clients) | `POST /oauth/register`, stateless |
| RFC 8707 resource indicators, audience validation | Only resource is `https://<host>/mcp`; tokens carry and are checked against it |
| RFC 9207 `iss` in the authorization response | Always present; advertised via `authorization_response_iss_parameter_supported` |
| Refresh token rotation for public clients | Every refresh issues a new refresh token; reuse revokes the family |
| Short-lived access tokens | 1 hour |

Not implemented: OpenID Connect, confidential clients (`private_key_jwt`, client secrets),
token revocation/introspection endpoints, scopes beyond a single `mcp` scope, and OAuth on
`/v1/*` (REST keeps using API keys; OAuth tokens are rejected there).

## Design

**The Worker is its own authorization server, and an API key is the identity.** There are
no user accounts to log in to. The consent page asks the human for their existing HLA-Verify
API key (issued by Stripe checkout into KV, or listed in the `HLA_VERIFY_API_KEYS` secret).
The key is checked with the same logic `authorize()` uses (unknown, malformed and revoked
all give one answer) and then bound into the grant.

**Stateless sealed tokens, not stored tokens.** Authorization codes, access tokens, refresh
tokens, DCR client ids and the consent-form request are all AES-256-GCM ciphertexts under a
key derived (HKDF-SHA-256) from `OAUTH_TOKEN_SECRET`, with the token type as associated data
so one kind can never be replayed as another. Each carries the API key, audience, expiry and
(where relevant) hashes of the client id and redirect URI.

Why this over KV-stored tokens:

- **Revocation still works without storing tokens.** `/mcp` decrypts the access token and
  runs the embedded key through the existing `authorizeKey()` path — the exact code an
  `X-API-Key` request runs — so the token gets the key's *current* tier and rate-limit
  bucket, and a revoked key (cancelled subscription, refund) stops the token on the next
  request. Refresh and code exchange re-check the key too.
- **The client never sees the key.** Tokens are encrypted, not merely signed.
- **Almost no KV writes.** KV writes are scarce on the Workers Free plan (1,000/day) and are
  what Stripe key issuance needs. Stateless tokens need a write only for single-use markers
  (one per code exchange, one per refresh) and family revocation.
- **Nothing to enumerate or garbage-collect.** Markers use TTLs; nothing else is stored.
- **Kill switch.** Rotating `OAUTH_TOKEN_SECRET` invalidates every outstanding code and token
  at once, without touching API keys.

KV entries written (namespace `KEYS`, all with `expirationTtl`, values deliberately not JSON so
`authorize()` can never read one as a key record):

| Key | Value | TTL |
|---|---|---|
| `oauth/used/code/<random id>` | `used` | code lifetime + 60 s |
| `oauth/used/rt/<random id>` | `used` | refresh token lifetime + 60 s |
| `oauth/revoked-family/<random id>` | `revoked` | 30 days |

Lifetimes: consent page 10 min, authorization code 2 min, access token 1 h, refresh token
30 days (sliding; every refresh re-checks the API key).

### Flow

1. Client POSTs `/mcp` without a valid credential and gets a 401 with
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp", scope="mcp"`.
   (While `PUBLIC_ACCESS` is not `"0"`, a client with *no* credential still gets anonymous
   access, as today; clients start OAuth on a 401 or when the user asks them to connect.)
2. Client reads the resource and authorization server metadata.
3. Client registers: either uses a CIMD URL as `client_id`, or `POST /oauth/register`
   returns a sealed `client_id` (`hlvci_…`) encoding its redirect URIs.
4. Browser opens `/oauth/authorize?...&code_challenge=...&resource=...`. The server
   validates client and exact redirect URI first; any problem shows an error page (never a
   redirect). It then renders the consent page, with the application name, whether that
   name is verified, the **redirect hostname**, a localhost warning when applicable, and a
   password field for the API key. The validated request is sealed into a hidden field and
   a random CSRF value is set in a `__Host-` cookie and inside the sealed request.
5. Human approves with a valid key → `303` to `redirect_uri?code=hlvac_…&state=…&iss=…`.
   Deny → `error=access_denied` with `iss`.
6. Client POSTs `/oauth/token` with `code`, `code_verifier`, `redirect_uri`, `client_id`,
   `resource` → `{access_token: hlvat_…, refresh_token: hlvrt_…, expires_in: 3600, scope: "mcp"}`.
7. Client calls `/mcp` with `Authorization: Bearer hlvat_…`; responses carry
   `x-hla-verify-tier` of the key, usage is metered under the key's label.

## Threat model

| Threat | Mitigation |
|---|---|
| **Code interception / injection** | PKCE S256 mandatory; code bound to client id hash, redirect URI hash and resource; 2-minute lifetime; single use (KV marker); reuse also revokes refresh tokens from that code. PKCE is checked before the code is marked used, so a party without the verifier cannot burn a victim's code. |
| **Open redirect** | Redirect URIs must be `https` or `http` on `localhost`/`127.0.0.1`/`[::1]`; no fragments or credentials; max 5 × 512 chars per DCR client. Exact string match against the registration (port may vary only for loopback IP literals, per OAuth 2.1). Duplicate parameters are refused. Because every client is self-registered, **no request error auto-redirects** (RFC 9700 §4.11.2): only a human Approve/Deny on a page showing the redirect host produces a redirect. |
| **CSRF on the consent form** | Double-submit `__Host-hlv_oauth` cookie (`Secure; HttpOnly; SameSite=Lax`) whose value is also inside the sealed request; cross-origin `Origin` (including `null`) and cross-site `Sec-Fetch-Site` are refused; the sealed request expires in 10 minutes and cannot be edited. |
| **Clickjacking** | `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`. |
| **XSS / HTML injection** | Client names, hosts and every reflected value are HTML-escaped; CSP `default-src 'none'` (inline styles only, no scripts). |
| **Key enumeration via the consent form** | One message for unknown, malformed and revoked keys; consent GET and POST share a per-IP rate limit (`RL` binding, key `oauth:<ip>`, 60/min). Stripe keys carry 256 bits of randomness. Note the existing `/v1` 401 path already answers key guesses without a limit, so this adds no new oracle; weak hand-written keys in `HLA_VERIFY_API_KEYS` are the residual exposure either way. |
| **Token leakage** | Access tokens live 1 h and work only on `/mcp` of the host that minted them; tokens never appear in URLs we serve (only the one-time code does, in the client's callback); token responses are `no-store`; the code redirect sets `Referrer-Policy: no-referrer`; tokens do not reveal the API key. A leaked refresh token is bound to its client id, and replaying a rotated one revokes the family. Revoking the key or rotating `OAUTH_TOKEN_SECRET` cuts everything off. |
| **Wrong audience / token passthrough** | `aud` must equal `https://<request host>/mcp`; a token minted on `*.workers.dev` fails on `api.hlaverify.com` and vice versa; `/v1/*` never accepts OAuth tokens; the Worker makes no upstream calls with tokens. |
| **Tampering / type confusion** | AES-GCM authentication; token type is AEAD associated data; tests flip bytes, truncate, relabel a refresh token as an access token and rotate the secret. |
| **Mix-up attacks** | `iss` in every authorization response (success and deny); issuer is exactly the metadata `issuer`. |
| **SSRF via Client ID Metadata Documents** | Fetch only `https` URLs on the default port with a path, on a DNS name (no IP literals, no `localhost`/`*.localhost`, no single-label hosts, not this host); no redirects followed; 5 s timeout; 16 KB cap; per-IP rate limit. Workers cannot reach private networks. |
| **Client impersonation** | DCR names are labelled unverified on the consent page; CIMD shows the verified client-id host; the redirect hostname is always shown; localhost redirect URIs get a warning. |
| **Rate-limit evasion** | An OAuth token consumes the same `RL_STARTER`/`RL_LAB`/`RL_SCALE` bucket as its key (keyed by the key itself), so many tokens for one key share one limit, and the same `QUOTA` daily counter (keyed by a digest of the key), so many tokens for one key share one daily quota. |
| **KV outage / write quota exhausted** | OAuth endpoints fail closed (`503 temporarily_unavailable`, no token issued); `/mcp` and `/v1` are unaffected. |
| **Accidental enablement** | Requires `OAUTH_ENABLED` exactly `"1"`, `OAUTH_TOKEN_SECRET` of at least 32 chars, and the `KEYS` binding. Any other combination is byte-identical to today. |

### Residual risks (accepted, documented)

- **KV is eventually consistent.** Two redemptions of the same code (or refresh token)
  racing through different Cloudflare locations within about 60 s can both succeed. PKCE
  and client binding still hold, so an attacker needs the verifier/refresh token anyway.
- **Access tokens are not checked against family revocation** (that would add a KV read to
  every `/mcp` call); a detected replay limits damage to the remaining ≤1 h of already
  issued access tokens. Key revocation is checked on every call.
- **KV write budget.** One write per code exchange and per refresh (roughly one per active
  client-hour). On the Workers Free plan that is shared with Stripe key issuance's
  1,000/day; move to Workers Paid before enabling for real traffic.
- **Anonymous access remains** while `PUBLIC_ACCESS` is not `"0"`, so clients will not be
  pushed into OAuth by a 401 unless they already hold a bad credential. Requiring sign-in on
  `/mcp` only would be a separate, deliberate change.
- **Consent cookie is per browser**, so two sign-ins started in parallel tabs invalidate the
  first; the page says to start again.

## Inertness (flag off)

`index.js` only calls `oauthConfig(env)`, which returns `null` unless all three conditions hold;
then the `/.well-known/oauth-*` and `/oauth/*` paths fall through to the existing
`404 {"detail":"Not Found"}` and `/mcp` calls the unchanged `authorize()`. The only other
change to existing code is extracting the presented-key branch of `authorize()` into
`authorizeKey()` verbatim.

Proven by `edge/test/oauth.test.mjs`:

- every new route, GET and POST, returns a response identical (status, all headers, body)
  to `GET/POST /no-such-route` for six not-fully-enabled configurations (unset, `"0"`,
  `"true"`, no secret, short secret, no KV binding);
- a matrix of 21 requests (anonymous, `X-API-Key`, Bearer KV key, Bearer secret-list key,
  invalid, `hlvat_`-shaped, revoked, GET/PUT/OPTIONS, `/v1`, `/healthz`, `/openapi.json`)
  is identical between each of those configurations and a deployment with no OAuth variables;
- `PUBLIC_ACCESS=0` 401s and anonymous/keyed 429s are identical and carry no `WWW-Authenticate`;
- a genuine access token presented with the flag off is just an unknown key (401, same body);
- with the flag **on**, everything except `/mcp` 401s and the new routes is still identical.

In addition, a one-off differential run compared `origin/main`'s `index.js` with this
branch's (flag unset) over 512 request/environment pairs: 0 differences.

## Turning it on

Do these in order. Nothing here has been done.

1. Prefer Workers Paid (KV write budget, see residual risks).
2. Create the secret (never commit it):
   `cd edge && openssl rand -hex 32 | npx wrangler secret put OAUTH_TOKEN_SECRET`
3. Confirm the `KEYS` KV binding in `edge/wrangler.jsonc` is the production namespace (it is
   already bound; no new namespace is needed).
4. Enable: add `"OAUTH_ENABLED": "1"` to `"vars"` in `edge/wrangler.jsonc` in a PR (the push to
   `main` deploys), or set it in the Cloudflare dashboard as a plain-text variable.
5. Verify:
   - `curl https://api.hlaverify.com/.well-known/oauth-authorization-server` → metadata with
     `"issuer":"https://api.hlaverify.com"`;
   - `curl -i -X POST https://api.hlaverify.com/mcp -H 'authorization: Bearer nope' -H 'content-type: application/json' -d '{}'`
     → 401 with `WWW-Authenticate: Bearer resource_metadata=...`;
   - connect a real client (e.g. Claude Code: `claude mcp add --transport http hla-verify https://api.hlaverify.com/mcp`,
     then `/mcp` → authenticate) and approve with a starter key; the response header
     `x-hla-verify-tier` should read `starter`.
6. Consider adding "Connect with OAuth" to `/docs` and the checkout success page once verified.

To turn it off: remove `OAUTH_ENABLED` (routes 404 again, tokens stop working). To invalidate
every outstanding token while leaving it on: `npx wrangler secret put OAUTH_TOKEN_SECRET` with a
new value.

## Local testing

```sh
python -m sci_envs.service.edge_export
cd edge && node --test test/oauth.test.mjs
printf 'OAUTH_TOKEN_SECRET="%s"\n' "$(openssl rand -hex 32)" > .dev.vars   # gitignored
npx wrangler kv key put --local --binding KEYS hlv_local_pro '{"tier":"pro","status":"active"}'
npx wrangler dev --local --port 8796 --var OAUTH_ENABLED:1 --local-upstream 127.0.0.1:8796
```

`--local-upstream` matters: without it `wrangler dev` rewrites some request URLs to the route
host (`api.hlaverify.com`) and the issuer/audience then disagree between requests.
