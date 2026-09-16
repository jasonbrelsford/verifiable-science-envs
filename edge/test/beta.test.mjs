// POST /v1/beta-signup and the matching beta_signup MCP tool, driven end to end
// through index.js's real fetch handler with a fake KV, fake rate limiters and
// the disk-backed ASSETS stub the other worker tests use.
//
// 1. The contract the website's /beta form depends on: 200 recorded /
//    already_recorded, {"detail": ...} on 400/405/415/422/429, CORS preflight.
// 2. The record: only what was submitted plus a timestamp and cf-ipcountry —
//    never the IP, never a header dump — under a "beta/" prefix in KEYS.
// 3. Containment: a "beta/" record must never authenticate as an API key, and
//    no pre-existing route may behave differently now that the prefix shares
//    the key namespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { BETA_PREFIX, MAX_EMAIL, MAX_ORG, MAX_USE_CASE, MAX_SOURCE } from "../src/handlers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const manifest = JSON.parse(await readFile(path.join(pub, "manifest.json"), "utf8"));

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
const SECRET_KEY = "sk_enterprise_lab";

function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    HLA_VERIFY_API_KEYS: `${SECRET_KEY}=Lab:enterprise`,
    KEYS: fakeKV({ [PRO_KEY]: JSON.stringify({ label: "pro@example.com", tier: "pro", status: "active" }) }),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_PRO: fakeRL(),
    ASSETS,
    ...extra,
  };
}

const ORIGIN = "https://api.hlaverify.com";
const IP = "203.0.113.7";

// Every signup call carries the CF headers a real request would, so the "we
// stored no IP" assertions below mean something.
async function call(env, method, p, { headers = {}, body, ip = IP, country = "US" } = {}) {
  const h = { "cf-connecting-ip": ip, ...headers };
  if (country !== null) h["cf-ipcountry"] = country;
  const init = { method, headers: h };
  if (body !== undefined) init.body = body;
  return worker.fetch(new Request(ORIGIN + p, init), env, {});
}
async function signup(env, payload, { headers = {}, ...opts } = {}) {
  const resp = await call(env, "POST", "/v1/beta-signup", {
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...opts,
  });
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}

const betaRecords = (env) => [...env.KEYS._store.keys()].filter((k) => k.startsWith(BETA_PREFIX));

// ------------------------------------------------------------- happy path

test("happy path: records the signup and answers the documented shape", async () => {
  const env = baseEnv();
  const { status, headers, json } = await signup(env,
    { email: "Jo@Lab.Example", org: "Example HLA Lab", use_case: "LIMS ingest QC", source: "site" });

  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.equal(headers.get("x-hla-verify-release"), manifest.release);
  assert.equal(headers.get("x-hla-verify-tier"), "free");
  assert.deepEqual(Object.keys(json).sort(), ["message", "ok", "release", "status"]);
  assert.equal(json.ok, true);
  assert.equal(json.status, "recorded");
  assert.equal(json.release, manifest.release);
  assert.match(json.message, /free public beta/i);
  assert.match(json.message, /hello@hlaverify\.com/);

  // Keyed on the lowercased address, under the beta/ prefix, nowhere else.
  assert.deepEqual(betaRecords(env), [`${BETA_PREFIX}jo@lab.example`]);
  const rec = JSON.parse(env.KEYS._store.get(`${BETA_PREFIX}jo@lab.example`));
  assert.deepEqual(Object.keys(rec).sort(), ["country", "email", "org", "source", "ts", "use_case"]);
  assert.equal(rec.email, "Jo@Lab.Example");   // as typed; only the KV key is lowercased
  assert.equal(rec.org, "Example HLA Lab");
  assert.equal(rec.use_case, "LIMS ingest QC");
  assert.equal(rec.source, "site");
  assert.equal(rec.country, "US");
  assert.ok(Date.parse(rec.ts) > 0);
  // No IP address, and nothing else personal, anywhere in the stored record.
  assert.equal(JSON.stringify(rec).includes(IP), false);
});

test("optional fields absent: stored as null, not invented", async () => {
  const env = baseEnv();
  const { status, json } = await signup(env, { email: " someone@example.org " }, { country: null });
  assert.equal(status, 200);
  assert.equal(json.status, "recorded");
  const rec = JSON.parse(env.KEYS._store.get(`${BETA_PREFIX}someone@example.org`));
  assert.equal(rec.email, "someone@example.org");  // trimmed
  assert.deepEqual([rec.org, rec.use_case, rec.source, rec.country], [null, null, null, null]);
});

test("duplicate email: already_recorded, one record, first submission preserved", async () => {
  const env = baseEnv();
  const first = await signup(env, { email: "dup@example.org", org: "First Lab" });
  assert.equal(first.json.status, "recorded");

  const again = await signup(env, { email: "DUP@Example.ORG", org: "Second Lab" });
  assert.equal(again.status, 200);
  assert.equal(again.json.ok, true);
  assert.equal(again.json.status, "already_recorded");
  assert.match(again.json.message, /already on the beta list/i);
  assert.equal(again.json.release, manifest.release);

  assert.deepEqual(betaRecords(env), [`${BETA_PREFIX}dup@example.org`]);
  assert.equal(env.KEYS._puts.filter((p) => p.k.startsWith(BETA_PREFIX)).length, 1);
  assert.equal(JSON.parse(env.KEYS._store.get(`${BETA_PREFIX}dup@example.org`)).org, "First Lab");
});

// -------------------------------------------------------------- rejections

test("422: an address that does not look like one", async () => {
  const env = baseEnv();
  for (const email of ["", "   ", "nope", "no-at-sign.example.com", "two@@example.com", "a@b",
    "a@example.com, b@example.com", "spaces in@example.com", "<a@example.com>", "a@example.com\nBcc: x@y.zz"]) {
    const { status, json } = await signup(env, { email });
    assert.equal(status, 422, JSON.stringify(email));
    assert.match(json.detail, /email must look like an address/, JSON.stringify(email));
  }
  const { status } = await signup(env, { email: 42 });
  assert.equal(status, 422);
  assert.equal(betaRecords(env).length, 0);
});

test("422: missing email, and a body that is not an object", async () => {
  const env = baseEnv();
  assert.equal((await signup(env, {})).status, 422);
  assert.equal((await signup(env, { org: "No address" })).status, 422);
  // readJson() rejects a non-object body before the handler sees it
  assert.equal((await signup(env, "[]")).status, 422);
  assert.equal((await signup(env, '"a@b.cc"')).status, 422);
  assert.equal(betaRecords(env).length, 0);
});

test("422: each field over its cap, and nothing is stored", async () => {
  const env = baseEnv();
  const long = (n) => "x".repeat(n);
  const cases = [
    [{ email: `${long(MAX_EMAIL)}@example.com` }, /email must be at most 254/],
    [{ email: "ok@example.com", org: long(MAX_ORG + 1) }, /org must be at most 120/],
    [{ email: "ok@example.com", use_case: long(MAX_USE_CASE + 1) }, /use_case must be at most 500/],
    [{ email: "ok@example.com", source: long(MAX_SOURCE + 1) }, /source must be at most 120/],
    [{ email: "ok@example.com", org: 7 }, /org must be a string/],
    [{ email: "ok@example.com", use_case: {} }, /use_case must be a string/],
    [{ email: "ok@example.com", source: [] }, /source must be a string/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await signup(env, body);
    assert.equal(status, 422, JSON.stringify(body).slice(0, 60));
    assert.match(json.detail, re);
  }
  assert.equal(betaRecords(env).length, 0);
  // A field exactly at its cap is accepted.
  const ok = await signup(env, { email: "cap@example.com", org: long(MAX_ORG), use_case: long(MAX_USE_CASE), source: long(MAX_SOURCE) });
  assert.equal(ok.status, 200);
});

test("405 wrong method, 415 wrong content type, 400 malformed JSON", async () => {
  const env = baseEnv();
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const resp = await call(env, method, "/v1/beta-signup", { headers: { "content-type": "application/json" } });
    assert.equal(resp.status, 405, method);
    assert.match((await resp.json()).detail, /POST/);
  }
  const wrongType = await signup(env, { email: "a@example.com" }, { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.json.detail, /application\/json/);

  const malformed = await signup(env, "{not json");
  assert.equal(malformed.status, 400);
  assert.match(malformed.json.detail, /malformed JSON/);

  assert.equal(betaRecords(env).length, 0);
});

test("429: the anonymous limiter covers the endpoint, keyed on the IP", async () => {
  const env = baseEnv({ RL: fakeRL(false) });
  const { status, json } = await signup(env, { email: "spam@example.com" });
  assert.equal(status, 429);
  assert.match(json.detail, /rate limited/);
  assert.deepEqual(env.RL.calls, [IP]);
  assert.equal(betaRecords(env).length, 0);
});

test("503 when the deployment has no KV binding, and the address is not lost", async () => {
  const env = baseEnv({ KEYS: undefined });
  const { status, json } = await signup(env, { email: "a@example.com" });
  assert.equal(status, 503);
  assert.match(json.detail, /hello@hlaverify\.com/);
});

// ------------------------------------------------------------------- CORS

test("browser preflight from the site is allowed", async () => {
  const env = baseEnv();
  const resp = await call(env, "OPTIONS", "/v1/beta-signup", {
    headers: { origin: "https://hlaverify.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get("access-control-allow-origin"), "*");
  assert.match(resp.headers.get("access-control-allow-methods"), /POST/);
  assert.match(resp.headers.get("access-control-allow-headers"), /content-type/);

  // and the POST that follows carries the same allow-origin
  const posted = await signup(env, { email: "cors@example.com" }, { headers: { origin: "https://hlaverify.com" } });
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get("access-control-allow-origin"), "*");
});

// ------------------------------------------------------- key-space containment

test("a beta/ record can never be presented as an API key", async () => {
  const env = baseEnv();
  await signup(env, { email: "attacker@example.com", org: "Example" });
  const kvKey = `${BETA_PREFIX}attacker@example.com`;
  // The record really is there and really does parse as truthy JSON — the exact
  // shape authorizeKey() would otherwise accept as a starter key.
  assert.ok(JSON.parse(env.KEYS._store.get(kvKey)));

  for (const presented of [kvKey, kvKey.toUpperCase(), `${BETA_PREFIX}nobody@example.com`]) {
    for (const headers of [{ "x-api-key": presented }, { authorization: `Bearer ${presented}` }]) {
      const resp = await call(env, "GET", "/v1/allele/A*01:01", { headers });
      assert.equal(resp.status, 401, `${presented} via ${Object.keys(headers)[0]}`);
      assert.match((await resp.json()).detail, /missing or invalid X-API-Key/);
      assert.equal(resp.headers.get("x-hla-verify-tier"), null);
    }
  }
  // Same on /mcp, which shares authorize().
  const mcp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json", "x-api-key": kvKey },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 401);
  // A real key still works, so the guard did not break key auth.
  const keyed = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": PRO_KEY } });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.headers.get("x-hla-verify-tier"), "pro");
});

// ---------------------------------------------------------------- MCP tool

async function mcpCall(env, name, args, id = 1) {
  const resp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: resp.status, json: JSON.parse(await resp.text()) };
}

test("MCP beta_signup: writes through the same path as the REST endpoint", async () => {
  const env = baseEnv();
  const { status, json } = await mcpCall(env, "beta_signup",
    { email: "Agent@Example.com", org: "Agent Lab", use_case: "mid-conversation signup", source: "mcp" });
  assert.equal(status, 200);
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.status, "recorded");
  assert.equal(json.result.structuredContent.release, manifest.release);

  const rec = JSON.parse(env.KEYS._store.get(`${BETA_PREFIX}agent@example.com`));
  assert.equal(rec.email, "Agent@Example.com");
  assert.equal(rec.source, "mcp");
  assert.equal(rec.country, "US");     // cf-ipcountry reaches the tool, the IP does not
  assert.equal(JSON.stringify(rec).includes(IP), false);

  // Idempotent, exactly like the endpoint.
  const again = await mcpCall(env, "beta_signup", { email: "agent@example.com" }, 2);
  assert.equal(again.json.result.structuredContent.status, "already_recorded");
  assert.equal(env.KEYS._puts.filter((p) => p.k.startsWith(BETA_PREFIX)).length, 1);
});

test("MCP beta_signup: validation failures are tool errors, not JSON-RPC errors", async () => {
  const env = baseEnv();
  for (const args of [{ email: "nope" }, { email: 1 }, {}, { email: "a@b.cc", org: "x".repeat(MAX_ORG + 1) }]) {
    const { status, json } = await mcpCall(env, "beta_signup", args);
    assert.equal(status, 200, JSON.stringify(args));
    assert.equal(json.error, undefined);
    assert.equal(json.result.isError, true, JSON.stringify(args));
    assert.equal(json.result.content[0].type, "text");
    assert.equal(json.result.structuredContent, undefined);
  }
  assert.equal(betaRecords(env).length, 0);
});

test("MCP beta_signup is advertised with write annotations and an outputSchema", async () => {
  const env = baseEnv();
  const resp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const tools = (await resp.json()).result.tools;
  assert.equal(tools.length, 9);
  const t = tools.find((x) => x.name === "beta_signup");
  assert.ok(t, "beta_signup missing from tools/list");
  assert.deepEqual(t.annotations, { readOnlyHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(t.inputSchema.required, ["email"]);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["email", "org", "source", "use_case"]);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.equal(t.outputSchema.type, "object");
  assert.deepEqual(t.outputSchema.required, ["ok", "status", "message", "release"]);
  assert.deepEqual(t.outputSchema.properties.status.enum, ["recorded", "already_recorded"]);
});

// ------------------------------------------------ pre-existing routes unchanged

test("every pre-existing route behaves exactly as before", async () => {
  const env = baseEnv();
  const body = (b) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const cases = [
    ["GET", "/healthz", {}, 200, (j) => assert.equal(j.release, manifest.release)],
    ["GET", "/docs", {}, 200, null],
    ["GET", "/", {}, 200, null],
    ["GET", "/pricing", {}, 200, null],
    ["POST", "/pricing", {}, 405, (j) => assert.match(j.detail, /GET \/pricing/)],
    ["GET", "/openapi.json", {}, 200, (j) => assert.equal(j.openapi, "3.1.0")],
    ["GET", "/data/x.json", {}, 404, null],
    ["GET", "/manifest.json", {}, 404, null],
    ["GET", "/v1/nope", {}, 404, (j) => assert.equal(j.detail, "Not Found")],
    ["GET", "/nope", {}, 404, (j) => assert.equal(j.detail, "Not Found")],
    ["GET", "/oauth/authorize", {}, 404, null],           // OAuth off in this env
    ["GET", "/mcp", {}, 405, (j) => assert.match(j.detail, /GET not supported/)],
    ["POST", "/v1/verify", body({ text: "A*0101 DQB1*05:03:26:99" }), 200,
      (j) => { assert.equal(j.clean, false); assert.equal(j.counts.hallucinated, 1); }],
    ["POST", "/v1/verify", body({ text: 1 }), 422, (j) => assert.match(j.detail, /text must be a string/)],
    ["GET", "/v1/verify", {}, 405, null],
    ["POST", "/v1/normalize", body({ typings: ["A*0101"] }), 200, (j) => assert.equal(j.rows[0].allele_2field, "A*01:01")],
    ["GET", "/v1/allele/A*01:01", {}, 200, (j) => assert.equal(j.status, "valid_prefix")],
    ["GET", "/v1/allele/A*99:99", {}, 404, (j) => assert.ok(j.detail)],
    ["POST", "/v1/match", body({ framework: "8/8", recipient: { A: ["A*02:01"] }, donor: { A: ["A*02:01"] } }), 200,
      (j) => assert.equal(j.framework, "8/8")],
    ["POST", "/v1/typing/check", body({ typing: { A: ["A*02:01", "A*24:02"] } }), 200, (j) => assert.equal(j.valid, true)],
    ["POST", "/v1/compat", body({ recipient: { B: ["B*07:02"] }, donor: { B: ["B*07:02"] } }), 200, (j) => assert.ok(j.b_leader)],
    ["POST", "/v1/glstring", body({ gl: "A*0101+A*02:01" }), 200, (j) => assert.equal(j.changed, true)],
    ["POST", "/v1/glstring", body({ gl: "" }), 422, (j) => assert.match(j.detail, /non-empty/)],
    // The signed-webhook path answers from stripe.js and carries no CORS headers, as it always has.
    ["POST", "/webhooks/stripe", body({}), 401, null, "noCors"],    // unsigned, no signing secret configured
    ["GET", "/webhooks/stripe", {}, 405, null],
  ];
  for (const [method, p, opts, status, check, noCors] of cases) {
    const resp = await call(env, method, p, opts);
    assert.equal(resp.status, status, `${method} ${p}`);
    assert.equal(resp.headers.get("access-control-allow-origin"), noCors ? null : "*", `${method} ${p}`);
    if (check) check(await resp.json());
  }
  // Legacy and modern MCP still answer, with the beta tool added and nothing removed.
  const legacy = await call(env, "POST", "/mcp", body({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
  const init = (await legacy.json()).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "hla-verify");
  const list = await call(env, "POST", "/mcp", body({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.deepEqual((await list.json()).result.tools.map((t) => t.name).sort(), [
    "about", "allele_info", "beta_signup", "check_typing", "donor_compat", "match_score",
    "normalize_allele", "validate_gl_string", "verify_text",
  ]);
  // None of the above wrote anything to KV.
  assert.deepEqual(env.KEYS._puts, []);
});
