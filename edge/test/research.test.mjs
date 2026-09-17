// POST /v1/research-access, the matching research_access MCP tool, and the
// zero-amount checkout the programme depends on. Driven end to end through
// index.js's real fetch handler with a fake KV, fake rate limiters and the
// disk-backed ASSETS stub the other worker tests use.
//
// 1. The contract the website's /research form depends on: 200 recorded /
//    already_recorded, {"detail": ...} on 400/405/415/422/429, CORS preflight.
// 2. The record: only what was submitted plus a timestamp, cf-ipcountry and a
//    pending status (never the IP) under a "research/" prefix in KEYS, which
//    is what scripts/research_access.py reads and writes back to.
// 3. Containment: a "research/" record must never authenticate as an API key,
//    on /v1/* or on /mcp. A beta/ record was once usable as one; this is the
//    same class of bug with a new prefix, so it gets the same test.
// 4. No quota: applying for free access must not spend a call out of the small
//    quota the applicant has.
// 5. Zero-amount checkout: a 100%-off code makes the Session total $0. Stripe
//    must not be asked for a card (payment_method_collection), the webhook must
//    still issue a key, and /checkout/success must still find it. That is the
//    whole point of the programme, and the half that is easy to get wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { RESEARCH_PREFIX, BETA_PREFIX, RESERVED_PREFIXES, MAX_EMAIL, MAX_INSTITUTION,
  MAX_RESEARCH_USE_CASE, MAX_EXPECTED_VOLUME, MAX_SOURCE } from "../src/handlers.js";
import { checkoutParams } from "../src/pricing.js";
import { handleStripeWebhook, hmacHex, resolveCheckoutSuccess, subIndexKey } from "../src/stripe.js";

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

// A quota Durable Object that records every spend, so "this route is not
// billable" is asserted against the counter rather than against a header.
function fakeQuota() {
  const spends = [];
  let count = 0;
  return {
    idFromName(name) { return name; },
    get(name) {
      return {
        async fetch(_url, init) {
          const { day, limit } = JSON.parse(init.body);
          spends.push({ name, day });
          count += 1;
          return new Response(JSON.stringify({ count, limit, day, over: count > limit }), { headers: { "content-type": "application/json" } });
        },
      };
    },
    spends,
  };
}

const PRO_KEY = "hlv_pro_test_key_0123456789abcdefghijklmnop";
const SECRET_KEY = "sk_enterprise_lab";
const SALT = "0123456789abcdef0123456789abcdef";

function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    HLA_VERIFY_API_KEYS: `${SECRET_KEY}=Lab:enterprise`,
    KEYS: fakeKV({ [PRO_KEY]: JSON.stringify({ label: "pro@example.com", tier: "pro", status: "active" }) }),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_LAB: fakeRL(), RL_SCALE: fakeRL(),
    QUOTA: fakeQuota(), QUOTA_IP_SALT: SALT,
    ASSETS,
    ...extra,
  };
}

const ORIGIN = "https://api.hlaverify.com";
const IP = "203.0.113.11";

// Every call carries the CF headers a real request would, so the "we stored no
// IP" assertions below mean something.
async function call(env, method, p, { headers = {}, body, ip = IP, country = "US" } = {}) {
  const h = { "cf-connecting-ip": ip, ...headers };
  if (country !== null) h["cf-ipcountry"] = country;
  const init = { method, headers: h };
  if (body !== undefined) init.body = body;
  return worker.fetch(new Request(ORIGIN + p, init), env, {});
}
async function apply(env, payload, { headers = {}, ...opts } = {}) {
  const resp = await call(env, "POST", "/v1/research-access", {
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...opts,
  });
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}

const records = (env) => [...env.KEYS._store.keys()].filter((k) => k.startsWith(RESEARCH_PREFIX));

const GOOD = {
  email: "Pi@Lab.Example",
  institution: "Example University",
  use_case: "Retyping QC for a 4,000-donor registry cohort study",
  expected_volume: "about 20,000 typings a month",
  source: "site",
};

// ------------------------------------------------------------- happy path

test("happy path: records the application and answers the documented shape", async () => {
  const env = baseEnv();
  const { status, headers, json } = await apply(env, GOOD);

  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.equal(headers.get("x-hla-verify-release"), manifest.release);
  assert.equal(headers.get("x-hla-verify-tier"), "free");
  assert.deepEqual(Object.keys(json).sort(), ["message", "ok", "release", "status"]);
  assert.equal(json.ok, true);
  assert.equal(json.status, "recorded");
  assert.equal(json.release, manifest.release);
  // The wording has to be honest that a person decides, and when they have not yet.
  assert.match(json.message, /pending/i);
  assert.match(json.message, /by hand/i);
  assert.match(json.message, /not instant/i);

  // Keyed on the lowercased address, under the research/ prefix, nowhere else.
  assert.deepEqual(records(env), [`${RESEARCH_PREFIX}pi@lab.example`]);
  const rec = JSON.parse(env.KEYS._store.get(`${RESEARCH_PREFIX}pi@lab.example`));
  assert.deepEqual(Object.keys(rec).sort(),
    ["country", "email", "expected_volume", "institution", "source", "status", "ts", "use_case"]);
  assert.equal(rec.email, "Pi@Lab.Example");   // as typed; only the KV key is lowercased
  assert.equal(rec.institution, "Example University");
  assert.equal(rec.use_case, GOOD.use_case);
  assert.equal(rec.expected_volume, "about 20,000 typings a month");
  assert.equal(rec.source, "site");
  assert.equal(rec.country, "US");
  assert.equal(rec.status, "pending");
  assert.ok(Date.parse(rec.ts) > 0);
  // No IP address, and nothing else personal, anywhere in the stored record.
  assert.equal(JSON.stringify(rec).includes(IP), false);
});

test("optional fields absent: stored as null, not invented", async () => {
  const env = baseEnv();
  const { status, json } = await apply(env,
    { email: " someone@example.org ", institution: " Example Institute ", use_case: " teaching an immunogenetics course " },
    { country: null });
  assert.equal(status, 200);
  assert.equal(json.status, "recorded");
  const rec = JSON.parse(env.KEYS._store.get(`${RESEARCH_PREFIX}someone@example.org`));
  assert.equal(rec.email, "someone@example.org");                  // trimmed
  assert.equal(rec.institution, "Example Institute");              // trimmed
  assert.equal(rec.use_case, "teaching an immunogenetics course"); // trimmed
  assert.deepEqual([rec.expected_volume, rec.source, rec.country], [null, null, null]);
  assert.equal(rec.status, "pending");
});

test("duplicate address: already_recorded, one record, an approval is not overwritten", async () => {
  const env = baseEnv();
  const first = await apply(env, { ...GOOD, email: "dup@example.org", institution: "First Lab" });
  assert.equal(first.json.status, "recorded");

  // The owner approves it: the script writes the code and the decision back.
  const kvKey = `${RESEARCH_PREFIX}dup@example.org`;
  const approved = { ...JSON.parse(env.KEYS._store.get(kvKey)), status: "approved", promotion_code: "HLVRESEARCHXYZ" };
  env.KEYS._store.set(kvKey, JSON.stringify(approved));

  const again = await apply(env, { ...GOOD, email: "DUP@Example.ORG", institution: "Second Lab" });
  assert.equal(again.status, 200);
  assert.equal(again.json.ok, true);
  assert.equal(again.json.status, "already_recorded");
  assert.match(again.json.message, /already on file/i);
  assert.equal(again.json.release, manifest.release);

  assert.deepEqual(records(env), [kvKey]);
  // One write from the endpoint, ever: re-applying must not reset an approved
  // record to pending or throw away the code that was issued against it.
  assert.equal(env.KEYS._puts.filter((p) => p.k.startsWith(RESEARCH_PREFIX)).length, 1);
  const after = JSON.parse(env.KEYS._store.get(kvKey));
  assert.equal(after.status, "approved");
  assert.equal(after.promotion_code, "HLVRESEARCHXYZ");
  assert.equal(after.institution, "First Lab");
});

// -------------------------------------------------------------- rejections

test("422: an address that does not look like one", async () => {
  const env = baseEnv();
  for (const email of ["", "   ", "nope", "no-at-sign.example.com", "two@@example.com", "a@b",
    "a@example.com, b@example.com", "spaces in@example.com", "<a@example.com>", "a@example.com\nBcc: x@y.zz"]) {
    const { status, json } = await apply(env, { ...GOOD, email });
    assert.equal(status, 422, JSON.stringify(email));
    assert.match(json.detail, /email must look like an address/, JSON.stringify(email));
  }
  assert.equal((await apply(env, { ...GOOD, email: 42 })).status, 422);
  assert.equal(records(env).length, 0);
});

test("422: each required field missing, empty or the wrong type", async () => {
  const env = baseEnv();
  const cases = [
    [{}, /email must be a string/],
    [{ email: "ok@example.com" }, /institution must be a string/],
    [{ email: "ok@example.com", institution: "" }, /institution must not be empty/],
    [{ email: "ok@example.com", institution: "   " }, /institution must not be empty/],
    [{ email: "ok@example.com", institution: 7 }, /institution must be a string/],
    [{ email: "ok@example.com", institution: "Example U" }, /use_case must be a string/],
    [{ email: "ok@example.com", institution: "Example U", use_case: "" }, /use_case must not be empty/],
    [{ email: "ok@example.com", institution: "Example U", use_case: {} }, /use_case must be a string/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await apply(env, body);
    assert.equal(status, 422, JSON.stringify(body).slice(0, 60));
    assert.match(json.detail, re, JSON.stringify(body).slice(0, 60));
  }
  // readJson() rejects a non-object body before the handler sees it
  assert.equal((await apply(env, "[]")).status, 422);
  assert.equal((await apply(env, '"a@b.cc"')).status, 422);
  assert.equal(records(env).length, 0);
});

test("422: each field over its cap, and nothing is stored", async () => {
  const env = baseEnv();
  const long = (n) => "x".repeat(n);
  const base = { email: "ok@example.com", institution: "Example U", use_case: "why" };
  const cases = [
    [{ ...base, email: `${long(MAX_EMAIL)}@example.com` }, /email must be at most 254/],
    [{ ...base, institution: long(MAX_INSTITUTION + 1) }, /institution must be at most 200/],
    [{ ...base, use_case: long(MAX_RESEARCH_USE_CASE + 1) }, /use_case must be at most 1000/],
    [{ ...base, expected_volume: long(MAX_EXPECTED_VOLUME + 1) }, /expected_volume must be at most 120/],
    [{ ...base, source: long(MAX_SOURCE + 1) }, /source must be at most 120/],
    [{ ...base, expected_volume: 7 }, /expected_volume must be a string/],
    [{ ...base, source: [] }, /source must be a string/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await apply(env, body);
    assert.equal(status, 422, JSON.stringify(body).slice(0, 60));
    assert.match(json.detail, re);
  }
  assert.equal(records(env).length, 0);
  // A field exactly at its cap is accepted.
  const ok = await apply(env, { email: "cap@example.com", institution: long(MAX_INSTITUTION),
    use_case: long(MAX_RESEARCH_USE_CASE), expected_volume: long(MAX_EXPECTED_VOLUME), source: long(MAX_SOURCE) });
  assert.equal(ok.status, 200);
});

test("405 wrong method, 415 wrong content type, 400 malformed JSON", async () => {
  const env = baseEnv();
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const resp = await call(env, method, "/v1/research-access", { headers: { "content-type": "application/json" } });
    assert.equal(resp.status, 405, method);
    assert.match((await resp.json()).detail, /POST/);
  }
  const wrongType = await apply(env, GOOD, { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.json.detail, /application\/json/);

  const malformed = await apply(env, "{not json");
  assert.equal(malformed.status, 400);
  assert.match(malformed.json.detail, /malformed JSON/);

  assert.equal(records(env).length, 0);
});

test("429: the anonymous limiter covers the endpoint, keyed on the IP", async () => {
  const env = baseEnv({ RL: fakeRL(false) });
  const { status, json } = await apply(env, GOOD);
  assert.equal(status, 429);
  assert.match(json.detail, /rate limited/);
  assert.deepEqual(env.RL.calls, [IP]);
  assert.equal(records(env).length, 0);
});

test("503 when the deployment has no KV binding, and the applicant is told where to go", async () => {
  const env = baseEnv({ KEYS: undefined });
  const { status, json } = await apply(env, GOOD);
  assert.equal(status, 503);
  assert.match(json.detail, /hello@hlaverify\.com/);
});

// ------------------------------------------------------------------ quota

test("applying consumes no daily quota, on REST or on MCP", async () => {
  const env = baseEnv();
  assert.equal((await apply(env, GOOD)).status, 200);
  assert.equal((await apply(env, { ...GOOD, email: "second@example.org" })).status, 200);
  const mcp = await mcpCall(env, "research_access", { ...GOOD, email: "third@example.org" });
  assert.equal(mcp.json.result.isError, false);
  assert.deepEqual(env.QUOTA.spends, [], "research access must not charge the daily counter");

  // A billable route in the same env does charge, so the counter is really wired up.
  assert.equal((await call(env, "GET", "/v1/allele/A*01:01")).status, 200);
  assert.equal(env.QUOTA.spends.length, 1);
});

// ------------------------------------------------------------------- CORS

test("browser preflight from the site is allowed", async () => {
  const env = baseEnv();
  const resp = await call(env, "OPTIONS", "/v1/research-access", {
    headers: { origin: "https://hlaverify.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get("access-control-allow-origin"), "*");
  assert.match(resp.headers.get("access-control-allow-methods"), /POST/);
  assert.match(resp.headers.get("access-control-allow-headers"), /content-type/);

  const posted = await apply(env, GOOD, { headers: { origin: "https://hlaverify.com" } });
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get("access-control-allow-origin"), "*");
});

// ------------------------------------------------------- key-space containment

test("a research/ record can never be presented as an API key", async () => {
  const env = baseEnv();
  await apply(env, { ...GOOD, email: "attacker@example.com" });
  const kvKey = `${RESEARCH_PREFIX}attacker@example.com`;
  // The record really is there and really does parse as truthy JSON, the exact
  // shape authorizeKey() would otherwise accept as a starter key.
  assert.ok(JSON.parse(env.KEYS._store.get(kvKey)));

  for (const presented of [kvKey, kvKey.toUpperCase(), `${RESEARCH_PREFIX}nobody@example.com`, RESEARCH_PREFIX]) {
    for (const headers of [{ "x-api-key": presented }, { authorization: `Bearer ${presented}` }]) {
      const resp = await call(env, "GET", "/v1/allele/A*01:01", { headers });
      assert.equal(resp.status, 401, `${presented} via ${Object.keys(headers)[0]}`);
      assert.match((await resp.json()).detail, /missing or invalid X-API-Key/);
      assert.equal(resp.headers.get("x-hla-verify-tier"), null);
    }
    // Same on /mcp, which shares authorize().
    const mcp = await call(env, "POST", "/mcp", {
      headers: { "content-type": "application/json", "x-api-key": presented },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 401, `${presented} on /mcp`);
    assert.match((await mcp.json()).detail, /missing or invalid X-API-Key/);
  }
  // A real key still works, so the guard did not break key auth.
  const keyed = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": PRO_KEY } });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.headers.get("x-hla-verify-tier"), "pro");
});

test("both reserved prefixes are declared, and the beta guard still holds", async () => {
  // The list is the mechanism: a prefix added to the KEYS namespace without an
  // entry here is the bug this file exists to prevent recurring.
  assert.deepEqual([...RESERVED_PREFIXES].sort(), [BETA_PREFIX, RESEARCH_PREFIX].sort());
  const env = baseEnv();
  for (const presented of [`${BETA_PREFIX}x@example.com`, `${RESEARCH_PREFIX}x@example.com`]) {
    const resp = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": presented } });
    assert.equal(resp.status, 401, presented);
  }
});

// ---------------------------------------------------------------- MCP tool

async function mcpCall(env, name, args, id = 1) {
  const resp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: resp.status, json: JSON.parse(await resp.text()) };
}

test("MCP research_access: writes through the same path as the REST endpoint", async () => {
  const env = baseEnv();
  const { status, json } = await mcpCall(env, "research_access",
    { email: "Agent@Example.com", institution: "Agent University", use_case: "cohort retyping QC", source: "mcp" });
  assert.equal(status, 200);
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.status, "recorded");
  assert.equal(json.result.structuredContent.release, manifest.release);

  const rec = JSON.parse(env.KEYS._store.get(`${RESEARCH_PREFIX}agent@example.com`));
  assert.equal(rec.email, "Agent@Example.com");
  assert.equal(rec.institution, "Agent University");
  assert.equal(rec.source, "mcp");
  assert.equal(rec.status, "pending");
  assert.equal(rec.country, "US");     // cf-ipcountry reaches the tool, the IP does not
  assert.equal(JSON.stringify(rec).includes(IP), false);

  // Idempotent, exactly like the endpoint.
  const again = await mcpCall(env, "research_access",
    { email: "agent@example.com", institution: "Agent University", use_case: "again" }, 2);
  assert.equal(again.json.result.structuredContent.status, "already_recorded");
  assert.equal(env.KEYS._puts.filter((p) => p.k.startsWith(RESEARCH_PREFIX)).length, 1);
});

test("MCP research_access: validation failures are tool errors, not JSON-RPC errors", async () => {
  const env = baseEnv();
  const bad = [
    {},
    { email: "nope", institution: "U", use_case: "x" },
    { email: "a@b.cc" },
    { email: "a@b.cc", institution: "U" },
    { email: "a@b.cc", institution: "", use_case: "x" },
    { email: "a@b.cc", institution: "U", use_case: "x".repeat(MAX_RESEARCH_USE_CASE + 1) },
  ];
  for (const args of bad) {
    const { status, json } = await mcpCall(env, "research_access", args);
    assert.equal(status, 200, JSON.stringify(args));
    assert.equal(json.error, undefined);
    assert.equal(json.result.isError, true, JSON.stringify(args));
    assert.equal(json.result.content[0].type, "text");
    assert.equal(json.result.structuredContent, undefined);
  }
  assert.equal(records(env).length, 0);
});

test("MCP research_access is advertised with write annotations and an outputSchema", async () => {
  const env = baseEnv();
  const resp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const tools = (await resp.json()).result.tools;
  assert.equal(tools.length, 10);
  const t = tools.find((x) => x.name === "research_access");
  assert.ok(t, "research_access missing from tools/list");
  assert.deepEqual(t.annotations, { readOnlyHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(t.inputSchema.required, ["email", "institution", "use_case"]);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(),
    ["email", "expected_volume", "institution", "source", "use_case"]);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.equal(t.outputSchema.type, "object");
  assert.deepEqual(t.outputSchema.required, ["ok", "status", "message", "release"]);
  assert.deepEqual(t.outputSchema.properties.status.enum, ["recorded", "already_recorded"]);
  // The description is the only pitch an agent reads: it has to say approval is
  // by hand, or an agent will promise its user an instant key.
  assert.match(t.description, /manual/i);
  assert.match(t.description, /academic or nonprofit/i);
  // research_access sits next to beta_signup, before about, and beta_signup
  // keeps its place: an agent's tool order is part of the catalog contract.
  const names = tools.map((x) => x.name);
  assert.deepEqual(names.slice(-3), ["beta_signup", "research_access", "about"]);
});

test("the about tool describes the research programme honestly", async () => {
  const env = baseEnv();
  const { json } = await mcpCall(env, "about", {});
  const sc = json.result.structuredContent;
  assert.match(sc.research, /hlaverify\.com\/research/);
  assert.match(sc.research, /read by a person/i);
  assert.match(sc.research, /not instant and not guaranteed/i);
  assert.match(sc.limits, /research_access/);
});

// ------------------------------------------- zero-amount checkout end to end
// A 100%-off promotion code is the whole programme. Three things have to hold
// for it: Checkout must not demand a card it has nothing to charge, the webhook
// must issue a key for a $0 subscription exactly as for a paid one, and the
// success page must recognise the completed session.

test("checkoutParams does not demand a card when there is nothing to charge", () => {
  const params = checkoutParams({ price: "price_lab", tier: "lab", successUrl: "s", cancelUrl: "c" });
  assert.equal(params.get("payment_method_collection"), "if_required");
  // and the rest of the session is unchanged
  assert.equal(params.get("mode"), "subscription");
  assert.equal(params.get("metadata[tier]"), "lab");
  assert.equal(params.get("allow_promotion_codes"), "true");
  assert.equal(params.get("automatic_tax[enabled]"), "true");
});

const WHSEC = "whsec_research_test";

async function postWebhook(env, event, { now = Date.now() } = {}) {
  const raw = JSON.stringify(event);
  const t = Math.floor(now / 1000);
  const sig = await hmacHex(WHSEC, `${t}.${raw}`);
  return handleStripeWebhook(new Request("https://api.hlaverify.com/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
    body: raw,
  }), env);
}

// What Stripe sends after a 100%-off subscription checkout: nothing was charged,
// so payment_status is "no_payment_required" and there is no payment_intent.
const ZERO_SESSION = {
  id: "cs_test_research",
  mode: "subscription",
  payment_status: "no_payment_required",
  amount_total: 0,
  subscription: "sub_research_1",
  payment_intent: null,
  customer: "cus_research_1",
  customer_details: { email: "pi@lab.example", name: "Example PI" },
  metadata: { tier: "lab" },
};

test("a $0 subscription issues a key through the webhook, exactly as a paid one does", async () => {
  const env = baseEnv({ STRIPE_WEBHOOK_SECRET: WHSEC });
  const resp = await postWebhook(env, { type: "checkout.session.completed", data: { object: ZERO_SESSION } });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, handled: "checkout.session.completed" });

  const issued = [...env.KEYS._store.keys()].filter((k) => k.startsWith("hlv_") && k !== PRO_KEY);
  assert.equal(issued.length, 1, "a $0 subscription must still produce exactly one key");
  const apiKey = issued[0];
  const rec = JSON.parse(env.KEYS._store.get(apiKey));
  assert.equal(rec.tier, "lab");                       // from metadata.tier, no Stripe call
  assert.equal(rec.status, "active");
  assert.equal(rec.provider, "stripe");
  assert.equal(rec.ref, "sub_research_1");
  assert.equal(rec.label, "stripe:cus_research_1");    // never the email address
  assert.equal(rec.email, "pi@lab.example");
  // and the subscription index the cancel path needs
  assert.equal(await env.KEYS.get(subIndexKey("sub_research_1")), apiKey);

  // The issued key really authorizes, at the tier the research lab was given.
  const used = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": apiKey } });
  assert.equal(used.status, 200);
  assert.equal(used.headers.get("x-hla-verify-tier"), "lab");
});

test("cancelling a free research subscription revokes its key the same way", async () => {
  const env = baseEnv({ STRIPE_WEBHOOK_SECRET: WHSEC });
  await postWebhook(env, { type: "checkout.session.completed", data: { object: ZERO_SESSION } });
  const apiKey = [...env.KEYS._store.keys()].find((k) => k.startsWith("hlv_") && k !== PRO_KEY);

  await postWebhook(env, { type: "customer.subscription.deleted", data: { object: { id: "sub_research_1" } } });
  assert.equal(JSON.parse(env.KEYS._store.get(apiKey)).status, "revoked");
  const used = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": apiKey } });
  assert.equal(used.status, 401);
});

test("/checkout/success finds the key for a $0 session and does not claim a payment", async () => {
  const env = baseEnv({ STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_x" });
  await postWebhook(env, { type: "checkout.session.completed", data: { object: ZERO_SESSION } });
  const apiKey = [...env.KEYS._store.keys()].find((k) => k.startsWith("hlv_") && k !== PRO_KEY);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(ZERO_SESSION), { headers: { "content-type": "application/json" } });
  try {
    const result = await resolveCheckoutSuccess("cs_test_research", env);
    assert.equal(result.status, "ok", "a no_payment_required session is a completed session");
    assert.equal(result.key, apiKey);
    assert.equal(result.tier, "lab");
    assert.equal(result.free, true);

    const page = await call(env, "GET", "/checkout/success?session_id=cs_test_research");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(apiKey), "the success page must show the issued key");
    assert.ok(html.includes("Subscription active"));
    assert.equal(html.includes("Payment received"), false, "nothing was paid; do not say it was");
    assert.ok(html.includes("Nothing was charged."));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an unpaid session is still not a completed one", async () => {
  const env = baseEnv({ STRIPE_SECRET_KEY: "sk_test_x" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...ZERO_SESSION, payment_status: "unpaid" }),
    { headers: { "content-type": "application/json" } });
  try {
    assert.deepEqual(await resolveCheckoutSuccess("cs_test_research", env), { status: "not_found" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------ pre-existing routes unchanged

test("the beta list and every other route are untouched by the new prefix", async () => {
  const env = baseEnv();
  const body = (b) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  // The beta endpoint still behaves exactly as it did, and writes its own prefix.
  const beta = await call(env, "POST", "/v1/beta-signup", body({ email: "still@example.org", org: "Example" }));
  assert.equal(beta.status, 200);
  assert.equal((await beta.json()).status, "recorded");
  assert.deepEqual([...env.KEYS._store.keys()].filter((k) => k.startsWith(BETA_PREFIX)), [`${BETA_PREFIX}still@example.org`]);
  assert.equal(records(env).length, 0);

  for (const [method, p, opts, status] of [
    ["GET", "/healthz", {}, 200],
    ["GET", "/docs", {}, 200],
    ["GET", "/pricing", {}, 200],
    ["GET", "/openapi.json", {}, 200],
    ["GET", "/v1/nope", {}, 404],
    ["GET", "/nope", {}, 404],
    ["POST", "/v1/verify", body({ text: "A*0101" }), 200],
  ]) {
    const resp = await call(env, method, p, opts);
    assert.equal(resp.status, status, `${method} ${p}`);
  }
});

test("/docs, /openapi.json and /pricing all describe the programme", async () => {
  const env = baseEnv();
  const docs = await (await call(env, "GET", "/docs")).text();
  assert.ok(docs.includes("/v1/research-access"));
  assert.match(docs, /a person reads every application/i);

  const pricing = await (await call(env, "GET", "/pricing")).text();
  assert.ok(pricing.includes("/v1/research-access"));
  assert.match(pricing, /A person reads every application/i);
  assert.match(pricing, /no card/i);

  const spec = await (await call(env, "GET", "/openapi.json")).json();
  const op = spec.paths["/v1/research-access"].post;
  assert.deepEqual(op.requestBody.content["application/json"].schema.required, ["email", "institution", "use_case"]);
  assert.match(op.description, /Approval is manual/);
  assert.ok(op.responses[422] && op.responses[429] && op.responses[503]);
  assert.match(spec.paths["/mcp"].post.description, /research_access/);
});
