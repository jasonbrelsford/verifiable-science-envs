// OAuth 2.1 sign-in for the remote MCP endpoint, per the MCP 2026-07-28
// authorization spec (RFC 9728 protected resource metadata, RFC 8414 server
// metadata, PKCE S256, RFC 8707 resource indicators, RFC 9207 `iss`, Client ID
// Metadata Documents, and stateless Dynamic Client Registration for clients
// that predate CIMD). Design and threat model: docs/MCP_OAUTH.md.
//
// OFF unless ALL of: OAUTH_ENABLED === "1", OAUTH_TOKEN_SECRET (>= 32 chars),
// and the KEYS KV binding. oauthConfig() returns null otherwise and index.js
// then never calls into this module, so every existing route, header and body
// is unchanged and the routes below 404 exactly like any unknown path.
//
// The Worker is its own authorization server. There are no user accounts: the
// consent page asks for an existing HLA-Verify API key (Stripe-issued KV record
// or the HLA_VERIFY_API_KEYS secret) and every code/token carries that key,
// AES-GCM encrypted under a key derived from OAUTH_TOKEN_SECRET. /mcp decrypts
// the access token and runs the key through the same authorizeKey() path as an
// X-API-Key request, so a token gets exactly the key's tier and rate limit, and
// revoking the key stops the token on the next request. The client never sees
// the key. KV is written only for single-use markers (authorization codes,
// rotated refresh tokens) and refresh-token family revocation, under "oauth/".
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { parseKeys } from "./keys.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 120;
const CONSENT_TTL_S = 600;
const KV_MIN_TTL_S = 60; // Cloudflare KV rejects expirationTtl below 60 seconds
const SCOPE = "mcp";
const MAX_BODY = 16384;
const MAX_CLIENT_DOC = 16384;
const MAX_URI = 512;
const MAX_CLIENT_ID = 4096;
const MAX_STATE = 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME = 100;
const CSRF_COOKIE = "__Host-hlv_oauth";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Port may vary per request only for loopback IP literals (OAuth 2.1 §8.4.2).
const LOOPBACK_IPS = new Set(["127.0.0.1", "[::1]"]);
// Token prefixes; the sealed payload's AAD is the type, so one kind can never
// be replayed as another even if the prefix is edited.
const PREFIX = { at: "hlvat_", rt: "hlvrt_", code: "hlvac_", req: "hlvrq_", client: "hlvci_" };
const GRANT_TYPES = ["authorization_code", "refresh_token"];

export function oauthConfig(env) {
  if (!env || env.OAUTH_ENABLED !== "1") return null;
  const secret = env.OAUTH_TOKEN_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !env.KEYS) return null;
  return { secret };
}

// Issuer and resource are derived from the request host so a token minted on
// one hostname is never accepted on another. Plain http is honoured only on
// loopback (wrangler dev); anything else is reported as https.
function issuerFor(url) {
  return `${LOOPBACK_HOSTS.has(url.hostname) ? url.protocol : "https:"}//${url.host}`;
}
const resourceFor = (issuer) => `${issuer}/mcp`;
const prmUrl = (issuer) => `${issuer}/.well-known/oauth-protected-resource/mcp`;

// ------------------------------------------------------------------ crypto

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map();

function aesKey(secret) {
  let p = keyCache.get(secret);
  if (!p) {
    if (keyCache.size > 4) keyCache.clear();
    p = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("hla-verify/oauth/v1"), info: new Uint8Array(0) },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    keyCache.set(secret, p);
  }
  return p;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch (_) {
    return null;
  }
}
const randomId = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const nowS = () => Math.floor(Date.now() / 1000);

async function sha256b64url(s) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function seal(secret, typ, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(typ) },
    await aesKey(secret), encoder.encode(JSON.stringify(payload))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return PREFIX[typ] + b64url(out);
}

// Returns the payload, or null if the value is not a genuine, unexpired `typ`.
async function unseal(secret, typ, value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX[typ]) || value.length > 16384) return null;
  const raw = unb64url(value.slice(PREFIX[typ].length));
  if (!raw || raw.length < 12 + 16) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: encoder.encode(typ) },
      await aesKey(secret), raw.slice(12));
    const obj = JSON.parse(decoder.decode(pt));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.exp === "number" && obj.exp <= nowS()) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------- validation

function redirectUriProblem(s) {
  if (typeof s !== "string" || !s || s.length > MAX_URI) return "redirect_uri is missing or too long";
  let u;
  try { u = new URL(s); } catch (_) { return "redirect_uri must be an absolute URI"; }
  if (s.includes("#")) return "redirect_uri must not contain a fragment";
  if (u.username || u.password) return "redirect_uri must not contain credentials";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "redirect_uri must use https (or http on localhost)";
}

// Exact string match against a registered URI, except that a loopback IP
// literal may use a different port.
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  let a, b;
  try { a = new URL(registered); b = new URL(requested); } catch (_) { return false; }
  return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK_IPS.has(a.hostname) && a.hostname === b.hostname &&
    a.pathname === b.pathname && a.search === b.search && !b.username && !b.password && !requested.includes("#");
}

// RFC 8707: the only protected resource is this host's /mcp. An absent
// resource defaults to it; the bare origin is accepted and narrowed to /mcp.
function resourceProblem(value, issuer) {
  if (value === null || value === undefined || value === "") return null;
  let u;
  try { u = new URL(value); } catch (_) { return "resource must be an absolute URI"; }
  if (value.includes("#") || value.includes("?") || u.username || u.password) return "resource must not have a query, fragment or credentials";
  const base = `${u.protocol}//${u.host}`;
  const p = u.pathname.replace(/\/+$/, "");
  if (base === issuer && (p === "" || p === "/mcp")) return null;
  return `this authorization server only issues tokens for ${resourceFor(issuer)}`;
}

const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

async function readCapped(stream, max) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        try { await reader.cancel(); } catch (_) { /* already closed */ }
        return null;
      }
      chunks.push(value);
    }
  } catch (_) {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return decoder.decode(buf);
}

function duplicated(params, names) {
  return names.find((n) => params.getAll(n).length > 1);
}

// An API key's current standing without touching its rate limit: null if the
// key is unknown, malformed in KV, or revoked (one answer for all three, so
// the consent form reveals nothing beyond "not usable").
async function lookupKey(presented, env) {
  if (typeof presented !== "string" || !presented || presented.length > 256) return null;
  const keys = parseKeys(env.HLA_VERIFY_API_KEYS);
  if (keys.has(presented)) return keys.get(presented);
  if (!env.KEYS) return null;
  let rec = null;
  try {
    const raw = await env.KEYS.get(presented);
    rec = raw ? JSON.parse(raw) : null;
  } catch (_) { /* malformed record: treat as absent */ }
  if (!rec || typeof rec !== "object" || Array.isArray(rec) || rec.status === "revoked") return null;
  return { label: rec.label || "self-serve", tier: rec.tier || "starter" };
}

async function ipLimited(req, env) {
  if (!env.RL) return false;
  try {
    const { success } = await env.RL.limit({ key: `oauth:${req.headers.get("cf-connecting-ip") || "unknown"}` });
    return !success;
  } catch (_) {
    return false; // limiter unavailable: fail open, as authorize() does
  }
}

// ------------------------------------------------------------ client lookup

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Client ID Metadata Document fetch. SSRF guard: https on the default port,
// a DNS name (no IP literal, no localhost, not this host), no redirects, a
// 5 s timeout and a 16 KB cap. Workers cannot reach private networks anyway.
async function fetchClientMetadata(clientId, issuer) {
  let u;
  try { u = new URL(clientId); } catch (_) { return { error: "client_id is not a valid URL" }; }
  const host = u.hostname;
  if (u.protocol !== "https:" || u.port || u.username || u.password || clientId.includes("#") || u.pathname === "/" ||
      u.href !== clientId || IPV4.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost") ||
      !host.includes(".") || host === new URL(issuer).hostname)
    return { error: "client_id must be an https URL with a path on a public DNS name" };
  let resp;
  try {
    resp = await fetch(clientId, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  } catch (_) {
    return { error: "could not fetch the client metadata document" };
  }
  if (resp.status !== 200) {
    try { await resp.body?.cancel(); } catch (_) { /* ignore */ }
    return { error: `client metadata document returned HTTP ${resp.status}` };
  }
  const text = await readCapped(resp.body, MAX_CLIENT_DOC);
  if (text === null) return { error: "client metadata document is too large" };
  let doc;
  try { doc = JSON.parse(text); } catch (_) { return { error: "client metadata document is not JSON" }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "client metadata document is not a JSON object" };
  if (doc.client_id !== clientId) return { error: "client metadata document client_id does not match its URL" };
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) return { error: "client metadata document has no client_name" };
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every((r) => typeof r === "string"))
    return { error: "client metadata document has no redirect_uris" };
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none")
    return { error: "only public clients (token_endpoint_auth_method \"none\") are supported" };
  return { name: doc.client_name.trim().slice(0, MAX_CLIENT_NAME), redirectUris: doc.redirect_uris, kind: "cimd", host };
}

async function resolveClient(clientId, cfg, issuer) {
  if (typeof clientId !== "string" || !clientId || clientId.length > MAX_CLIENT_ID) return { error: "missing or invalid client_id" };
  if (clientId.startsWith(PREFIX.client)) {
    const c = await unseal(cfg.secret, "client", clientId);
    if (!c || !Array.isArray(c.ru)) return { error: "unknown client_id" };
    return { name: c.n, redirectUris: c.ru, kind: "dcr" };
  }
  if (clientId.startsWith("https://")) return fetchClientMetadata(clientId, issuer);
  return { error: "unknown client_id" };
}

// ------------------------------------------------------------------- pages

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function page(status, title, body, extra = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify — ${escHtml(title)}</title>
<meta name="robots" content="noindex">
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4;--warn:#8A5A00}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:560px;margin:0 auto;padding:28px 22px 60px}
h2{font-family:Georgia,serif;color:var(--green)}
dl{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px}dt{font-size:.8rem;color:var(--mut)}dd{margin:0 0 8px;word-break:break-all}
input[type=password]{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid var(--green);background:var(--green);color:#fff;margin:14px 8px 0 0;cursor:pointer}
button.deny{background:#fff;color:var(--green)}
.warn{color:var(--warn)}.err{color:#9B1C1C;font-weight:600}a{color:var(--green)}.mut{color:var(--mut)}
</style></head><body><div class="wrap">
${body}
</div></body></html>`;
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...extra } });
}

const errorPage = (status, message) =>
  page(status, "sign-in error", `<h2>Can't sign in</h2><p>${escHtml(message)}</p><p class="mut">Start again from your MCP client. Nothing was authorized.</p>`);

function consentPage(status, r, requestBlob, { error, cookie } = {}) {
  let redirectHost = "";
  try { redirectHost = new URL(r.ru).host; } catch (_) { /* validated before sealing */ }
  const loopback = LOOPBACK_HOSTS.has(redirectHost.replace(/:\d+$/, ""));
  const who = r.kind === "cimd"
    ? `<dt>Client identity (verified by its metadata document)</dt><dd>${escHtml(r.ch)}</dd>`
    : `<dt>Client identity</dt><dd>self-registered; the name above is not verified</dd>`;
  const body = `<h2>Connect ${escHtml(r.n)} to HLA-Verify</h2>
<dl><dt>Application</dt><dd>${escHtml(r.n)}</dd>${who}
<dt>After you approve you will be sent to</dt><dd><b>${escHtml(redirectHost)}</b></dd>
<dt>Access</dt><dd>HLA-Verify MCP tools at ${escHtml(r.res)}, at your key's tier and rate limit</dd></dl>
${loopback ? `<p class="warn">This application receives the sign-in on your own computer (${escHtml(redirectHost)}). Only continue if you started this sign-in yourself just now.</p>` : ""}
${error ? `<p class="err">${escHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escHtml(requestBlob)}">
<label for="api_key">Your HLA-Verify API key</label>
<input type="password" id="api_key" name="api_key" autocomplete="off" spellcheck="false" required>
<p class="mut">The application gets a 1-hour access token (renewable for 30 days) tied to this key. It never sees the key itself. Cancelling or revoking the key cuts the application off. No key yet? <a href="/pricing">Get one</a>.</p>
<button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny" class="deny" formnovalidate>Deny</button>
</form>`;
  return page(status, "authorize application", body, cookie ? { "set-cookie": cookie } : {});
}

function redirectTo(redirectUri, params, extra = {}) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { location: u.href, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra } });
}

function readCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------- endpoints

const AUTHZ_PARAMS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope"];

async function authorizeGet(req, env, cfg, url, issuer) {
  if (await ipLimited(req, env)) return errorPage(429, "Too many sign-in attempts from this network. Wait a minute and try again.");
  const q = url.searchParams;
  const dup = duplicated(q, AUTHZ_PARAMS);
  if (dup) return errorPage(400, `The ${dup} parameter appears more than once.`);
  const clientId = q.get("client_id");
  const client = await resolveClient(clientId, cfg, issuer);
  if (client.error) return errorPage(400, client.error);
  const redirectUri = q.get("redirect_uri");
  if (redirectUriProblem(redirectUri) || !client.redirectUris.some((r) => redirectMatches(r, redirectUri)))
    return errorPage(400, "The redirect_uri is not registered for this application.");
  const state = q.get("state");
  if (state !== null && state.length > MAX_STATE) return errorPage(400, "The state parameter is too long.");

  // Every client is self-registered (DCR or CIMD), so its redirect_uri is only as
  // trustworthy as whoever registered it. Nothing redirects before a human has
  // seen the consent page (RFC 9700 §4.11.2: no open redirector); request errors
  // are shown here instead.
  const fail = (error, description) => errorPage(400, `${description} (${error}).`);
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (q.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE.test(q.get("code_challenge") || ""))
    return fail("invalid_request", "PKCE is required: code_challenge (43 chars) with code_challenge_method=S256");
  const problem = resourceProblem(q.get("resource"), issuer);
  if (problem) return fail("invalid_target", problem);

  const csrf = randomId(32);
  const r = { cid: clientId, ru: redirectUri, cc: q.get("code_challenge"), res: resourceFor(issuer), st: state,
    n: client.name || "Unnamed MCP client", kind: client.kind, ch: client.host, csrf, exp: nowS() + CONSENT_TTL_S };
  const blob = await seal(cfg.secret, "req", r);
  return consentPage(200, r, blob, { cookie: `${CSRF_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CONSENT_TTL_S}` });
}

async function authorizePost(req, env, cfg, url, issuer) {
  // CSRF: a browser form post from any other origin is refused outright, and the
  // double-submit cookie set with the consent page must match the sealed request.
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return errorPage(403, "Cross-site sign-in request refused.");
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return errorPage(403, "Cross-site sign-in request refused.");
  if (await ipLimited(req, env)) return errorPage(429, "Too many sign-in attempts from this network. Wait a minute and try again.");
  if (!(req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) return errorPage(415, "Unexpected form encoding.");
  const text = await readCapped(req.body, MAX_BODY);
  if (text === null) return errorPage(413, "Form too large.");
  const form = new URLSearchParams(text);
  const blob = form.get("request") || "";
  const r = await unseal(cfg.secret, "req", blob);
  if (!r) return errorPage(400, "This sign-in request has expired or is invalid.");
  if (!timingSafeEqual(readCookie(req, CSRF_COOKIE) || "", r.csrf))
    return errorPage(403, "This sign-in page was not opened in this browser, or it expired. Nothing was authorized.");

  const clearCookie = { "set-cookie": `${CSRF_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` };
  if (form.get("action") !== "approve")
    return redirectTo(r.ru, { error: "access_denied", error_description: "the user denied access", state: r.st, iss: issuer }, clearCookie);

  const apiKey = (form.get("api_key") || "").trim();
  if (!(await lookupKey(apiKey, env))) return consentPage(401, r, blob, { error: "That API key is not valid or is no longer active." });

  const code = await seal(cfg.secret, "code", { k: apiKey, cid: await sha256b64url(r.cid), ru: await sha256b64url(r.ru), cc: r.cc,
    res: r.res, jti: randomId(), fid: randomId(), exp: nowS() + CODE_TTL_S });
  return redirectTo(r.ru, { code, state: r.st, iss: issuer }, clearCookie);
}

const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };

async function issueTokens(cfg, k, cidHash, res, fid) {
  const iat = nowS();
  const access_token = await seal(cfg.secret, "at", { k, aud: res, scope: SCOPE, iat, exp: iat + ACCESS_TTL_S });
  const refresh_token = await seal(cfg.secret, "rt", { k, cid: cidHash, aud: res, fid, jti: randomId(), iat, exp: iat + REFRESH_TTL_S });
  return { access_token, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token, scope: SCOPE };
}

// Single-use markers. Values are deliberately not JSON so authorize() can never
// mistake a marker for a key record. KV is eventually consistent, so two
// redemptions racing through different edge locations within ~60 s can both
// succeed; PKCE (codes) and client binding (refresh tokens) still apply.
const usedKey = (kind, id) => `oauth/used/${kind}/${id}`;
const familyKey = (fid) => `oauth/revoked-family/${fid}`;
async function markUsed(env, key, exp) {
  await env.KEYS.put(key, "used", { expirationTtl: Math.max(KV_MIN_TTL_S, exp - nowS() + KV_MIN_TTL_S) });
}

async function token(req, env, cfg, url, issuer, json) {
  const fail = (error, error_description, status = 400) => json({ error, error_description }, status, TOKEN_HEADERS);
  if (!(req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded"))
    return fail("invalid_request", "send application/x-www-form-urlencoded");
  const text = await readCapped(req.body, MAX_BODY);
  if (text === null) return fail("invalid_request", "request body too large");
  const form = new URLSearchParams(text);
  const dup = duplicated(form, ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "refresh_token", "resource"]);
  if (dup) return fail("invalid_request", `${dup} appears more than once`);
  const clientId = form.get("client_id");
  if (!clientId) return fail("invalid_request", "client_id is required");
  const cidHash = await sha256b64url(clientId);
  const resProblem = resourceProblem(form.get("resource"), issuer);
  if (resProblem) return fail("invalid_target", resProblem);

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = await unseal(cfg.secret, "code", form.get("code") || "");
    if (!code) return fail("invalid_grant", "authorization code is invalid or expired");
    if (!timingSafeEqual(code.cid, cidHash)) return fail("invalid_grant", "authorization code was issued to another client");
    if (!timingSafeEqual(code.ru, await sha256b64url(form.get("redirect_uri") || ""))) return fail("invalid_grant", "redirect_uri does not match the authorization request");
    if (code.res !== resourceFor(issuer)) return fail("invalid_grant", "authorization code was issued for another resource");
    const verifier = form.get("code_verifier") || "";
    if (!PKCE_VERIFIER.test(verifier) || !timingSafeEqual(await sha256b64url(verifier), code.cc)) return fail("invalid_grant", "PKCE verification failed");
    const marker = usedKey("code", code.jti);
    if ((await env.KEYS.get(marker)) !== null) {
      await env.KEYS.put(familyKey(code.fid), "revoked", { expirationTtl: REFRESH_TTL_S });
      return fail("invalid_grant", "authorization code has already been used");
    }
    await markUsed(env, marker, code.exp);
    if (!(await lookupKey(code.k, env))) return fail("invalid_grant", "the API key behind this grant is no longer active");
    return json(await issueTokens(cfg, code.k, cidHash, code.res, code.fid), 200, TOKEN_HEADERS);
  }

  if (grant === "refresh_token") {
    const rt = await unseal(cfg.secret, "rt", form.get("refresh_token") || "");
    if (!rt) return fail("invalid_grant", "refresh token is invalid or expired");
    if (!timingSafeEqual(rt.cid, cidHash)) return fail("invalid_grant", "refresh token was issued to another client");
    if (rt.aud !== resourceFor(issuer)) return fail("invalid_grant", "refresh token was issued for another resource");
    if ((await env.KEYS.get(familyKey(rt.fid))) !== null) return fail("invalid_grant", "refresh token has been revoked");
    const marker = usedKey("rt", rt.jti);
    if ((await env.KEYS.get(marker)) !== null) {
      // Reuse of a rotated refresh token means one copy leaked: revoke the family.
      await env.KEYS.put(familyKey(rt.fid), "revoked", { expirationTtl: REFRESH_TTL_S });
      return fail("invalid_grant", "refresh token has already been used");
    }
    await markUsed(env, marker, rt.exp);
    if (!(await lookupKey(rt.k, env))) return fail("invalid_grant", "the API key behind this grant is no longer active");
    return json(await issueTokens(cfg, rt.k, cidHash, rt.aud, rt.fid), 200, TOKEN_HEADERS);
  }

  return fail("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

// Dynamic Client Registration (RFC 7591; deprecated by MCP in favour of CIMD,
// kept for clients that only speak DCR). Stateless: the client_id IS the sealed
// registration, so nothing is stored and nothing can be enumerated.
async function register(req, env, cfg, json) {
  const fail = (error, error_description) => json({ error, error_description }, 400, TOKEN_HEADERS);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return fail("invalid_client_metadata", "send application/json");
  const text = await readCapped(req.body, MAX_BODY);
  if (text === null) return fail("invalid_client_metadata", "request body too large");
  let body;
  try { body = JSON.parse(text); } catch (_) { return fail("invalid_client_metadata", "malformed JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_client_metadata", "body must be a JSON object");
  const ru = body.redirect_uris;
  if (!Array.isArray(ru) || !ru.length || ru.length > MAX_REDIRECT_URIS)
    return fail("invalid_redirect_uri", `redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs`);
  for (const r of ru) {
    const p = redirectUriProblem(r);
    if (p) return fail("invalid_redirect_uri", p);
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, MAX_CLIENT_NAME) : "Unnamed MCP client";
  const iat = nowS();
  const client_id = await seal(cfg.secret, "client", { ru, n: name, iat });
  // Public clients only: any requested auth method is replaced with "none" (RFC 7591 §3.2.1).
  return json({ client_id, client_id_issued_at: iat, client_name: name, redirect_uris: ru, grant_types: GRANT_TYPES,
    response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE }, 201, TOKEN_HEADERS);
}

function protectedResourceMetadata(issuer) {
  return { resource: resourceFor(issuer), authorization_servers: [issuer], scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"], resource_name: "HLA-Verify", resource_documentation: `${issuer}/docs` };
}

function authorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_TYPES,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/docs`,
  };
}

// handleOAuth: every /.well-known/oauth-* and /oauth/* request, only when
// oauthConfig(env) is non-null. `json`/`err` are index.js's response helpers.
export async function handleOAuth(req, env, cfg, url, path, helpers) {
  try {
    return await route(req, env, cfg, url, path, helpers);
  } catch (_) {
    // e.g. KV unavailable or over its write quota: fail closed, never half-issue.
    if (path === "/oauth/token" || path === "/oauth/register")
      return helpers.json({ error: "temporarily_unavailable", error_description: "try again shortly" }, 503, TOKEN_HEADERS);
    return errorPage(503, "Sign-in is temporarily unavailable. Try again shortly.");
  }
}

async function route(req, env, cfg, url, path, { json, err }) {
  const issuer = issuerFor(url);
  const META = { "cache-control": "public, max-age=300" };
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    if (req.method !== "GET") return err(405, "GET");
    return json(protectedResourceMetadata(issuer), 200, META);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    if (req.method !== "GET") return err(405, "GET");
    return json(authorizationServerMetadata(issuer), 200, META);
  }
  if (path === "/oauth/authorize") {
    if (req.method === "GET") return authorizeGet(req, env, cfg, url, issuer);
    if (req.method === "POST") return authorizePost(req, env, cfg, url, issuer);
    return err(405, "GET or POST /oauth/authorize");
  }
  if (path === "/oauth/token") {
    if (req.method !== "POST") return err(405, "POST /oauth/token");
    return token(req, env, cfg, url, issuer, json);
  }
  if (path === "/oauth/register") {
    if (req.method !== "POST") return err(405, "POST /oauth/register");
    return register(req, env, cfg, json);
  }
  return err(404, "Not Found");
}

function withChallenge(resp, challenge) {
  const headers = new Headers(resp.headers);
  headers.set("www-authenticate", challenge);
  headers.set("access-control-expose-headers", "www-authenticate");
  return new Response(resp.body, { status: resp.status, headers });
}

// authorizeMcp: /mcp authorization when OAuth is on. An `hlvat_` bearer token is
// decrypted, audience-checked against this host's /mcp, and its API key is run
// through authorizeKey() (same tier, rate limit and revocation check as sending
// the key directly). Anything else goes through the unchanged authorize(); its
// 401s gain the RFC 9728 WWW-Authenticate challenge so clients can discover us.
export async function authorizeMcp(req, env, cfg, url, { authorize, authorizeKey, err }) {
  const issuer = issuerFor(url);
  const base = `Bearer resource_metadata="${prmUrl(issuer)}", scope="${SCOPE}"`;
  const bearer = req.headers.get("authorization") || "";
  if (!req.headers.get("x-api-key") && bearer.toLowerCase().startsWith("bearer ")) {
    const presented = bearer.slice(7).trim();
    if (presented.startsWith(PREFIX.at)) {
      const invalid = (detail) => withChallenge(err(401, detail), `${base}, error="invalid_token", error_description="${detail}"`);
      const at = await unseal(cfg.secret, "at", presented);
      if (!at || at.aud !== resourceFor(issuer) || typeof at.k !== "string") return invalid("invalid or expired access token");
      const who = await authorizeKey(at.k, env);
      if (who instanceof Response && who.status === 401) return invalid("the API key behind this access token is no longer active");
      return who;
    }
  }
  const who = await authorize(req, env);
  if (who instanceof Response && who.status === 401) return withChallenge(who, base);
  return who;
}
