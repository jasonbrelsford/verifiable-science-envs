// OAuth 2.1 flow tests (docs/CLAUDE-CONNECTOR.md section 6/6a): metadata endpoints, dynamic
// client registration (stateless, zero KV writes), the full authorize -> consent -> code ->
// token exchange, PKCE failure, a wrong redirect_uri, refresh (including rotation and a
// revoked API key), signed-token tampering and expiry, rate limiting for both free-mode and
// apikey-mode OAuth identities, the consent page's frame-busting headers, and an MCP call
// authenticated with an OAuth access token. Uses a mock KV (same in-memory Map pattern as
// stripe.test.mjs's fakeKV) standing in for the OAUTH_KV binding, which now only holds
// authorization codes and the refresh-token-rotation pointer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

import worker from "../src/index.js";
import { mintToken, readToken, ACCESS_PREFIX } from "../src/oauth.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

function fakeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, _opts) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}
// A limiter that always allows (default) or a fixed-outcome stub for testing 429s.
function fakeLimiter(alwaysAllow = true) {
  return { async limit() { return { success: alwaysAllow }; }, calls: [] };
}
function denyingLimiter() {
  const calls = [];
  return { calls, async limit(opts) { calls.push(opts); return { success: false }; } };
}

function assetsStub() {
  return {
    async fetch(u) {
      const p = new URL(u).pathname; // /data/<shard>.json
      const file = path.join(pub, p);
      try {
        return new Response(await readFile(file, "utf8"), { status: 200 });
      } catch (_) {
        return new Response("not found", { status: 404 });
      }
    },
  };
}

const SIGNING_KEY = "test-signing-key-do-not-use-in-prod";

function baseEnv(extra = {}) {
  return {
    HLA_VERIFY_API_KEYS: "secretkey123=Curated:enterprise",
    KEYS: fakeKV(),
    OAUTH_KV: fakeKV(),
    OAUTH_SIGNING_KEY: SIGNING_KEY,
    ASSETS: assetsStub(),
    PUBLIC_ACCESS: "1",
    RL: fakeLimiter(true),
    RL_STARTER: fakeLimiter(true),
    RL_PRO: fakeLimiter(true),
    ...extra,
  };
}

const ORIGIN = "https://assets.local";
function req(pathAndQuery, init = {}) {
  return new Request(ORIGIN + pathAndQuery, init);
}
function form(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p.toString();
}

// --------------------------------------------------------------------- PKCE helpers

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomVerifier() {
  return b64url(require("node:crypto").randomBytes(32));
}
async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(Buffer.from(digest));
}

// --------------------------------------------------------------------- metadata

test("GET /.well-known/oauth-protected-resource", async () => {
  const resp = await worker.fetch(req("/.well-known/oauth-protected-resource"), baseEnv(), {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(body.authorization_servers, [ORIGIN]);
});

test("GET /.well-known/oauth-protected-resource/mcp (path-suffixed variant)", async () => {
  const resp = await worker.fetch(req("/.well-known/oauth-protected-resource/mcp"), baseEnv(), {});
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).resource, `${ORIGIN}/mcp`);
});

test("GET /.well-known/oauth-authorization-server advertises PKCE S256, DCR, and no CIMD", async () => {
  const resp = await worker.fetch(req("/.well-known/oauth-authorization-server"), baseEnv(), {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.issuer, ORIGIN);
  assert.equal(body.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.equal(body.client_id_metadata_document_supported, undefined, "must not advertise CIMD support");
});

// --------------------------------------------------------------------- DCR: stateless, zero KV writes

test("POST /register: valid redirect_uris issues a public client (no secret), zero KV writes", async () => {
  const env = baseEnv();
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }),
  }), env, {});
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.ok(body.client_id.startsWith("hcid_"));
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(body.client_secret, undefined);
  assert.equal(env.OAUTH_KV._store.size, 0, "DCR must not write to KV");
});

test("POST /register x10: still zero KV writes (client_id is self-describing)", async () => {
  const env = baseEnv();
  for (let i = 0; i < 10; i++) {
    await worker.fetch(req("/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [`https://claude.ai/cb${i}`] }),
    }), env, {});
  }
  assert.equal(env.OAUTH_KV._store.size, 0);
});

test("POST /register: rejects a non-https, non-loopback redirect_uri", async () => {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/callback"] }),
  }), baseEnv(), {});
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).error, "invalid_redirect_uri");
});

test("POST /register: accepts Claude Code's loopback redirect_uris", async () => {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] }),
  }), baseEnv(), {});
  assert.equal(resp.status, 201);
});

test("POST /register: missing redirect_uris is invalid_client_metadata", async () => {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), baseEnv(), {});
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).error, "invalid_client_metadata");
});

test("POST /register: rate-limited by IP", async () => {
  const env = baseEnv({ RL: denyingLimiter() });
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }),
  }), env, {});
  assert.equal(resp.status, 429);
});

// --------------------------------------------------------------------- shared fixtures

async function registerClient(env, redirectUri = "https://claude.ai/api/mcp/auth_callback") {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test Client" }),
  }), env, {});
  return (await resp.json()).client_id;
}
function extractPending(html) {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

// --------------------------------------------------------------------- full flow: free access

test("full flow: authorize -> consent (free) -> code -> token -> MCP call", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const state = "xyz123";

  const authorizeUrl = `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&scope=mcp`;
  const getResp = await worker.fetch(req(authorizeUrl), env, {});
  assert.equal(getResp.status, 200);
  const pageHtml = await getResp.text();
  const pending = extractPending(pageHtml);
  assert.ok(pending, "consent page must include the pending-authorization token");
  assert.match(pageHtml, /claude\.ai/, "must show the redirect destination host prominently");

  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), env, {});
  assert.equal(postResp.status, 302);
  const location = new URL(postResp.headers.get("location"));
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code");
  assert.ok(code);

  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  assert.equal(tokenResp.status, 200);
  const tokens = await tokenResp.json();
  assert.ok(tokens.access_token.startsWith("hoat_"));
  assert.ok(tokens.refresh_token.startsWith("hort_"));
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 60 * 60 * 24);

  // authorization code is single-use
  const replay = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");

  // The access token authenticates an MCP call and maps to the free tier.
  const mcpResp = await worker.fetch(req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(mcpResp.status, 200);
  assert.equal(mcpResp.headers.get("x-hla-verify-tier"), "free");
  const mcpBody = await mcpResp.json();
  assert.equal(mcpBody.result.isError, false);

  // Exactly the auth-code (issue) and refresh-session (issue) writes hit KV — nothing more.
  assert.equal(env.OAUTH_KV._store.size, 1, "authcode deleted on redemption; only the session pointer remains");
});

// --------------------------------------------------------------------- PKCE failure

test("PKCE failure: wrong code_verifier is rejected", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);

  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), env, {});
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");

  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: "totally-wrong-verifier" }),
  }), env, {});
  assert.equal(tokenResp.status, 400);
  assert.equal((await tokenResp.json()).error, "invalid_grant");
});

// --------------------------------------------------------------------- wrong redirect_uri

test("authorize rejects a redirect_uri that wasn't registered for the client", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env, "https://claude.ai/api/mcp/auth_callback");
  const resp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://attacker.example.com/callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  assert.equal(resp.status, 400);
  assert.match(await resp.text(), /redirect_uri/);
});

test("token exchange rejects a redirect_uri that doesn't match the one used at /authorize", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), env, {});
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");

  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/wrong", client_id: clientId, code_verifier: verifier }),
  }), env, {});
  assert.equal(tokenResp.status, 400);
  assert.equal((await tokenResp.json()).error, "invalid_grant");
});

// --------------------------------------------------------------------- API-key grant + refresh + revocation

async function doFullFlowWithApiKey(env, apiKey, redirectUri = "https://claude.ai/api/mcp/auth_callback") {
  const clientId = await registerClient(env, redirectUri);
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "apikey", api_key: apiKey }),
  }), env, {});
  return { postResp, clientId, redirectUri, verifier };
}

test("consent with a valid self-serve API key inherits its tier/label; refresh rotates the tokens", async () => {
  const env = baseEnv();
  await env.KEYS.put("selfservekey", JSON.stringify({ label: "Acme Labs", tier: "pro", status: "active" }));
  const { postResp, clientId, redirectUri, verifier } = await doFullFlowWithApiKey(env, "selfservekey");
  assert.equal(postResp.status, 302);
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");

  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  assert.equal(tokenResp.status, 200);
  const tokens = await tokenResp.json();
  assert.ok(!JSON.stringify(tokens).includes("selfservekey"), "the raw API key must never appear in the token response");

  const mcpResp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(mcpResp.headers.get("x-hla-verify-tier"), "pro");

  // Refresh rotates both tokens.
  const refreshResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  }), env, {});
  assert.equal(refreshResp.status, 200);
  const refreshed = await refreshResp.json();
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  // Exactly one KV key exists at this point: the session pointer was overwritten in place
  // on rotation, not added to — no unbounded growth per refresh.
  assert.equal(env.OAUTH_KV._store.size, 1);

  // Old (rotated) refresh token is now dead — reuse is treated as theft and revokes the
  // whole session (even the just-rotated-in current token stops working).
  const reuseOld = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  }), env, {});
  assert.equal(reuseOld.status, 400);
  assert.equal(env.OAUTH_KV._store.size, 0, "theft-detection revokes the session pointer entirely");
});

test("consent rejects a revoked API key before ever issuing a code", async () => {
  const env = baseEnv();
  await env.KEYS.put("revokedkey", JSON.stringify({ label: "Gone", tier: "starter", status: "revoked" }));
  const { postResp } = await doFullFlowWithApiKey(env, "revokedkey");
  assert.equal(postResp.status, 401);
  assert.match(await postResp.text(), /invalid or has been revoked/);
  assert.equal(env.OAUTH_KV._store.size, 0, "no authorization code should be issued for a rejected key");
});

test("revoking the API key cuts off an already-issued, unexpired access token immediately (no waiting for refresh)", async () => {
  const env = baseEnv();
  await env.KEYS.put("willberevoked", JSON.stringify({ label: "Acme", tier: "starter", status: "active" }));
  const { postResp, clientId, redirectUri, verifier } = await doFullFlowWithApiKey(env, "willberevoked");
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");
  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  const tokens = await tokenResp.json();

  // The access token is still within its 24h TTL — only the underlying key is revoked.
  await env.KEYS.put("willberevoked", JSON.stringify({ label: "Acme", tier: "starter", status: "revoked" }));

  const mcpResp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(mcpResp.status, 401);
  assert.match(mcpResp.headers.get("www-authenticate") || "", /resource_metadata/);
});

test("refresh also fails once the underlying API key is revoked", async () => {
  const env = baseEnv();
  await env.KEYS.put("willberevoked2", JSON.stringify({ label: "Acme", tier: "starter", status: "active" }));
  const { postResp, clientId, redirectUri, verifier } = await doFullFlowWithApiKey(env, "willberevoked2");
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");
  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  const tokens = await tokenResp.json();

  await env.KEYS.put("willberevoked2", JSON.stringify({ label: "Acme", tier: "starter", status: "revoked" }));

  const refreshResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  }), env, {});
  assert.equal(refreshResp.status, 400);
  assert.equal((await refreshResp.json()).error, "invalid_grant");
});

// --------------------------------------------------------------------- signed-token tampering / expiry

test("a tampered access token (flipped signature byte) is rejected", async () => {
  const env = baseEnv();
  const c2 = await registerClient(env);
  const v2 = randomVerifier();
  const ch2 = await challengeFor(v2);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${c2}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=${ch2}&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const pr = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), env, {});
  const code = new URL(pr.headers.get("location")).searchParams.get("code");
  const tr = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: c2, code_verifier: v2 }),
  }), env, {});
  const { access_token } = await tr.json();

  const tampered = access_token.slice(0, -1) + (access_token.slice(-1) === "a" ? "b" : "a");
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tampered}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(resp.status, 401);
});

test("an expired access token is rejected", async () => {
  const env = baseEnv();
  const expired = await mintToken(SIGNING_KEY, ACCESS_PREFIX, { clientId: "hcid_x", mode: "free", label: "anonymous-oauth", tier: "free", scope: "mcp" }, -10);
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${expired}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(resp.status, 401);
});

test("mintToken/readToken round-trip and reject a wrong secret", async () => {
  const token = await mintToken(SIGNING_KEY, ACCESS_PREFIX, { foo: "bar" }, 60);
  const ok = await readToken(SIGNING_KEY, ACCESS_PREFIX, token);
  assert.equal(ok.foo, "bar");
  const bad = await readToken("wrong-secret", ACCESS_PREFIX, token);
  assert.equal(bad, null);
});

// --------------------------------------------------------------------- rate limiting

test("free-mode OAuth access token is rate-limited by IP, same as anonymous (429 when RL denies)", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), env, {});
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");
  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: clientId, code_verifier: verifier }),
  }), env, {});
  const { access_token } = await tokenResp.json();

  const deny = denyingLimiter();
  const limitedEnv = { ...env, RL: deny };
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), limitedEnv, {});
  assert.equal(resp.status, 429);
  assert.equal(deny.calls.length, 1, "must consult the IP-keyed limiter, not a per-token one");
});

test("apikey-mode OAuth access token shares its rate-limit bucket with the underlying API key (keyed by the key itself, not the token)", async () => {
  const env = baseEnv();
  await env.KEYS.put("ratelimitedkey", JSON.stringify({ label: "Acme", tier: "starter", status: "active" }));
  const { postResp, clientId, redirectUri, verifier } = await doFullFlowWithApiKey(env, "ratelimitedkey");
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");
  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  const { access_token } = await tokenResp.json();

  const deny = denyingLimiter();
  const limitedEnv = { ...env, RL_STARTER: deny };
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), limitedEnv, {});
  assert.equal(resp.status, 429);
  assert.equal(deny.calls[0].key, "ratelimitedkey", "must rate-limit by the underlying key, not the OAuth token, so both share one bucket");
});

test("minting many free-mode OAuth tokens does not bypass the anonymous per-IP limit (same bucket)", async () => {
  const env = baseEnv();
  const deny = denyingLimiter();
  const limitedEnv = { ...env, RL: deny };
  // Register two different clients/tokens (simulating a script minting many tokens) —
  // both must hit the SAME IP-keyed bucket, not their own.
  for (let i = 0; i < 2; i++) {
    const clientId = await registerClient(env, "https://claude.ai/api/mcp/auth_callback");
    const verifier = randomVerifier();
    const challenge = await challengeFor(verifier);
    const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
    const pending = extractPending(await getResp.text());
    const postResp = await worker.fetch(req("/authorize", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: pending, choice: "free" }),
    }), env, {});
    const code = new URL(postResp.headers.get("location")).searchParams.get("code");
    const tokenResp = await worker.fetch(req("/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: clientId, code_verifier: verifier }),
    }), env, {});
    const { access_token } = await tokenResp.json();
    const resp = await worker.fetch(req("/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
    }), limitedEnv, {});
    assert.equal(resp.status, 429, `token #${i} must be denied by the shared IP bucket`);
  }
});

// --------------------------------------------------------------------- consent page hardening

test("GET /authorize sends frame-busting headers", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const resp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  assert.equal(resp.headers.get("x-frame-options"), "DENY");
  assert.equal(resp.headers.get("content-security-policy"), "frame-ancestors 'none'");
});

test("consent page shows no trust warning for claude.ai but does for an untrusted redirect host", async () => {
  const env = baseEnv();
  const trustedClient = await registerClient(env, "https://claude.ai/api/mcp/auth_callback");
  const trustedResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${trustedClient}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  const trustedHtml = await trustedResp.text();
  assert.doesNotMatch(trustedHtml, /Only paste your API key if you trust/);

  const untrustedClient = await registerClient(env, "https://some-other-mcp-client.example.com/callback");
  const untrustedResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${untrustedClient}&redirect_uri=${encodeURIComponent("https://some-other-mcp-client.example.com/callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  const untrustedHtml = await untrustedResp.text();
  assert.match(untrustedHtml, /Only paste your API key if you trust some-other-mcp-client\.example\.com/);
});

test("consent page links privacy and research pages, not a nonexistent /terms", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const resp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  const html = await resp.text();
  assert.match(html, /hlaverify\.com\/privacy/);
  assert.match(html, /hlaverify\.com\/research/);
  assert.doesNotMatch(html, /hlaverify\.com\/terms/);
});

test("POST /authorize is rate-limited by IP", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=abc&code_challenge_method=S256`), env, {});
  const pending = extractPending(await getResp.text());
  const limitedEnv = { ...env, RL: denyingLimiter() };
  const resp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: pending, choice: "free" }),
  }), limitedEnv, {});
  assert.equal(resp.status, 429);
});

// --------------------------------------------------------------------- backward compatibility

test("an invalid OAuth access token gets a 401 with WWW-Authenticate", async () => {
  const env = baseEnv();
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hoat_not_a_real_token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(resp.status, 401);
  assert.match(resp.headers.get("www-authenticate") || "", /resource_metadata="https:\/\/assets\.local\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("anonymous /mcp (no credential at all) is completely unaffected by OAuth: still 200, still free tier", async () => {
  const env = baseEnv();
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-hla-verify-tier"), "free");
  assert.equal(resp.headers.get("www-authenticate"), null, "must not challenge anonymous callers by default");
});

test("legacy secret-configured API key on /mcp still works unchanged", async () => {
  const env = baseEnv();
  const resp = await worker.fetch(req("/mcp", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "secretkey123" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "about", arguments: {} } }),
  }), env, {});
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-hla-verify-tier"), "enterprise");
});
