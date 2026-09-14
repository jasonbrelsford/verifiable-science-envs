// OAuth 2.1 for /mcp — hand-rolled per docs/CLAUDE-CONNECTOR.md section 6 (a full design
// rationale, including why @cloudflare/workers-oauth-provider was not used, lives there).
//
// Implements: RFC 9728 (Protected Resource Metadata), RFC 8414 (Authorization Server
// Metadata), RFC 7591 (Dynamic Client Registration), OAuth 2.1 authorization_code grant
// with mandatory PKCE (S256), and refresh_token grant with rotation.
//
// No user accounts, no passwords, ever. The consent page (/authorize) offers exactly two
// choices: anonymous free-tier access, or "use my HLA-Verify API key" (validated with the
// same lookupApiKey() the REST/MCP API already uses). Tokens are stored in KV (binding
// OAUTH_KV, see wrangler.jsonc) as SHA-256 hashes only — the raw token value is never
// written to KV, only returned once to the client. The one exception, documented in
// docs/CLAUDE-CONNECTOR.md section 6, is that a pasted API key is kept (server-side only,
// never echoed to the browser, never logged) alongside its refresh-token record so a
// refresh can re-check the key hasn't since been revoked.
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { lookupApiKey } from "./keys.js";

export const ACCESS_PREFIX = "hoat_"; // OAuth access token — never collides with hlv_-prefixed API keys
export const REFRESH_PREFIX = "hort_"; // OAuth refresh token
const CLIENT_PREFIX = "hcid_";
const CODE_PREFIX = "hac_";
const CSRF_PREFIX = "hcsrf_";

const ACCESS_TTL_S = 60 * 60; // 1h
const REFRESH_TTL_S = 60 * 60 * 24 * 30; // 30d
const AUTH_CODE_TTL_S = 120; // single-use, short-lived
const CSRF_TTL_S = 600; // 10 minutes to complete consent

const encoder = new TextEncoder();

function b64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken(prefix, nBytes = 32) {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Base64Url(s) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return b64url(new Uint8Array(digest));
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
// Loopback redirect_uri comparison ignores the port (Claude Code binds an ephemeral port
// per session); every other comparison is an exact string match, per the MCP spec's
// "authorization servers MUST validate exact redirect URIs against pre-registered values".
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
    // "none": we are a public client authorization server (PKCE only, no client secret).
    // Deliberately NOT advertising client_id_metadata_document_supported — Claude only
    // attempts CIMD when BOTH that flag and this one are present; omitting it means
    // Claude falls back to DCR (registration_endpoint above), which is what we implement.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

// ---------------------------------------------------------------- DCR (RFC 7591)

export async function handleRegister(request, env) {
  if (!env.OAUTH_KV) return j({ error: "server_error", error_description: "OAuth storage not configured" }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return j({ error: "invalid_client_metadata", error_description: "malformed JSON" }, 400); }
  const redirectUris = Array.isArray(body && body.redirect_uris) ? body.redirect_uris : null;
  if (!redirectUris || redirectUris.length === 0)
    return j({ error: "invalid_client_metadata", error_description: "redirect_uris is required and must be a non-empty array" }, 400);
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri))
      return j({ error: "invalid_redirect_uri", error_description: `redirect_uri must be https:// or a loopback URI: ${uri}` }, 400);
  }
  const clientId = randomToken(CLIENT_PREFIX, 16);
  const clientName = typeof (body && body.client_name) === "string" ? body.client_name.slice(0, 200) : "MCP client";
  const record = { client_id: clientId, client_name: clientName, redirect_uris: redirectUris, token_endpoint_auth_method: "none", created: new Date().toISOString() };
  await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(record));
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

async function getClient(env, clientId) {
  if (!env.OAUTH_KV || !clientId) return null;
  const raw = await env.OAUTH_KV.get(`client:${clientId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---------------------------------------------------------------- /authorize (GET: consent page)

function consentPage({ csrf, error, clientName }) {
  const errBlock = error ? `<p style="color:#b00020"><strong>Error:</strong> ${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connect to HLA-Verify</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>Connect to HLA-Verify</h1>
<p><strong>${escapeHtml(clientName || "An MCP client")}</strong> wants to access the HLA-Verify API on your behalf.</p>
${errBlock}
<form method="POST" action="/authorize">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<fieldset style="border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:16px">
<legend>Choose access</legend>
<p><label><input type="radio" name="choice" value="free" checked> Continue with free access (rate-limited, no API key needed)</label></p>
<p><label><input type="radio" name="choice" value="apikey"> Use my HLA-Verify API key</label></p>
<p style="margin-left:24px"><input type="password" name="api_key" placeholder="hlv_..." autocomplete="off" style="width:100%;box-sizing:border-box"></p>
</fieldset>
<p style="font-size:0.9em;color:#555">HLA-Verify is a research-and-evaluation tool. <strong>Not a medical device. Not for clinical use.</strong>
See the <a href="https://hlaverify.com/privacy" target="_blank" rel="noopener">privacy policy</a> and
<a href="https://hlaverify.com/terms" target="_blank" rel="noopener">terms</a>.</p>
<button type="submit" style="padding:10px 20px;font-size:1em">Authorize</button>
</form>
</body></html>`;
}

export async function handleAuthorizeGet(request, env) {
  if (!env.OAUTH_KV) return html("<p>OAuth storage not configured.</p>", 500);
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

  if (responseType !== "code") return html("<p>invalid_request: response_type must be \"code\"</p>", 400);
  const client = await getClient(env, clientId);
  if (!client) return html("<p>invalid_request: unknown client_id (register via /register first)</p>", 400);
  if (!redirectUri || !client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri)))
    return html("<p>invalid_request: redirect_uri does not match a registered redirect URI for this client</p>", 400);
  // From here on redirect_uri is a trusted, registered value, so later errors MAY redirect.
  if (!codeChallenge || codeChallengeMethod !== "S256")
    return html("<p>invalid_request: PKCE (code_challenge with code_challenge_method=S256) is required</p>", 400);

  const csrf = randomToken(CSRF_PREFIX, 24);
  await env.OAUTH_KV.put(`csrf:${csrf}`, JSON.stringify({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state, scope, resource }), { expirationTtl: CSRF_TTL_S });
  return html(consentPage({ csrf, clientName: client.client_name }));
}

// ---------------------------------------------------------------- /authorize (POST: consent submit)

export async function handleAuthorizePost(request, env) {
  if (!env.OAUTH_KV) return html("<p>OAuth storage not configured.</p>", 500);
  const ct = request.headers.get("content-type") || "";
  let fields;
  if (ct.includes("application/x-www-form-urlencoded")) {
    fields = new URLSearchParams(await request.text());
  } else {
    return html("<p>invalid_request: send application/x-www-form-urlencoded</p>", 400);
  }
  const csrf = fields.get("csrf") || "";
  const raw = csrf ? await env.OAUTH_KV.get(`csrf:${csrf}`) : null;
  if (!raw) return html("<p>invalid_request: consent session expired or invalid — go back and try again</p>", 400);
  await env.OAUTH_KV.delete(`csrf:${csrf}`); // single-use, whether or not the choice is valid
  let pending;
  try { pending = JSON.parse(raw); } catch (_) { return html("<p>invalid_request: corrupt consent session</p>", 400); }

  const client = await getClient(env, pending.clientId);
  if (!client) return html("<p>invalid_request: client no longer registered</p>", 400);

  const choice = fields.get("choice") || "free";
  let grant;
  if (choice === "apikey") {
    const apiKey = fields.get("api_key") || "";
    if (!apiKey) return html(consentPage({ csrf: await reissueCsrf(env, pending), clientName: client.client_name, error: "Enter an API key, or choose free access." }), 400);
    const found = await lookupApiKey(apiKey, env);
    if (!found || found.revoked) return html(consentPage({ csrf: await reissueCsrf(env, pending), clientName: client.client_name, error: "That API key is invalid or has been revoked." }), 401);
    grant = { mode: "apikey", label: found.label, tier: found.tier, apiKeyRef: apiKey };
  } else {
    grant = { mode: "free", label: "anonymous-oauth", tier: "free" };
  }

  const code = randomToken(CODE_PREFIX, 24);
  await env.OAUTH_KV.put(`authcode:${code}`, JSON.stringify({
    clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge,
    scope: pending.scope, resource: pending.resource, grant,
  }), { expirationTtl: AUTH_CODE_TTL_S });

  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set("code", code);
  if (pending.state) redirect.searchParams.set("state", pending.state);
  return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store" } });
}

// Re-shows the consent form after a rejected API key without losing the original
// authorize() request (new csrf token, same pending params, same TTL policy).
async function reissueCsrf(env, pending) {
  const csrf = randomToken(CSRF_PREFIX, 24);
  await env.OAUTH_KV.put(`csrf:${csrf}`, JSON.stringify(pending), { expirationTtl: CSRF_TTL_S });
  return csrf;
}

// ---------------------------------------------------------------- /token

async function issueTokenPair(env, { clientId, mode, label, tier, scope, apiKeyRef }) {
  const accessToken = randomToken(ACCESS_PREFIX);
  const refreshToken = randomToken(REFRESH_PREFIX);
  const accessRec = { clientId, mode, label, tier, scope };
  const refreshRec = { clientId, mode, label, tier, scope, apiKeyRef: mode === "apikey" ? apiKeyRef : undefined };
  await env.OAUTH_KV.put(`token:${await sha256Hex(accessToken)}`, JSON.stringify(accessRec), { expirationTtl: ACCESS_TTL_S });
  await env.OAUTH_KV.put(`refresh:${await sha256Hex(refreshToken)}`, JSON.stringify(refreshRec), { expirationTtl: REFRESH_TTL_S });
  return { accessToken, refreshToken };
}

export async function handleToken(request, env) {
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
    const computed = await sha256Base64Url(codeVerifier);
    if (!timingSafeEqual(computed, rec.codeChallenge)) return j({ error: "invalid_grant", error_description: "code_verifier does not match code_challenge" }, 400);

    const { accessToken, refreshToken } = await issueTokenPair(env, { clientId, ...rec.grant, scope: rec.scope });
    return j({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: rec.scope });
  }

  if (grantType === "refresh_token") {
    const presented = fields.get("refresh_token") || "";
    if (!presented) return j({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
    const hash = await sha256Hex(presented);
    const raw = await env.OAUTH_KV.get(`refresh:${hash}`);
    if (!raw) return j({ error: "invalid_grant", error_description: "unknown, expired, or already-used refresh token" }, 400);
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { await env.OAUTH_KV.delete(`refresh:${hash}`); return j({ error: "invalid_grant" }, 400); }

    // Re-check revocation for tokens minted from a pasted API key: a key revoked after
    // the OAuth token was issued must stop refreshing (see docs/CLAUDE-CONNECTOR.md §6/9).
    if (rec.mode === "apikey") {
      const found = await lookupApiKey(rec.apiKeyRef, env);
      if (!found || found.revoked) {
        await env.OAUTH_KV.delete(`refresh:${hash}`);
        return j({ error: "invalid_grant", error_description: "the underlying API key has been revoked" }, 400);
      }
      rec.label = found.label;
      rec.tier = found.tier;
    }

    await env.OAUTH_KV.delete(`refresh:${hash}`); // rotate: old refresh token is now dead
    const { accessToken, refreshToken } = await issueTokenPair(env, rec);
    return j({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: rec.scope });
  }

  return j({ error: "unsupported_grant_type", error_description: "supported: authorization_code, refresh_token" }, 400);
}

// ---------------------------------------------------------------- resource-server side (used by index.js authorize())

// Resolves a presented OAuth access token (already stripped of "Bearer ") to the same
// {label, tier, keyed} shape index.js's authorize() uses for API keys. Returns null if
// env.OAUTH_KV is unbound, the token is not an OAuth token (caller should fall back to
// the legacy API-key path), or the token is unknown/expired.
export async function resolveOAuthAccessToken(token, env) {
  if (!env.OAUTH_KV || typeof token !== "string" || !token.startsWith(ACCESS_PREFIX)) return null;
  const raw = await env.OAUTH_KV.get(`token:${await sha256Hex(token)}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return { label: rec.label, tier: rec.tier, keyed: true, oauth: true };
  } catch (_) {
    return null;
  }
}

export { wwwAuthenticate, isAllowedRedirectUri, redirectUriMatches };
