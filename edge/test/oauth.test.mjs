// OAuth sign-in for /mcp (src/oauth.js), driven end to end through index.js's
// real fetch handler with a fake KV, fake rate limiters and the disk-backed
// ASSETS stub stripe.test.mjs uses.
//
// 1. Inertness: with OAUTH_ENABLED unset (production today), or set without its
//    secret/KV, every new route 404s exactly like an unknown path, and /mcp and
//    /v1/* behave exactly as before — same status, headers and body — across
//    anonymous, X-API-Key, Bearer-key, invalid, revoked and rate-limited calls.
// 2. Flag on: metadata, DCR and CIMD clients, PKCE, consent with a real key,
//    token exchange, /mcp at the key's tier, refresh rotation.
// 3. Negative cases: PKCE, redirect_uri, code reuse/expiry, revoked key,
//    audience, tampering, CSRF, client binding, refresh-token reuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

const ASSETS = {
  async fetch(url) {
    const rel = new URL(url).pathname.replace(/^\/data\//, "");
    try {
      return new Response(await readFile(path.join(pub, "data", rel), "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e.code === "ENOENT") return new Response(null, { status: 404 });
      throw e;
    }
  },
};

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
    _store: store,
    _puts: puts,
  };
}

function fakeRL(allow = true) {
  const calls = [];
  return { async limit({ key }) { calls.push(key); return { success: typeof allow === "function" ? allow(key) : allow }; }, calls };
}

const PRO_KEY = "hlv_pro_test_key_0123456789abcdefghijklmnop";
const STARTER_KEY = "hlv_starter_test_key_0123456789abcdefghijk";
const REVOKED_KEY = "hlv_revoked_test_key_0123456789abcdefghijk";
const SECRET_KEY = "sk_enterprise_lab";
const TOKEN_SECRET = "test-oauth-token-secret-0123456789abcdef";

function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    HLA_VERIFY_API_KEYS: `${SECRET_KEY}=Lab:enterprise`,
    KEYS: fakeKV({
      [PRO_KEY]: JSON.stringify({ label: "pro@example.com", tier: "pro", status: "active" }),
      [STARTER_KEY]: JSON.stringify({ label: "starter@example.com", tier: "starter", status: "active" }),
      [REVOKED_KEY]: JSON.stringify({ label: "gone@example.com", tier: "pro", status: "revoked" }),
    }),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_PRO: fakeRL(),
    ASSETS,
    ...extra,
  };
}
const onEnv = (extra = {}) => baseEnv({ OAUTH_ENABLED: "1", OAUTH_TOKEN_SECRET: TOKEN_SECRET, ...extra });

const ORIGIN = "https://api.hlaverify.com";

async function call(env, method, p, { headers = {}, body, origin = ORIGIN } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return worker.fetch(new Request(origin + p, init), env, {});
}
async function snap(resp) {
  return { status: resp.status, headers: [...resp.headers.entries()].sort(), body: await resp.text() };
}

const mcpBody = (method = "tools/list", params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const MCP_JSON = { "content-type": "application/json" };

// ------------------------------------------------------------- 1. inertness

const NEW_ROUTES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/authorize/",
  "/oauth/token",
  "/oauth/register",
  "/oauth/anything",
];

// Every way the flag can be "not fully on": each must be indistinguishable from
// the same deployment with the OAuth variables simply absent.
const INERT_CONFIGS = {
  "flag unset": {},
  "flag 0": { OAUTH_ENABLED: "0", OAUTH_TOKEN_SECRET: TOKEN_SECRET },
  "flag true (not 1)": { OAUTH_ENABLED: "true", OAUTH_TOKEN_SECRET: TOKEN_SECRET },
  "flag 1, no secret": { OAUTH_ENABLED: "1" },
  "flag 1, short secret": { OAUTH_ENABLED: "1", OAUTH_TOKEN_SECRET: "too-short" },
  "flag 1, no KEYS binding": { OAUTH_ENABLED: "1", OAUTH_TOKEN_SECRET: TOKEN_SECRET, KEYS: undefined },
};
const INERT_ENVS = Object.fromEntries(Object.entries(INERT_CONFIGS).map(([k, extra]) => [k, (more = {}) => baseEnv({ ...extra, ...more })]));
// The matching flag-absent deployment: same bindings, no OAUTH_* variables.
const withoutOAuth = (name) => (more = {}) => {
  const { OAUTH_ENABLED, OAUTH_TOKEN_SECRET, ...rest } = INERT_CONFIGS[name];
  return baseEnv({ ...rest, ...more });
};

test("inert: new OAuth routes 404 exactly like an unknown path, for every not-fully-enabled config", async () => {
  for (const [name, mk] of Object.entries(INERT_ENVS)) {
    for (const method of ["GET", "POST"]) {
      const baseline = await snap(await call(withoutOAuth(name)(), method, "/no-such-route"));
      assert.equal(baseline.status, 404);
      assert.equal(baseline.body, '{"detail":"Not Found"}');
      for (const r of NEW_ROUTES) {
        const body = method === "POST" ? "grant_type=authorization_code" : undefined;
        const got = await snap(await call(mk(), method, r, { headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
        assert.deepEqual(got, baseline, `${name}: ${method} ${r}`);
      }
    }
  }
});

// Requests touching every authorization branch. Each env factory gets a fresh KV
// and limiters so the comparison is like-for-like.
function authMatrix() {
  const allele = "/v1/allele/A%2A01%3A01";
  return [
    ["anon mcp", "POST", "/mcp", { headers: MCP_JSON, body: mcpBody() }],
    ["anon mcp tools/call", "POST", "/mcp", { headers: MCP_JSON, body: mcpBody("tools/call", { name: "verify_text", arguments: { text: "A*0101" } }) }],
    ["x-api-key kv pro mcp", "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": PRO_KEY }, body: mcpBody() }],
    ["bearer kv starter mcp", "POST", "/mcp", { headers: { ...MCP_JSON, authorization: `Bearer ${STARTER_KEY}` }, body: mcpBody() }],
    ["bearer secret key mcp", "POST", "/mcp", { headers: { ...MCP_JSON, authorization: `bearer ${SECRET_KEY}` }, body: mcpBody() }],
    ["invalid key mcp", "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": "nope" }, body: mcpBody() }],
    ["invalid bearer mcp", "POST", "/mcp", { headers: { ...MCP_JSON, authorization: "Bearer nope" }, body: mcpBody() }],
    ["hlvat-shaped bearer mcp", "POST", "/mcp", { headers: { ...MCP_JSON, authorization: "Bearer hlvat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, body: mcpBody() }],
    ["revoked key mcp", "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": REVOKED_KEY }, body: mcpBody() }],
    ["GET mcp", "GET", "/mcp", {}],
    ["PUT mcp", "PUT", "/mcp", {}],
    ["OPTIONS mcp", "OPTIONS", "/mcp", {}],
    ["OPTIONS oauth token", "OPTIONS", "/oauth/token", {}],
    ["anon v1", "GET", allele, {}],
    ["x-api-key v1", "GET", allele, { headers: { "x-api-key": PRO_KEY } }],
    ["bearer v1", "GET", allele, { headers: { authorization: `Bearer ${STARTER_KEY}` } }],
    ["invalid v1", "GET", allele, { headers: { "x-api-key": "nope" } }],
    ["revoked v1", "GET", allele, { headers: { "x-api-key": REVOKED_KEY } }],
    ["healthz", "GET", "/healthz", {}],
    ["openapi", "GET", "/openapi.json", {}],
    ["unknown well-known", "GET", "/.well-known/security.txt", {}],
  ];
}

const dropUptime = (s) => ({ ...s, body: s.body.replace(/"uptime_s":\d+/, '"uptime_s":0') });

async function runMatrix(mkEnv) {
  const out = {};
  for (const [name, method, p, opts] of authMatrix()) out[name] = dropUptime(await snap(await call(mkEnv(), method, p, opts)));
  return out;
}

test("inert: /mcp and /v1 auth paths are identical with the flag unset or any partial config", async () => {
  const baseline = await runMatrix(INERT_ENVS["flag unset"]);
  // Sanity-check the baseline is the behaviour production has today.
  assert.equal(baseline["anon mcp"].status, 200);
  assert.ok(baseline["x-api-key kv pro mcp"].headers.some(([k, v]) => k === "x-hla-verify-tier" && v === "pro"));
  assert.ok(baseline["bearer kv starter mcp"].headers.some(([k, v]) => k === "x-hla-verify-tier" && v === "starter"));
  assert.ok(baseline["bearer secret key mcp"].headers.some(([k, v]) => k === "x-hla-verify-tier" && v === "enterprise"));
  for (const k of ["invalid key mcp", "invalid bearer mcp", "hlvat-shaped bearer mcp", "invalid v1"]) {
    assert.equal(baseline[k].status, 401, k);
    assert.equal(baseline[k].body, '{"detail":"missing or invalid X-API-Key"}', k);
    assert.deepEqual(baseline[k].headers.map(([h]) => h), ["access-control-allow-headers", "access-control-allow-methods",
      "access-control-allow-origin", "access-control-max-age", "cache-control", "content-type", "x-hla-verify-release"], k);
  }
  assert.equal(baseline["revoked key mcp"].body, '{"detail":"API key revoked"}');
  assert.equal(baseline["OPTIONS oauth token"].status, 204);
  for (const [name, mk] of Object.entries(INERT_ENVS)) assert.deepEqual(await runMatrix(mk), await runMatrix(withoutOAuth(name)), name);
});

test("inert: 401 (PUBLIC_ACCESS=0) and 429 (anonymous and keyed) responses are unchanged", async () => {
  const cases = [
    ["closed anon", { PUBLIC_ACCESS: "0" }, {}],
    ["anon limited", { RL: fakeRL(false) }, {}],
    ["pro limited", { RL_PRO: fakeRL(false) }, { "x-api-key": PRO_KEY }],
  ];
  for (const [name, extra, headers] of cases) {
    for (const [iname, mk] of Object.entries(INERT_ENVS)) {
      const off = await snap(await call(withoutOAuth(iname)(extra), "POST", "/mcp", { headers: { ...MCP_JSON, ...headers }, body: mcpBody() }));
      const got = await snap(await call(mk(extra), "POST", "/mcp", { headers: { ...MCP_JSON, ...headers }, body: mcpBody() }));
      assert.deepEqual(got, off, `${name} / ${iname}`);
      assert.ok(!got.headers.some(([k]) => k === "www-authenticate"), name);
    }
    const off = await snap(await call(baseEnv(extra), "POST", "/mcp", { headers: { ...MCP_JSON, ...headers }, body: mcpBody() }));
    assert.equal(off.status, name === "closed anon" ? 401 : 429, name);
    assert.ok(!off.headers.some(([k]) => k === "www-authenticate"), name);
  }
});

test("inert: a genuine OAuth access token is just an unknown key when the flag is off", async () => {
  const { tokens } = await fullFlow(onEnv(), PRO_KEY);
  const off = await call(baseEnv(), "POST", "/mcp", { headers: { ...MCP_JSON, authorization: `Bearer ${tokens.access_token}` }, body: mcpBody() });
  assert.equal(off.status, 401);
  assert.equal(await off.text(), '{"detail":"missing or invalid X-API-Key"}');
  assert.equal(off.headers.get("www-authenticate"), null);
});

test("flag on: everything outside /mcp 401s and the new routes is unchanged", async () => {
  const off = await runMatrix(INERT_ENVS["flag unset"]);
  const on = await runMatrix(onEnv);
  for (const name of Object.keys(off)) {
    if (["invalid key mcp", "invalid bearer mcp", "hlvat-shaped bearer mcp", "revoked key mcp"].includes(name)) continue;
    assert.deepEqual(on[name], off[name], name);
  }
});

// ------------------------------------------------------------ 2. flag on

async function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  return { verifier, challenge };
}

async function registerClient(env, redirect_uris = ["https://client.example/callback"], extra = {}) {
  const resp = await call(env, "POST", "/oauth/register", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris, client_name: "Test Agent", token_endpoint_auth_method: "none", ...extra }) });
  assert.equal(resp.status, 201);
  return resp.json();
}

function authorizeUrl(params) {
  return "/oauth/authorize?" + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
}

async function openConsent(env, params, opts = {}) {
  const resp = await call(env, "GET", authorizeUrl({ response_type: "code", code_challenge_method: "S256", resource: `${ORIGIN}/mcp`, state: "st-123", ...params }), opts);
  const html = await resp.text();
  const blob = (html.match(/name="request" value="([^"]+)"/) || [])[1];
  const cookie = (resp.headers.get("set-cookie") || "").split(";")[0];
  return { resp, html, blob, cookie };
}

async function submitConsent(env, blob, cookie, apiKey, { action = "approve", headers = {} } = {}) {
  return call(env, "POST", "/oauth/authorize", {
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers },
    body: new URLSearchParams({ request: blob, api_key: apiKey, action }).toString(),
  });
}

async function tokenRequest(env, form) {
  const resp = await call(env, "POST", "/oauth/token", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: resp.status, json: await resp.json(), resp };
}

async function fullFlow(env, apiKey, { redirect = "https://client.example/callback" } = {}) {
  const client = await registerClient(env, [redirect]);
  const { verifier, challenge } = await pkce();
  const { blob, cookie } = await openConsent(env, { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge });
  const approved = await submitConsent(env, blob, cookie, apiKey);
  assert.equal(approved.status, 303);
  const loc = new URL(approved.headers.get("location"));
  const code = loc.searchParams.get("code");
  const t = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  return { client, verifier, code, redirect, tokens: t.json, location: loc };
}

const mcpWith = (env, token, body = mcpBody()) =>
  call(env, "POST", "/mcp", { headers: { ...MCP_JSON, authorization: `Bearer ${token}` }, body });

test("flag on: protected resource metadata (both well-known paths) and authorization server metadata", async () => {
  const env = onEnv();
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await call(env, "GET", p);
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(m.authorization_servers, [ORIGIN]);
    assert.deepEqual(m.bearer_methods_supported, ["header"]);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  }
  const as = await (await call(env, "GET", "/.well-known/oauth-authorization-server")).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  // http is reported as https except on loopback
  assert.equal((await (await call(env, "GET", "/.well-known/oauth-authorization-server", { origin: "http://api.hlaverify.com" })).json()).issuer, ORIGIN);
  assert.equal((await (await call(env, "GET", "/.well-known/oauth-authorization-server", { origin: "http://127.0.0.1:8796" })).json()).issuer, "http://127.0.0.1:8796");
  assert.equal((await call(env, "POST", "/.well-known/oauth-authorization-server")).status, 405);
  assert.equal((await call(env, "GET", "/oauth/unknown")).status, 404);
});

test("flag on: /mcp 401s carry the RFC 9728 challenge; anonymous access is unchanged", async () => {
  const env = onEnv();
  const bad = await call(env, "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": "nope" }, body: mcpBody() });
  assert.equal(bad.status, 401);
  assert.equal(await bad.text(), '{"detail":"missing or invalid X-API-Key"}');
  assert.equal(bad.headers.get("www-authenticate"), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
  assert.equal(bad.headers.get("access-control-expose-headers"), "www-authenticate");
  const closed = await call(onEnv({ PUBLIC_ACCESS: "0" }), "POST", "/mcp", { headers: MCP_JSON, body: mcpBody() });
  assert.equal(closed.status, 401);
  assert.match(closed.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal((await call(env, "POST", "/mcp", { headers: MCP_JSON, body: mcpBody() })).status, 200);
});

test("flag on: DCR client, PKCE, consent with a KV key, token exchange, /mcp at the key's tier", async () => {
  const env = onEnv();
  const { tokens, location, client } = await fullFlow(env, PRO_KEY);
  assert.equal(location.origin + location.pathname, "https://client.example/callback");
  assert.equal(location.searchParams.get("state"), "st-123");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "mcp");
  assert.ok(tokens.access_token.startsWith("hlvat_") && tokens.refresh_token.startsWith("hlvrt_"));
  // The client never sees the key: not in the client_id, code, or tokens.
  for (const v of [client.client_id, location.href, tokens.access_token, tokens.refresh_token]) assert.ok(!v.includes(PRO_KEY));

  env.RL_PRO.calls.length = 0;
  const r = await mcpWith(env, tokens.access_token, mcpBody("tools/call", { name: "verify_text", arguments: { text: "A*0101 DQB1*05:03:26:99" } }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-hla-verify-tier"), "pro");
  const j = await r.json();
  assert.equal(j.result.isError, false);
  assert.deepEqual(env.RL_PRO.calls, [PRO_KEY], "token usage counts against the key's own rate limit");

  // The same call with the raw key produces the same result body.
  const direct = await call(env, "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": PRO_KEY }, body: mcpBody("tools/call", { name: "verify_text", arguments: { text: "A*0101 DQB1*05:03:26:99" } }) });
  assert.deepEqual(await direct.json(), j);
});

test("flag on: a secret-list key yields its tier; a rate-limited key's token gets the same 429", async () => {
  const env = onEnv();
  const { tokens } = await fullFlow(env, SECRET_KEY);
  const r = await mcpWith(env, tokens.access_token);
  assert.equal(r.headers.get("x-hla-verify-tier"), "enterprise");

  const env2 = onEnv({ RL_STARTER: fakeRL(false) });
  const { tokens: t2 } = await fullFlow(env2, STARTER_KEY);
  const limited = await mcpWith(env2, t2.access_token);
  const viaKey = await call(env2, "POST", "/mcp", { headers: { ...MCP_JSON, "x-api-key": STARTER_KEY }, body: mcpBody() });
  assert.deepEqual(await snap(limited), await snap(viaKey));
  assert.equal(limited.status, 429);
});

test("flag on: Client ID Metadata Document client (stubbed fetch)", async () => {
  const env = onEnv();
  const clientId = "https://agent.example.com/oauth/client.json";
  const redirect = "https://agent.example.com/callback";
  let doc = { client_id: clientId, client_name: "Example Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" };
  let status = 200;
  const fetched = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { fetched.push({ u: String(u), init }); return new Response(JSON.stringify(doc), { status, headers: status === 302 ? { location: "https://evil.example/" } : {} }); };
  try {
    const { verifier, challenge } = await pkce();
    const { resp, html, blob, cookie } = await openConsent(env, { client_id: clientId, redirect_uri: redirect, code_challenge: challenge });
    assert.equal(resp.status, 200);
    assert.equal(fetched[0].u, clientId);
    assert.equal(fetched[0].init.redirect, "manual");
    assert.match(html, /Example Agent/);
    assert.match(html, /agent\.example\.com/);
    assert.equal(resp.headers.get("x-frame-options"), "DENY");
    assert.match(resp.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(resp.headers.get("set-cookie"), /^__Host-hlv_oauth=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    const ok = await submitConsent(env, blob, cookie, PRO_KEY);
    const code = new URL(ok.headers.get("location")).searchParams.get("code");
    const t = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
    assert.equal(t.status, 200);
    assert.equal(fetched.length, 1, "the token endpoint does not refetch the document");

    // Negative document cases: each is an error page, never a redirect.
    const bad = [
      [{ ...doc, client_id: "https://agent.example.com/other.json" }, 200],
      [{ ...doc, redirect_uris: ["https://elsewhere.example/cb"] }, 200],
      [{ ...doc, token_endpoint_auth_method: "client_secret_basic" }, 200],
      [{ ...doc, client_name: undefined }, 200],
      [doc, 302],
      [doc, 404],
    ];
    for (const [d, s] of bad) {
      doc = d; status = s;
      const r = await openConsent(env, { client_id: clientId, redirect_uri: redirect, code_challenge: challenge });
      assert.equal(r.resp.status, 400, JSON.stringify([d, s]));
      assert.equal(r.resp.headers.get("location"), null);
    }
    doc = "x".repeat(20000); status = 200;
    assert.equal((await openConsent(env, { client_id: clientId, redirect_uri: redirect, code_challenge: challenge })).resp.status, 400);

    // SSRF guard: these client_ids are refused without any fetch.
    fetched.length = 0;
    for (const id of ["http://agent.example.com/c.json", "https://127.0.0.1/c.json", "https://[::1]/c.json", "https://localhost/c.json",
      "https://agent.example.com:8443/c.json", "https://agent.example.com/", "https://user:pw@agent.example.com/c.json",
      "https://api.hlaverify.com/c.json", "https://intranet/c.json", "https://AGENT.example.com/c.json"]) {
      const r = await openConsent(env, { client_id: id, redirect_uri: redirect, code_challenge: challenge });
      assert.equal(r.resp.status, 400, id);
    }
    assert.equal(fetched.length, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("flag on: refresh token rotation; reuse revokes the whole family", async () => {
  const env = onEnv();
  const { tokens, client } = await fullFlow(env, PRO_KEY);
  const r1 = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refresh_token, tokens.refresh_token);
  assert.equal((await mcpWith(env, r1.json.access_token)).status, 200);
  // replaying the rotated-out token fails and kills its successor too
  const replay = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "invalid_grant");
  const next = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: client.client_id });
  assert.equal(next.json.error, "invalid_grant");
  // markers carry TTLs and are not JSON, so authorize() can never read one as a key record
  for (const { k, v, opts } of env.KEYS._puts) {
    assert.ok(k.startsWith("oauth/"), k);
    assert.ok(opts && opts.expirationTtl >= 60, k);
    assert.throws(() => JSON.parse(v));
  }
});

test("flag on: loopback redirect URIs may change port (127.0.0.1), nothing else may", async () => {
  const env = onEnv();
  const client = await registerClient(env, ["http://127.0.0.1:3000/callback", "http://localhost:4000/cb"]);
  const { challenge } = await pkce();
  const ok = await openConsent(env, { client_id: client.client_id, redirect_uri: "http://127.0.0.1:51234/callback", code_challenge: challenge });
  assert.equal(ok.resp.status, 200);
  assert.match(ok.html, /your own computer/);
  for (const ru of ["http://127.0.0.1:51234/other", "http://localhost:4001/cb", "http://127.0.0.1:3000/callback?x=1", "https://127.0.0.1:3000/callback"]) {
    const r = await openConsent(env, { client_id: client.client_id, redirect_uri: ru, code_challenge: challenge });
    assert.equal(r.resp.status, 400, ru);
    assert.equal(r.resp.headers.get("location"), null, ru);
  }
});

// ---------------------------------------------------------- 3. negatives

test("negative: registration rejects unsafe redirect URIs", async () => {
  const env = onEnv();
  for (const ru of [[], ["javascript:alert(1)"], ["http://client.example/cb"], ["https://client.example/cb#frag"], ["myapp://cb"],
    ["https://u:p@client.example/cb"], ["https://client.example/" + "a".repeat(600)], Array(6).fill("https://client.example/cb"), "https://client.example/cb"]) {
    const r = await call(env, "POST", "/oauth/register", { headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ru }) });
    assert.equal(r.status, 400, JSON.stringify(ru));
  }
  // any requested auth method is downgraded to a public client
  const c = await registerClient(env, ["https://client.example/cb"], { token_endpoint_auth_method: "client_secret_post" });
  assert.equal(c.token_endpoint_auth_method, "none");
  assert.equal(c.client_secret, undefined);
});

test("negative: authorize never redirects to an unregistered or forged target", async () => {
  const env = onEnv();
  const client = await registerClient(env);
  const { challenge } = await pkce();
  const cases = [
    { client_id: client.client_id, redirect_uri: "https://evil.example/callback" },
    { client_id: client.client_id, redirect_uri: "https://client.example/callback/../evil" },
    { client_id: client.client_id },
    { client_id: client.client_id.slice(0, -2) + "AA", redirect_uri: "https://client.example/callback" },
    { client_id: "some-random-id", redirect_uri: "https://client.example/callback" },
    { redirect_uri: "https://client.example/callback" },
  ];
  for (const c of cases) {
    const r = await openConsent(env, { ...c, code_challenge: challenge });
    assert.equal(r.resp.status, 400, JSON.stringify(c));
    assert.equal(r.resp.headers.get("location"), null);
    assert.equal(r.blob, undefined);
  }
  // duplicated parameters are refused before anything else
  const dup = await call(env, "GET", `/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&redirect_uri=https%3A%2F%2Fevil.example%2F&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`);
  assert.equal(dup.status, 400);
  assert.equal(dup.headers.get("location"), null);
});

test("negative: PKCE is mandatory (S256 only), resource must be this server's /mcp, and no error auto-redirects", async () => {
  const env = onEnv();
  const client = await registerClient(env);
  const { challenge } = await pkce();
  const base = { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge };
  // Errors before consent are shown to the user, never auto-redirected: every
  // client is self-registered, so its redirect_uri is attacker-choosable.
  const expectErr = async (params, error) => {
    const r = await openConsent(env, { ...base, ...params });
    assert.equal(r.resp.status, 400, JSON.stringify(params));
    assert.equal(r.resp.headers.get("location"), null);
    assert.equal(r.blob, undefined);
    assert.match(r.html, new RegExp(`\\(${error}\\)`));
  };
  await expectErr({ code_challenge_method: "plain" }, "invalid_request");
  await expectErr({ code_challenge: undefined }, "invalid_request");
  await expectErr({ code_challenge: "short" }, "invalid_request");
  await expectErr({ response_type: "token" }, "unsupported_response_type");
  await expectErr({ resource: "https://other.example/mcp" }, "invalid_target");
  await expectErr({ resource: `${ORIGIN}/v1` }, "invalid_target");
  await expectErr({ resource: `${ORIGIN}/mcp#x` }, "invalid_target");
  // bare origin and upper-case host are accepted and narrowed to /mcp
  assert.equal((await openConsent(env, { ...base, resource: ORIGIN })).resp.status, 200);
  assert.equal((await openConsent(env, { ...base, resource: "HTTPS://API.HLAVERIFY.COM/mcp" })).resp.status, 200);
  assert.equal((await openConsent(env, { ...base, resource: undefined })).resp.status, 200);
});

async function codeFor(env, apiKey = PRO_KEY) {
  const client = await registerClient(env);
  const { verifier, challenge } = await pkce();
  const { blob, cookie } = await openConsent(env, { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge });
  const resp = await submitConsent(env, blob, cookie, apiKey);
  const code = new URL(resp.headers.get("location")).searchParams.get("code");
  const form = { grant_type: "authorization_code", code, redirect_uri: "https://client.example/callback", client_id: client.client_id, code_verifier: verifier };
  return { client, verifier, code, form };
}

test("negative: bad PKCE verifier, wrong redirect_uri, other client, wrong resource", async () => {
  const env = onEnv();
  const { form } = await codeFor(env);
  const other = await registerClient(env);
  const wrongVerifier = (await pkce()).verifier;
  for (const [change, error] of [
    [{ code_verifier: wrongVerifier }, "invalid_grant"],
    [{ code_verifier: undefined }, "invalid_grant"],
    [{ code_verifier: "a".repeat(42) }, "invalid_grant"],
    [{ redirect_uri: "https://client.example/other" }, "invalid_grant"],
    [{ redirect_uri: undefined }, "invalid_grant"],
    [{ client_id: other.client_id }, "invalid_grant"],
    [{ client_id: undefined }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
    [{ grant_type: "password" }, "unsupported_grant_type"],
    [{ code: form.code.slice(0, -1) + (form.code.endsWith("A") ? "B" : "A") }, "invalid_grant"],
  ]) {
    const f = Object.fromEntries(Object.entries({ ...form, ...change }).filter(([, v]) => v !== undefined));
    const r = await tokenRequest(env, f);
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.equal(r.json.error, error, JSON.stringify(change));
    assert.equal(r.resp.headers.get("cache-control"), "no-store");
  }
  // none of the failures above consumed the code
  assert.equal((await tokenRequest(env, form)).status, 200);
});

test("negative: a code is single-use and expires", async () => {
  const env = onEnv();
  const { form } = await codeFor(env);
  assert.equal((await tokenRequest(env, form)).status, 200);
  const again = await tokenRequest(env, form);
  assert.equal(again.status, 400);
  assert.equal(again.json.error, "invalid_grant");

  const { form: form2 } = await codeFor(env);
  const realNow = Date.now;
  Date.now = () => realNow() + 121_000;
  try {
    const late = await tokenRequest(env, form2);
    assert.equal(late.json.error, "invalid_grant");
  } finally {
    Date.now = realNow;
  }
});

test("negative: revoking the key after issuance stops the access token and the refresh token", async () => {
  const env = onEnv();
  const { tokens, client } = await fullFlow(env, STARTER_KEY);
  assert.equal((await mcpWith(env, tokens.access_token)).status, 200);
  env.KEYS._store.set(STARTER_KEY, JSON.stringify({ label: "starter@example.com", tier: "starter", status: "revoked" }));
  const r = await mcpWith(env, tokens.access_token);
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata="https:\/\/api\.hlaverify\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  const refresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refresh.json.error, "invalid_grant");

  // a code whose key is revoked before exchange is refused too
  const env2 = onEnv();
  const { form } = await codeFor(env2, PRO_KEY);
  env2.KEYS._store.set(PRO_KEY, JSON.stringify({ tier: "pro", status: "revoked" }));
  assert.equal((await tokenRequest(env2, form)).json.error, "invalid_grant");
});

test("negative: wrong audience, tampered, expired, wrong secret, wrong token type, and use on /v1", async () => {
  const env = onEnv();
  const { tokens } = await fullFlow(env, PRO_KEY);
  const invalid = async (resp, label) => {
    assert.equal(resp.status, 401, label);
    assert.match(resp.headers.get("www-authenticate") || "", /resource_metadata=/, label);
  };
  // minted for api.hlaverify.com, presented to another host served by the same Worker
  await invalid(await call(env, "POST", "/mcp", { origin: "https://hlaverify-api.example.workers.dev", headers: { ...MCP_JSON, authorization: `Bearer ${tokens.access_token}` }, body: mcpBody() }), "audience");
  const at = tokens.access_token;
  const mid = 30;
  await invalid(await mcpWith(env, at.slice(0, mid) + (at[mid] === "A" ? "B" : "A") + at.slice(mid + 1)), "tampered");
  await invalid(await mcpWith(env, at.slice(0, -4)), "truncated");
  await invalid(await mcpWith(env, "hlvat_!!!!"), "garbage");
  await invalid(await mcpWith(onEnv({ OAUTH_TOKEN_SECRET: "a-different-secret-0123456789abcdefghij" }), at), "rotated secret");
  await invalid(await mcpWith(env, "hlvat_" + tokens.refresh_token.slice("hlvrt_".length)), "refresh token relabelled as access token");
  await invalid(await mcpWith(env, tokens.refresh_token), "refresh token as bearer");
  const realNow = Date.now;
  Date.now = () => realNow() + 3601_000;
  try {
    await invalid(await mcpWith(env, at), "expired");
  } finally {
    Date.now = realNow;
  }
  // the token is scoped to /mcp; /v1 treats it as an unknown key
  const v1 = await call(env, "GET", "/v1/allele/A%2A01%3A01", { headers: { authorization: `Bearer ${at}` } });
  assert.equal(v1.status, 401);
  assert.equal(await v1.text(), '{"detail":"missing or invalid X-API-Key"}');
});

test("negative: consent form CSRF, invalid keys, deny, and rate limiting", async () => {
  const env = onEnv();
  const client = await registerClient(env);
  const { challenge } = await pkce();
  const { blob, cookie } = await openConsent(env, { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge });

  assert.equal((await submitConsent(env, blob, "", PRO_KEY)).status, 403, "no cookie");
  assert.equal((await submitConsent(env, blob, "__Host-hlv_oauth=forged", PRO_KEY)).status, 403, "wrong cookie");
  assert.equal((await submitConsent(env, blob, cookie, PRO_KEY, { headers: { origin: "https://evil.example" } })).status, 403, "cross-origin");
  assert.equal((await submitConsent(env, blob, cookie, PRO_KEY, { headers: { origin: "null" } })).status, 403, "opaque origin");
  assert.equal((await submitConsent(env, blob, cookie, PRO_KEY, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "sec-fetch-site");
  const other = await openConsent(env, { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge });
  assert.equal((await submitConsent(env, blob, other.cookie, PRO_KEY)).status, 403, "cookie from another consent page");
  assert.equal((await submitConsent(env, blob.slice(0, -2) + "AA", cookie, PRO_KEY)).status, 400, "tampered request");

  // unknown and revoked keys get the same answer and no redirect
  const unknown = await submitConsent(env, blob, cookie, "hlv_not_a_real_key");
  const revoked = await submitConsent(env, blob, cookie, REVOKED_KEY);
  const tokenAsKey = await submitConsent(env, blob, cookie, (await fullFlow(onEnv(), PRO_KEY)).tokens.access_token);
  for (const r of [unknown, revoked, tokenAsKey]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("location"), null);
    assert.match(await r.text(), /not valid or is no longer active/);
  }
  // an HTML-injection attempt in the key field is escaped, never reflected raw
  assert.doesNotMatch(await (await submitConsent(env, blob, cookie, "<script>x</script>")).text(), /<script>x/);

  const deny = await submitConsent(env, blob, cookie, "", { action: "deny" });
  assert.equal(deny.status, 303);
  const loc = new URL(deny.headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("iss"), ORIGIN);
  assert.equal(loc.searchParams.get("code"), null);

  const realNow = Date.now;
  Date.now = () => realNow() + 601_000;
  try {
    assert.equal((await submitConsent(env, blob, cookie, PRO_KEY)).status, 400, "expired consent request");
  } finally {
    Date.now = realNow;
  }

  const limited = onEnv({ RL: fakeRL((k) => !k.startsWith("oauth:")) });
  assert.equal((await openConsent(limited, { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge })).resp.status, 429);
  assert.equal((await submitConsent(limited, blob, cookie, PRO_KEY)).status, 429);
});

test("negative: client-supplied names are HTML-escaped on the consent page", async () => {
  const env = onEnv();
  const client = await registerClient(env, ["https://client.example/callback"], { client_name: '<img src=x onerror="alert(1)">' });
  const { challenge } = await pkce();
  const { html } = await openConsent(env, { client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge, state: '"><script>' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("negative: reusing a code revokes the refresh tokens issued from it", async () => {
  const env = onEnv();
  const { form, client } = await codeFor(env);
  const first = await tokenRequest(env, form);
  assert.equal(first.status, 200);
  assert.equal((await tokenRequest(env, form)).json.error, "invalid_grant");
  const refresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: first.json.refresh_token, client_id: client.client_id });
  assert.equal(refresh.json.error, "invalid_grant");
});

test("negative: KV failures fail closed with 503, never a Worker exception or a token", async () => {
  const env = onEnv();
  const { form } = await codeFor(env);
  env.KEYS.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
  const r = await tokenRequest(env, form);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "temporarily_unavailable");
  assert.equal(r.json.access_token, undefined);
});
