// OAuth 2.1 for /mcp — hand-rolled per docs/CLAUDE-CONNECTOR.md section 6 (design
// rationale, including the free-plan KV write budget in section 6a, lives there).
//
// Implements: RFC 9728 (Protected Resource Metadata), RFC 8414 (Authorization Server
// Metadata), RFC 7591 (Dynamic Client Registration), OAuth 2.1 authorization_code grant
// with mandatory PKCE (S256), and refresh_token grant with rotation.
//
// STATELESS BY DESIGN (Cloudflare's free plan caps Workers KV at 1,000 writes/day, and
// deletes count as writes — see docs/CLAUDE-CONNECTOR.md section 6a for the full budget):
//   - client_id (DCR) is a self-describing, HMAC-signed token carrying its own
//     redirect_uris/client_name. /register writes NOTHING to KV.
//   - the pending-authorization ("csrf") token handed to the consent form is likewise a
//     signed, expiring token carrying the original /authorize request. No KV.
//   - access tokens are signed, expiring, self-contained bearer tokens. No KV read OR
//     write is needed to validate one. An access token minted from a pasted API key
//     carries that key AES-GCM-encrypted (never plaintext) and is re-validated against
//     HLA_VERIFY_API_KEYS/env.KEYS on every request (a read, exactly like a legacy API
//     key already is) — so revoking the underlying key takes effect immediately, without
//     waiting for the access token to expire.
//   - the ONLY things still written to OAUTH_KV are: (1) the authorization code, once on
//     issuance and once on single-use redemption (TTL 120s), and (2) a per-session
//     refresh-token-rotation pointer, written once at initial token issuance and once per
//     rotation thereafter (TTL 30d) — needed to detect refresh-token reuse, which a fully
//     stateless design cannot do.
//
// No user accounts, no passwords, ever. The consent page (/authorize) offers exactly two
// choices: anonymous free-tier access, or "use my HLA-Verify API key" (validated with the
// same lookupApiKey() the REST/MCP API already uses).
//
// Requires a secret, OAUTH_SIGNING_KEY (Jason sets via `wrangler secret put`), used to
// derive both the HMAC signing key and the AES-GCM encryption key (distinct derivations,
// see hmacKeyFrom/aesKeyFrom below) via WebCrypto. Never logged, never echoed.
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { lookupApiKey } from "./keys.js";

export const ACCESS_PREFIX = "hoat_"; // OAuth access token — never collides with hlv_-prefixed API keys
export const REFRESH_PREFIX = "hort_"; // OAuth refresh token
const CLIENT_PREFIX = "hcid_";
const CSRF_PREFIX = "hcsrf_";
const CODE_PREFIX = "hac_";

const ACCESS_TTL_S = 60 * 60 * 24; // 24h — long enough that an active user refreshes about once/day
const REFRESH_TTL_S = 60 * 60 * 24 * 30; // 30d
const AUTH_CODE_TTL_S = 120; // single-use, short-lived
const CSRF_TTL_S = 600; // 10 minutes to complete consent
const CLIENT_TTL_S = 60 * 60 * 24 * 365; // 1 year — DCR clients don't need to survive forever, just this long

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------- base64url + crypto primitives

function b64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function randomToken(prefix, nBytes = 24) {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
async function sha256Bytes(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}
async function sha256Hex(s) {
  return Array.from(await sha256Bytes(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Two independent key derivations from one secret (distinct context strings), so the
// HMAC signing key and the AES-GCM encryption key are never the same bytes.
async function hmacKeyFrom(secret) {
  const material = await sha256Bytes(secret + "|hla-verify-oauth-hmac-v1");
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function aesKeyFrom(secret) {
  const material = await sha256Bytes(secret + "|hla-verify-oauth-aes-v1");
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(secret, apiKey) {
  const key = await aesKeyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(apiKey)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
async function decryptApiKey(secret, enc) {
  const [ivB64, ctB64] = String(enc || "").split(".");
  if (!ivB64 || !ctB64) return null;
  try {
    const key = await aesKeyFrom(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(ivB64) }, key, b64urlDecode(ctB64));
    return decoder.decode(pt);
  } catch (_) {
    return null; // tampered ciphertext / wrong key
  }
}

// Generic signed, expiring, stateless token: prefix + base64url(JSON payload) + "." + HMAC.
// Used for client_id (DCR), the pending-authorization ("csrf") token, and access tokens.
async function mintToken(secret, prefix, payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSeconds };
  const bodyB64 = b64url(encoder.encode(JSON.stringify(full)));
  const key = await hmacKeyFrom(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(bodyB64)));
  return `${prefix}${bodyB64}.${b64url(mac)}`;
}
async function readToken(secret, prefix, token) {
  if (typeof token !== "string" || !token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot < 0) return null;
  const bodyB64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const key = await hmacKeyFrom(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(bodyB64)));
  if (!timingSafeEqual(b64url(mac), sig)) return null; // tampered payload or signature
  let payload;
  try {
    payload = JSON.parse(decoder.decode(b64urlDecode(bodyB64)));
  } catch (_) {
    return null;
  }
  if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) > payload.exp) return null; // expired
  return payload;
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
}
// Every /authorize response (success or error) is a page a browser renders, so it always
// gets the anti-clickjacking headers regardless of outcome.
function authHtml(body, status = 200) {
  return html(body, status, { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
}
function j(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Redirect URIs must be https:// or a loopback URI (http://localhost/... or
// http://127.0.0.1/..., port ignored per RFC 8252 §7.3) — never anything else, so a
// registered client can never be used to build an open redirect.
function isAllowedRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch (_) { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1")) return true;
  return false;
}
function redirectUriMatches(registered, presented) {
  if (registered === presented) return true;
  let a, b;
  try { a = new URL(registered); b = new URL(presented); } catch (_) { return false; }
  const loopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  if (a.protocol !== b.protocol || a.protocol !== "http:") return false;
  if (!loopbackHost(a.hostname) || a.hostname !== b.hostname) return false;
  return a.pathname === b.pathname && a.search === b.search;
}

function wwwAuthenticate(origin, extra = "") {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${extra ? ", " + extra : ""}`;
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}
// Rate-limits /register and POST /authorize by IP (env.RL — the same simple limiter /mcp
// uses for anonymous callers) so scripting either endpoint can't be used to hammer the
// server or brute-force API keys through the consent form. Fails open (matches the rest
// of the codebase's rate-limiter posture) if RL is unbound or errors.
async function withinIpLimit(env, request, bucket) {
  if (!env.RL) return true;
  try {
    const { success } = await env.RL.limit({ key: `${bucket}:${clientIp(request)}` });
    return success;
  } catch (_) {
    return true;
  }
}

const TRUSTED_HOSTS = new Set(["claude.ai", "claude.com"]);
function isTrustedHost(host) {
  return TRUSTED_HOSTS.has(host) || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

// ---------------------------------------------------------------- metadata (RFC 9728 / 8414)

export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // "none": we are a public-client authorization server (PKCE only, no client secret).
    // Deliberately NOT advertising client_id_metadata_document_supported — Claude only
    // attempts CIMD when BOTH that flag and this one are present; omitting it means
    // Claude falls back to DCR (registration_endpoint above), which is what we implement.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

// ---------------------------------------------------------------- DCR (RFC 7591) — zero KV writes

export async function handleRegister(request, env) {
  if (!env.OAUTH_SIGNING_KEY) return j({ error: "server_error", error_description: "OAuth signing key not configured" }, 500);
  if (!(await withinIpLimit(env, request, "reg"))) return j({ error: "rate_limited" }, 429);

  let body;
  try { body = await request.json(); } catch (_) { return j({ error: "invalid_client_metadata", error_description: "malformed JSON" }, 400); }
  const redirectUris = Array.isArray(body && body.redirect_uris) ? body.redirect_uris : null;
  if (!redirectUris || redirectUris.length === 0)
    return j({ error: "invalid_client_metadata", error_description: "redirect_uris is required and must be a non-empty array" }, 400);
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri))
      return j({ error: "invalid_redirect_uri", error_description: `redirect_uri must be https:// or a loopback URI: ${uri}` }, 400);
  }
  const clientName = typeof (body && body.client_name) === "string" ? body.client_name.slice(0, 200) : "MCP client";

  // The client_id itself IS the client record: a signed, expiring token carrying
  // redirect_uris/client_name. Nothing is written to KV.
  const clientId = await mintToken(env.OAUTH_SIGNING_KEY, CLIENT_PREFIX, { redirect_uris: redirectUris, client_name: clientName }, CLIENT_TTL_S);
  return j({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
}

async function readClient(env, clientId) {
  const payload = await readToken(env.OAUTH_SIGNING_KEY, CLIENT_PREFIX, clientId);
  if (!payload || !Array.isArray(payload.redirect_uris)) return null;
  return { redirect_uris: payload.redirect_uris, client_name: payload.client_name || "MCP client" };
}

// ---------------------------------------------------------------- /authorize (GET: consent page)

function consentPage({ pending, error, clientName, redirectHost, trusted }) {
  const errBlock = error ? `<p style="color:#b00020"><strong>Error:</strong> ${escapeHtml(error)}</p>` : "";
  const trustWarning = trusted
    ? ""
    : `<p style="color:#8a5a00;background:#fff8e1;padding:8px 12px;border-radius:6px"><strong>Only paste your API key if you trust ${escapeHtml(redirectHost)}.</strong> That's where you'll be sent after authorizing.</p>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connect to HLA-Verify</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>Connect to HLA-Verify</h1>
<p><strong>${escapeHtml(clientName || "An MCP client")}</strong> wants to access the HLA-Verify API on your behalf.</p>
<p style="color:#555">After you authorize you'll return to <strong>${escapeHtml(redirectHost)}</strong>.</p>
${errBlock}
<form method="POST" action="/authorize">
<input type="hidden" name="csrf" value="${escapeHtml(pending)}">
<fieldset style="border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:16px">
<legend>Choose access</legend>
<p><label><input type="radio" name="choice" value="free" checked> Continue with free access (rate-limited, no API key needed)</label></p>
<p><label><input type="radio" name="choice" value="apikey"> Use my HLA-Verify API key</label></p>
${trustWarning}
<p style="margin-left:24px"><input type="password" name="api_key" placeholder="hlv_..." autocomplete="off" style="width:100%;box-sizing:border-box"></p>
</fieldset>
<p style="font-size:0.9em;color:#555">HLA-Verify is a research-and-evaluation tool. <strong>Not a medical device. Not for clinical use.</strong>
See the <a href="https://hlaverify.com/privacy" target="_blank" rel="noopener">privacy policy</a> and
<a href="https://hlaverify.com/research" target="_blank" rel="noopener">research-use conditions</a>.</p>
<button type="submit" style="padding:10px 20px;font-size:1em">Authorize</button>
</form>
</body></html>`;
}

export async function handleAuthorizeGet(request, env) {
  if (!env.OAUTH_SIGNING_KEY) return authHtml("<p>OAuth signing key not configured.</p>", 500);
  const url = new URL(request.url);
  const p = url.searchParams;
  const responseType = p.get("response_type");
  const clientId = p.get("client_id") || "";
  const redirectUri = p.get("redirect_uri") || "";
  const codeChallenge = p.get("code_challenge") || "";
  const codeChallengeMethod = p.get("code_challenge_method") || "";
  const state = p.get("state") || "";
  const scope = p.get("scope") || "mcp";
  const resource = p.get("resource") || "";

  if (responseType !== "code") return authHtml("<p>invalid_request: response_type must be \"code\"</p>", 400);
  const client = await readClient(env, clientId);
  if (!client) return authHtml("<p>invalid_request: unknown or expired client_id (register via /register first)</p>", 400);
  if (!redirectUri || !client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri)))
    return authHtml("<p>invalid_request: redirect_uri does not match a registered redirect URI for this client</p>", 400);
  // From here on redirect_uri is a trusted, registered value.
  if (!codeChallenge || codeChallengeMethod !== "S256")
    return authHtml("<p>invalid_request: PKCE (code_challenge with code_challenge_method=S256) is required</p>", 400);

  const pending = await mintToken(env.OAUTH_SIGNING_KEY, CSRF_PREFIX, { clientId, redirectUri, codeChallenge, state, scope, resource, clientName: client.client_name }, CSRF_TTL_S);
  const redirectHost = new URL(redirectUri).host;
  return authHtml(consentPage({ pending, clientName: client.client_name, redirectHost, trusted: isTrustedHost(redirectHost) }));
}

// ---------------------------------------------------------------- /authorize (POST: consent submit)

export async function handleAuthorizePost(request, env) {
  if (!env.OAUTH_SIGNING_KEY) return authHtml("<p>OAuth signing key not configured.</p>", 500);
  if (!env.OAUTH_KV) return authHtml("<p>OAuth storage not configured.</p>", 500);
  if (!(await withinIpLimit(env, request, "authpost"))) return authHtml("<p>Too many requests. Try again in a minute.</p>", 429);

  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/x-www-form-urlencoded")) return authHtml("<p>invalid_request: send application/x-www-form-urlencoded</p>", 400);
  const fields = new URLSearchParams(await request.text());

  const pendingToken = fields.get("csrf") || "";
  const pending = await readToken(env.OAUTH_SIGNING_KEY, CSRF_PREFIX, pendingToken);
  if (!pending) return authHtml("<p>invalid_request: consent session expired or invalid — go back and try again</p>", 400);
  const redirectHost = new URL(pending.redirectUri).host;
  const trusted = isTrustedHost(redirectHost);

  const choice = fields.get("choice") || "free";
  let grant;
  if (choice === "apikey") {
    const apiKey = fields.get("api_key") || "";
    if (!apiKey)
      return authHtml(consentPage({ pending: pendingToken, clientName: pending.clientName, redirectHost, trusted, error: "Enter an API key, or choose free access." }), 400);
    const found = await lookupApiKey(apiKey, env);
    if (!found || found.revoked)
      return authHtml(consentPage({ pending: pendingToken, clientName: pending.clientName, redirectHost, trusted, error: "That API key is invalid or has been revoked." }), 401);
    grant = { mode: "apikey", label: found.label, tier: found.tier, apiKeyEnc: await encryptApiKey(env.OAUTH_SIGNING_KEY, apiKey) };
  } else {
    grant = { mode: "free", label: "anonymous-oauth", tier: "free" };
  }

  const code = randomToken(CODE_PREFIX);
  await env.OAUTH_KV.put(`authcode:${code}`, JSON.stringify({
    clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge,
    scope: pending.scope, resource: pending.resource, grant,
  }), { expirationTtl: AUTH_CODE_TTL_S });

  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set("code", code);
  if (pending.state) redirect.searchParams.set("state", pending.state);
  return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
}

// ---------------------------------------------------------------- /token

async function mintTokenPair(env, { clientId, mode, label, tier, scope, apiKeyEnc }, sessionId) {
  const payload = { clientId, mode, label, tier, scope, apiKeyEnc };
  // jti: a fresh random id on every mint, distinct from sessionId. Two tokens minted in the
  // same wall-clock second would otherwise be byte-identical (same payload, same iat/exp),
  // which is harmless for bearer validity but makes "did rotation actually happen" hard to
  // observe/test — a per-mint jti guarantees every issued token is unique.
  const jti = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const accessToken = await mintToken(env.OAUTH_SIGNING_KEY, ACCESS_PREFIX, { ...payload, jti }, ACCESS_TTL_S);
  const refreshToken = await mintToken(env.OAUTH_SIGNING_KEY, REFRESH_PREFIX, { ...payload, sessionId, jti }, REFRESH_TTL_S);
  await env.OAUTH_KV.put(`session:${sessionId}`, await sha256Hex(refreshToken), { expirationTtl: REFRESH_TTL_S });
  return { accessToken, refreshToken };
}

export async function handleToken(request, env) {
  if (!env.OAUTH_SIGNING_KEY) return j({ error: "server_error", error_description: "OAuth signing key not configured" }, 500);
  if (!env.OAUTH_KV) return j({ error: "server_error", error_description: "OAuth storage not configured" }, 500);
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/x-www-form-urlencoded"))
    return j({ error: "invalid_request", error_description: "send application/x-www-form-urlencoded" }, 400);
  const fields = new URLSearchParams(await request.text());
  const grantType = fields.get("grant_type");

  if (grantType === "authorization_code") {
    const code = fields.get("code") || "";
    const redirectUri = fields.get("redirect_uri") || "";
    const clientId = fields.get("client_id") || "";
    const codeVerifier = fields.get("code_verifier") || "";

    const raw = code ? await env.OAUTH_KV.get(`authcode:${code}`) : null;
    if (!raw) return j({ error: "invalid_grant", error_description: "unknown, expired, or already-used authorization code" }, 400);
    await env.OAUTH_KV.delete(`authcode:${code}`); // single-use regardless of outcome below
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { return j({ error: "invalid_grant" }, 400); }

    if (rec.clientId !== clientId) return j({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    if (rec.redirectUri !== redirectUri) return j({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (!codeVerifier) return j({ error: "invalid_grant", error_description: "code_verifier is required (PKCE)" }, 400);
    const computed = b64url(await sha256Bytes(codeVerifier));
    if (!timingSafeEqual(computed, rec.codeChallenge)) return j({ error: "invalid_grant", error_description: "code_verifier does not match code_challenge" }, 400);

    const sessionId = randomToken("", 16);
    const { accessToken, refreshToken } = await mintTokenPair(env, { clientId, ...rec.grant, scope: rec.scope }, sessionId);
    return j({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: rec.scope });
  }

  if (grantType === "refresh_token") {
    const presented = fields.get("refresh_token") || "";
    const rec = await readToken(env.OAUTH_SIGNING_KEY, REFRESH_PREFIX, presented);
    if (!rec || !rec.sessionId) return j({ error: "invalid_grant", error_description: "unknown, expired, or malformed refresh token" }, 400);

    const storedHash = await env.OAUTH_KV.get(`session:${rec.sessionId}`);
    if (!storedHash) return j({ error: "invalid_grant", error_description: "session expired or revoked" }, 400);
    const presentedHash = await sha256Hex(presented);
    if (!timingSafeEqual(storedHash, presentedHash)) {
      // Reuse of an already-rotated refresh token: a strong signal of theft. Kill the
      // whole session rather than silently ignoring the replay.
      await env.OAUTH_KV.delete(`session:${rec.sessionId}`);
      return j({ error: "invalid_grant", error_description: "refresh token has already been used (session revoked)" }, 400);
    }

    let { label, tier } = rec;
    if (rec.mode === "apikey") {
      const apiKey = await decryptApiKey(env.OAUTH_SIGNING_KEY, rec.apiKeyEnc);
      const found = apiKey ? await lookupApiKey(apiKey, env) : null;
      if (!found || found.revoked) {
        await env.OAUTH_KV.delete(`session:${rec.sessionId}`);
        return j({ error: "invalid_grant", error_description: "the underlying API key has been revoked" }, 400);
      }
      label = found.label; tier = found.tier;
    }

    const { accessToken, refreshToken } = await mintTokenPair(env, { clientId: rec.clientId, mode: rec.mode, label, tier, scope: rec.scope, apiKeyEnc: rec.apiKeyEnc }, rec.sessionId);
    return j({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: rec.scope });
  }

  return j({ error: "unsupported_grant_type", error_description: "supported: authorization_code, refresh_token" }, 400);
}

// ---------------------------------------------------------------- resource-server side (used by index.js authorize())

// Verifies a presented OAuth access token (already stripped of "Bearer "), fully
// stateless (no KV). Returns null if OAUTH_SIGNING_KEY is unset, the token isn't an
// OAuth token (caller falls back to the legacy API-key path), or the signature/expiry
// check fails. For an apikey-mode grant, `apiKeyRef` is the decrypted raw key — the
// caller (index.js) MUST re-validate it with lookupApiKey() on every call (a read, not a
// write) so a revoked key stops working immediately, and MUST rate-limit by that same
// key so an API key and its OAuth tokens share one bucket. For a free-mode grant, the
// caller MUST rate-limit by IP exactly like an anonymous request, so minting free OAuth
// tokens can't bypass the anonymous rate limit.
export async function verifyAccessToken(token, env) {
  if (!env.OAUTH_SIGNING_KEY) return null;
  const payload = await readToken(env.OAUTH_SIGNING_KEY, ACCESS_PREFIX, token);
  if (!payload) return null;
  const out = { mode: payload.mode, label: payload.label, tier: payload.tier, scope: payload.scope, clientId: payload.clientId };
  if (payload.mode === "apikey") {
    const apiKeyRef = await decryptApiKey(env.OAUTH_SIGNING_KEY, payload.apiKeyEnc);
    if (!apiKeyRef) return null; // tampered/undecryptable — treat as invalid
    out.apiKeyRef = apiKeyRef;
  }
  return out;
}

export { wwwAuthenticate, isAllowedRedirectUri, redirectUriMatches, mintToken, readToken, ACCESS_TTL_S };
