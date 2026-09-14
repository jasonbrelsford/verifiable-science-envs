// OAuth 2.1 flow tests (docs/CLAUDE-CONNECTOR.md section 6): metadata endpoints, dynamic
// client registration, the full authorize -> consent -> code -> token exchange, PKCE
// failure, a wrong redirect_uri, refresh (including a revoked API key), and an MCP call
// authenticated with an OAuth access token. Uses a mock KV (same in-memory Map pattern as
// stripe.test.mjs's fakeKV) standing in for the OAUTH_KV binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createRequire } from "node:module";
import worker from "../src/index.js";

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

function baseEnv(extra = {}) {
  return {
    HLA_VERIFY_API_KEYS: "secretkey123=Curated:enterprise",
    KEYS: fakeKV(),
    OAUTH_KV: fakeKV(),
    ASSETS: assetsStub(),
    PUBLIC_ACCESS: "1",
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
  const body = await resp.json();
  assert.equal(body.resource, `${ORIGIN}/mcp`);
});

test("GET /.well-known/oauth-authorization-server advertises PKCE S256, DCR, and no CIMD", async () => {
  const resp = await worker.fetch(req("/.well-known/oauth-authorization-server"), baseEnv(), {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.issuer, ORIGIN);
  assert.equal(body.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(body.token_endpoint, `${ORIGIN}/token`);
  assert.equal(body.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(body.client_id_metadata_document_supported, undefined, "must not advertise CIMD support");
});

// --------------------------------------------------------------------- DCR

test("POST /register: valid redirect_uris issues a public client (no secret)", async () => {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }),
  }), baseEnv(), {});
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.ok(body.client_id.startsWith("hcid_"));
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(body.client_secret, undefined);
});

test("POST /register: rejects a non-https, non-loopback redirect_uri", async () => {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/callback"] }),
  }), baseEnv(), {});
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, "invalid_redirect_uri");
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
  const body = await resp.json();
  assert.equal(body.error, "invalid_client_metadata");
});

// --------------------------------------------------------------------- shared fixture: register a client

async function registerClient(env, redirectUri = "https://claude.ai/api/mcp/auth_callback") {
  const resp = await worker.fetch(req("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test Client" }),
  }), env, {});
  return (await resp.json()).client_id;
}

function extractCsrf(html) {
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
  const csrf = extractCsrf(pageHtml);
  assert.ok(csrf, "consent page must include a csrf token");

  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf, choice: "free" }),
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
  assert.equal(tokens.expires_in, 3600);

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
});

// --------------------------------------------------------------------- PKCE failure

test("PKCE failure: wrong code_verifier is rejected", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);

  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const csrf = extractCsrf(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf, choice: "free" }),
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
  const text = await resp.text();
  assert.match(text, /redirect_uri/);
});

test("token exchange rejects a redirect_uri that doesn't match the one used at /authorize", async () => {
  const env = baseEnv();
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const csrf = extractCsrf(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf, choice: "free" }),
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

async function doFullFlowWithApiKey(env, apiKey) {
  const clientId = await registerClient(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const getResp = await worker.fetch(req(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`), env, {});
  const csrf = extractCsrf(await getResp.text());
  const postResp = await worker.fetch(req("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf, choice: "apikey", api_key: apiKey }),
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

  // Old refresh token is now dead (single-use / rotated).
  const reuseOld = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  }), env, {});
  assert.equal(reuseOld.status, 400);
});

test("consent rejects a revoked API key before ever issuing a code", async () => {
  const env = baseEnv();
  await env.KEYS.put("revokedkey", JSON.stringify({ label: "Gone", tier: "starter", status: "revoked" }));
  const { postResp } = await doFullFlowWithApiKey(env, "revokedkey");
  assert.equal(postResp.status, 401);
  const bodyText = await postResp.text();
  assert.match(bodyText, /invalid or has been revoked/);
});

test("refresh fails once the underlying API key is revoked after the token was issued", async () => {
  const env = baseEnv();
  await env.KEYS.put("willberevoked", JSON.stringify({ label: "Acme", tier: "starter", status: "active" }));
  const { postResp, clientId, redirectUri, verifier } = await doFullFlowWithApiKey(env, "willberevoked");
  const code = new URL(postResp.headers.get("location")).searchParams.get("code");
  const tokenResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  }), env, {});
  const tokens = await tokenResp.json();

  // Revoke the underlying key after the OAuth token was minted.
  await env.KEYS.put("willberevoked", JSON.stringify({ label: "Acme", tier: "starter", status: "revoked" }));

  const refreshResp = await worker.fetch(req("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  }), env, {});
  assert.equal(refreshResp.status, 400);
  assert.equal((await refreshResp.json()).error, "invalid_grant");
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
