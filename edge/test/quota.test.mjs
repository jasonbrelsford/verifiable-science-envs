// Per-tier daily quotas and per-call batch caps, driven end to end through
// index.js's real fetch handler with the real DailyQuota Durable Object class
// running on an in-memory storage stub — so the counter under test is the code
// that ships, not a mock of it.
//
// What must hold:
// 1. A billable call decrements, the call AT the limit is served, the one after
//    it is 429 — and the counter rolls over at UTC midnight, not on a window.
// 2. Counting subjects never bleed into each other: two IPs, two keys, and an
//    anonymous caller is not counted globally.
// 3. The raw IP never reaches the counter — not its name, not its storage.
// 4. Legacy `pro` keys get Lab's limits and still report tier `pro`.
// 5. Batch caps come from the tier: accepted at the cap, 422 above it with a
//    message naming the cap and the tier that lifts it.
// 6. Non-billable routes (and the non-billable MCP tools) consume nothing.
// 7. /mcp consumes the same quota and refuses with a readable JSON-RPC frame.
// 8. A broken or absent counter fails OPEN: the request is served.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker, { DailyQuota } from "../src/index.js";
import { spendQuota, quotaHeaders, subjectName, utcDay, nextUtcMidnight, isBillablePath, BILLABLE_TOOLS } from "../src/quota.js";
import { TIER_LIMITS, limitsFor, canonicalTier } from "../src/keys.js";

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
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}
const fakeRL = (allow = true) => ({ calls: [], async limit({ key }) { this.calls.push(key); return { success: allow }; } });

// Storage stub with the Durable Object semantics the counter relies on:
// values round-trip through a copy, and setAlarm/deleteAll exist.
function memStorage() {
  const map = new Map();
  let alarm = null;
  return {
    async get(k) { const v = map.get(k); return v === undefined ? undefined : structuredClone(v); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async deleteAll() { map.clear(); alarm = null; },
    async setAlarm(t) { alarm = t; },
    async getAlarm() { return alarm; },
    _map: map,
  };
}

// A QUOTA binding backed by real DailyQuota instances, one per object name.
function fakeQuotaNamespace({ fail = false } = {}) {
  const objects = new Map();
  const names = [];
  return {
    _names: names,
    _objects: objects,
    fail,
    object(name) {
      if (!objects.has(name)) objects.set(name, new DailyQuota({ storage: memStorage() }));
      return objects.get(name);
    },
    // Reaches into a counter the way only a test may, to park a subject one
    // call short of its limit without making that many requests.
    seed(name, day, count) { this.object(name).state.storage.put("q", { day, count }); },
    idFromName(name) { names.push(name); return { name }; },
    get(id) {
      const ns = this;
      return {
        fetch(url, init) {
          if (ns.fail) return Promise.reject(new Error("durable object unreachable"));
          return ns.object(id.name).fetch(new Request(url, init));
        },
      };
    },
  };
}

const LAB_KEY = "hlv_lab_key_0123456789abcdefghijklmnopqrstu";
const PRO_KEY = "hlv_pro_key_0123456789abcdefghijklmnopqrstu";
const ACADEMIC_KEY = "hlv_academic_key_0123456789abcdefghijklmno";
const STARTER_KEY = "hlv_starter_key_0123456789abcdefghijklmnop";
const OTHER_STARTER_KEY = "hlv_starter_two_0123456789abcdefghijklmnop";
const ENTERPRISE_KEY = "sk_enterprise_lab";

function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    HLA_VERIFY_API_KEYS: `${ENTERPRISE_KEY}=Lab:enterprise`,
    KEYS: fakeKV({
      [LAB_KEY]: JSON.stringify({ label: "lab@example.com", tier: "lab", status: "active" }),
      [PRO_KEY]: JSON.stringify({ label: "pro@example.com", tier: "pro", status: "active" }),
      [ACADEMIC_KEY]: JSON.stringify({ label: "univ@example.edu", tier: "academic", status: "active" }),
      [STARTER_KEY]: JSON.stringify({ label: "starter@example.com", tier: "starter", status: "active" }),
      [OTHER_STARTER_KEY]: JSON.stringify({ label: "other@example.com", tier: "starter", status: "active" }),
    }),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_LAB: fakeRL(), RL_SCALE: fakeRL(),
    QUOTA: fakeQuotaNamespace(),
    QUOTA_IP_SALT: "test-salt-0123456789abcdef",
    ASSETS,
    ...extra,
  };
}

const ORIGIN = "https://api.hlaverify.com";
const IP = "203.0.113.7";

async function call(env, method, p, { headers = {}, body, ip = IP } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (body !== undefined) init.body = body;
  const resp = await worker.fetch(new Request(ORIGIN + p, init), env, {});
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* HTML route */ }
  return { status: resp.status, headers: resp.headers, text, json };
}
const allele = (env, opts) => call(env, "GET", "/v1/allele/A*01:01", opts);
const post = (env, p, payload, { headers = {}, ...rest } = {}) =>
  call(env, "POST", p, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), ...rest });
const keyed = (key) => ({ headers: { "x-api-key": key } });

const q = (h) => ({
  tier: h.get("x-hla-verify-tier"),
  limit: h.get("x-hla-verify-daily-limit"),
  remaining: h.get("x-hla-verify-daily-remaining"),
  reset: h.get("x-hla-verify-daily-reset"),
  maxTypings: h.get("x-hla-verify-max-typings"),
});

// ------------------------------------------------------ the published table

test("the tier table is exactly what /pricing publishes, and pro is an alias for lab", () => {
  assert.deepEqual(Object.entries(TIER_LIMITS).map(([t, l]) => [t, l.calls, l.typings]), [
    ["free", 100, 250],
    ["starter", 500, 250],
    ["lab", 10_000, 5_000],
    ["scale", 1_000_000, 5_000],
    ["enterprise", null, 5_000],
    ["academic", 10_000, 5_000],
  ]);
  assert.equal(canonicalTier("pro"), "lab");
  assert.deepEqual(limitsFor("pro"), TIER_LIMITS.lab);
  // An unrecognized tier on a malformed record must not mean "uncapped".
  assert.deepEqual(limitsFor("platinum"), TIER_LIMITS.starter);
});

test("billable routes and tools are exactly the metered ones", () => {
  for (const p of ["/v1/verify", "/v1/normalize", "/v1/match", "/v1/typing/check", "/v1/compat", "/v1/glstring", "/v1/allele/A*01:01"])
    assert.equal(isBillablePath(p), true, p);
  for (const p of ["/healthz", "/docs", "/openapi.json", "/pricing", "/checkout/success", "/v1/beta-signup",
    "/webhooks/stripe", "/.well-known/oauth-protected-resource", "/oauth/authorize", "/mcp", "/v1/unknown"])
    assert.equal(isBillablePath(p), false, p);
  assert.equal(BILLABLE_TOOLS.has("about"), false);
  assert.equal(BILLABLE_TOOLS.has("beta_signup"), false);
  assert.equal(BILLABLE_TOOLS.size, 7);
});

// --------------------------------------------------------------- headers

test("every billable response carries tier, limit, remaining, reset and the batch cap", async () => {
  const env = baseEnv();
  const { status, headers } = await allele(env);
  assert.equal(status, 200);
  const h = q(headers);
  assert.equal(h.tier, "free");
  assert.equal(h.limit, "100");
  assert.equal(h.remaining, "99");
  assert.equal(h.maxTypings, "250");
  // Reset is the next UTC midnight, to the second.
  const reset = Date.parse(h.reset);
  assert.ok(reset > Date.now() && reset - Date.now() <= 86_400_000);
  assert.equal(new Date(reset).toISOString().slice(11), "00:00:00.000Z");

  const lab = q((await allele(env, keyed(LAB_KEY))).headers);
  assert.deepEqual([lab.tier, lab.limit, lab.remaining, lab.maxTypings], ["lab", "10000", "9999", "5000"]);

  const ent = q((await allele(env, keyed(ENTERPRISE_KEY))).headers);
  assert.deepEqual([ent.tier, ent.limit, ent.remaining, ent.maxTypings], ["enterprise", "unlimited", "unlimited", "5000"]);
  // Uncapped means the counter is never consulted at all.
  assert.deepEqual(env.QUOTA._names.filter((n) => n.startsWith("k:")).length, 1);
});

test("a 422, a 405 and a 404-from-the-engine all still carry the quota headers", async () => {
  const env = baseEnv();
  const bad = await post(env, "/v1/normalize", { typings: "not a list" });
  assert.equal(bad.status, 422);
  assert.equal(q(bad.headers).remaining, "99");
  const wrongMethod = await call(env, "GET", "/v1/normalize");
  assert.equal(wrongMethod.status, 405);
  assert.equal(q(wrongMethod.headers).remaining, "98");
  const missing = await call(env, "GET", "/v1/allele/A*99:99");
  assert.equal(missing.status, 404);
  assert.equal(q(missing.headers).remaining, "97");
});

// ------------------------------------------------------- counting and 429

test("the quota decrements, serves the call AT the limit, and 429s the one after", async () => {
  const env = baseEnv();
  assert.equal(q((await allele(env)).headers).remaining, "99");
  assert.equal(q((await allele(env)).headers).remaining, "98");

  // Park this subject one call short of the free tier's 100.
  const name = env.QUOTA._names[0];
  env.QUOTA.seed(name, utcDay(), 99);

  const last = await allele(env);
  assert.equal(last.status, 200, "the 100th call of the day is served");
  assert.equal(q(last.headers).remaining, "0");

  const over = await allele(env);
  assert.equal(over.status, 429, "the 101st is refused");
  assert.equal(over.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(q(over.headers).remaining, "0");
  assert.equal(q(over.headers).limit, "100");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  // The message an agent has to act on: tier, limit, reset, and the upgrade.
  assert.deepEqual(Object.keys(over.json), ["detail"]);
  assert.match(over.json.detail, /free tier allows 100 API calls per UTC day/);
  assert.match(over.json.detail, /UTC midnight/);
  assert.match(over.json.detail, new RegExp(q(over.headers).reset.replace(/[.\-:]/g, "\\$&")));
  assert.match(over.json.detail, /starter tier \(\$49\/mo\) allows 500 calls\/day/);
  assert.match(over.json.detail, /https:\/\/api\.hlaverify\.com\/pricing/);

  // Being over does not keep counting up: a refused call is not a spent one.
  const rec = await env.QUOTA._objects.get(name).state.storage.get("q");
  assert.equal(rec.count, 100);
});

test("the day boundary is UTC midnight: the counter rolls over, it does not slide", async () => {
  const env = baseEnv();
  const who = { label: "k", tier: "starter", keyed: true, keyRef: STARTER_KEY };
  const req = new Request(ORIGIN + "/v1/verify", { headers: { "cf-connecting-ip": IP } });

  const eve = Date.parse("2026-03-01T23:59:59.500Z");
  const first = await spendQuota(env, who, req, { now: eve });
  assert.equal(first.remaining, 499);
  assert.equal(first.reset, "2026-03-02T00:00:00.000Z");

  // Spend the rest of the day.
  env.QUOTA.seed(env.QUOTA._names[0], "2026-03-01", 500);
  const spent = await spendQuota(env, who, req, { now: eve });
  assert.equal(spent.ok, false);
  assert.equal(spent.remaining, 0);

  // Half a second later it is a new UTC day, on the same counter object.
  const after = await spendQuota(env, who, req, { now: eve + 1000 });
  assert.equal(after.ok, true);
  assert.equal(after.remaining, 499, "a full day's quota, not a 24-hour window");
  assert.equal(after.reset, "2026-03-03T00:00:00.000Z");
  assert.equal(env.QUOTA._objects.size, 1, "the same subject keeps one counter across days");
});

test("utcDay and nextUtcMidnight agree on the boundary", () => {
  assert.equal(utcDay(Date.parse("2026-03-01T00:00:00.000Z")), "2026-03-01");
  assert.equal(utcDay(Date.parse("2026-03-01T23:59:59.999Z")), "2026-03-01");
  assert.equal(nextUtcMidnight(Date.parse("2026-03-01T00:00:00.000Z")).toISOString(), "2026-03-02T00:00:00.000Z");
  assert.equal(nextUtcMidnight(Date.parse("2026-03-01T23:59:59.999Z")).toISOString(), "2026-03-02T00:00:00.000Z");
});

// ------------------------------------------------------ counting subjects

test("anonymous callers are counted per IP, not globally, and the IP is never stored", async () => {
  const env = baseEnv();
  await allele(env, { ip: "203.0.113.7" });
  await allele(env, { ip: "203.0.113.7" });
  const other = await allele(env, { ip: "198.51.100.22" });
  assert.equal(q(other.headers).remaining, "99", "a second IP starts at its own full quota");
  const third = await allele(env, { ip: "203.0.113.7" });
  assert.equal(q(third.headers).remaining, "97", "the first IP kept counting");
  assert.equal(env.QUOTA._objects.size, 2);

  // The counter is addressed by a digest of the day and the address: nothing
  // anywhere in the names or the stored records is the address itself.
  const everything = JSON.stringify([...env.QUOTA._objects.keys()]) +
    JSON.stringify([...env.QUOTA._objects.values()].map((o) => [...o.state.storage._map.entries()]));
  for (const ip of ["203.0.113.7", "198.51.100.22"]) assert.equal(everything.includes(ip), false, ip);
  for (const name of env.QUOTA._names) assert.match(name, /^a:[0-9a-f]{32}$/);
});

test("an anonymous counter is a fresh object each UTC day, so nothing outlives the day", async () => {
  const env = baseEnv();
  const who = { label: "anonymous", tier: "free", keyed: false };
  const req = new Request(ORIGIN + "/v1/verify", { headers: { "cf-connecting-ip": IP } });
  await spendQuota(env, who, req, { now: Date.parse("2026-03-01T12:00:00Z") });
  await spendQuota(env, who, req, { now: Date.parse("2026-03-02T12:00:00Z") });
  assert.equal(env.QUOTA._objects.size, 2, "a new digest, and a new object, at midnight");
  assert.notEqual(env.QUOTA._names[0], env.QUOTA._names[1]);
});

test("the anonymous name is salted, so a digest is not a lookup table over IPv4", async () => {
  const day = utcDay();
  const who = { label: "anonymous", tier: "free", keyed: false };
  const req = new Request(ORIGIN + "/v1/verify", { headers: { "cf-connecting-ip": "203.0.113.7" } });
  const a = await subjectName(who, req, day, { QUOTA_IP_SALT: "salt-one-0123456789abcdef" });
  const b = await subjectName(who, req, day, { QUOTA_IP_SALT: "salt-two-0123456789abcdef" });
  assert.notEqual(a, b, "same IP and day, different salt, different counter");
  assert.match(a, /^a:[0-9a-f]{32}$/);

  // Without the secret the name cannot be reproduced from the address alone.
  const unsalted = await subjectName(who, req, day, { QUOTA_IP_SALT: "" }).catch(() => null);
  assert.equal(unsalted, null, "an absent salt must not silently produce a weaker name");
});

test("a missing salt fails the request OPEN, and never counts against a guessable name", async () => {
  const env = baseEnv({ QUOTA_IP_SALT: undefined });
  const { status, headers } = await allele(env);
  assert.equal(status, 200, "a deployment mistake must not take the API down");
  assert.equal(q(headers).remaining, "unknown");
  assert.equal(env.QUOTA._objects.size, 0, "nothing was counted under an unsalted name");

  const short = baseEnv({ QUOTA_IP_SALT: "tooshort" });
  assert.equal((await allele(short)).status, 200);
  assert.equal(short.QUOTA._objects.size, 0, "a too-short salt is treated as absent");
});

test("two keys never share a counter, and a key is not the anonymous counter", async () => {
  const env = baseEnv();
  await allele(env, keyed(STARTER_KEY));
  await allele(env, keyed(STARTER_KEY));
  const other = await allele(env, keyed(OTHER_STARTER_KEY));
  assert.equal(q(other.headers).remaining, "499");
  const back = await allele(env, keyed(STARTER_KEY));
  assert.equal(q(back.headers).remaining, "497");
  const anon = await allele(env);
  assert.equal(q(anon.headers).remaining, "99");
  assert.equal(env.QUOTA._objects.size, 3);
  // The key itself is never the object name.
  for (const name of env.QUOTA._names.filter((n) => n.startsWith("k:"))) assert.match(name, /^k:[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(env.QUOTA._names).includes(STARTER_KEY), false);
});

test("a legacy pro key gets Lab's quota, Lab's batch cap and Lab's burst limiter", async () => {
  const env = baseEnv();
  const { status, headers } = await allele(env, keyed(PRO_KEY));
  assert.equal(status, 200);
  assert.deepEqual(q(headers), { tier: "pro", limit: "10000", remaining: "9999",
    reset: nextUtcMidnight().toISOString(), maxTypings: "5000" });
  assert.deepEqual(env.RL_LAB.calls, [PRO_KEY], "pro shares lab's 600/min limiter");
  assert.deepEqual(env.RL_SCALE.calls, []);
  // And a batch Starter could not send goes through.
  const big = await post(env, "/v1/normalize", { typings: Array(300).fill("A*01:01") }, keyed(PRO_KEY));
  assert.equal(big.status, 200);
});

test("an academic key gets Lab's quota, Lab's batch cap and Lab's burst limiter", async () => {
  const env = baseEnv();
  const { status, headers } = await allele(env, keyed(ACADEMIC_KEY));
  assert.equal(status, 200);
  assert.deepEqual(q(headers), { tier: "academic", limit: "10000", remaining: "9999",
    reset: nextUtcMidnight().toISOString(), maxTypings: "5000" });
  assert.deepEqual(env.RL_LAB.calls, [ACADEMIC_KEY], "academic shares lab's 600/min limiter");
  assert.deepEqual(env.RL_SCALE.calls, []);
  const big = await post(env, "/v1/normalize", { typings: Array(300).fill("A*01:01") }, keyed(ACADEMIC_KEY));
  assert.equal(big.status, 200);
});

// ------------------------------------------------------------ batch caps

test("the typings cap per call comes from the tier: accepted at it, 422 above it", async () => {
  const env = baseEnv();
  const atCap = await post(env, "/v1/normalize", { typings: Array(250).fill("A*01:01") });
  assert.equal(atCap.status, 200, "free is served exactly at 250");
  assert.equal(atCap.json.rows.length, 250);

  const over = await post(env, "/v1/normalize", { typings: Array(251).fill("A*01:01") });
  assert.equal(over.status, 422);
  assert.match(over.json.detail, /at most 250 items on the free tier \(you sent 251\)/);
  assert.match(over.json.detail, /lab tier \(\$299\/mo\) allows 5,000 per call/);
  assert.match(over.json.detail, /https:\/\/api\.hlaverify\.com\/pricing/);

  const starterOver = await post(env, "/v1/normalize", { typings: Array(251).fill("A*01:01") }, keyed(STARTER_KEY));
  assert.equal(starterOver.status, 422);
  assert.match(starterOver.json.detail, /on the starter tier/);

  const labOk = await post(env, "/v1/normalize", { typings: Array(251).fill("A*01:01") }, keyed(LAB_KEY));
  assert.equal(labOk.status, 200);
  const labOver = await post(env, "/v1/normalize", { typings: Array(5001).fill("A*01:01") }, keyed(LAB_KEY));
  assert.equal(labOver.status, 422);
  assert.match(labOver.json.detail, /at most 5,000 items on the lab tier/);
});

test("MAX_TEXT does not vary by tier — 200,000 characters on free, as published", async () => {
  const env = baseEnv();
  const text = "A*01:01 ".repeat(25_000);            // exactly 200,000 characters
  assert.equal(text.length, 200_000);
  const ok = await post(env, "/v1/verify", { text });
  assert.equal(ok.status, 200);
  const over = await post(env, "/v1/verify", { text: text + "x" });
  assert.equal(over.status, 422);
  assert.match(over.json.detail, /at most 200000 characters/);
});

// -------------------------------------------------------- non-billable

test("nothing that is not a billable call touches the counter", async () => {
  const env = baseEnv();
  for (const p of ["/healthz", "/docs", "/openapi.json", "/pricing", "/checkout/success", "/llms.txt", "/v1/unknown", "/nope"])
    await call(env, "GET", p);
  await post(env, "/v1/beta-signup", { email: "jo@lab.example" });
  await call(env, "OPTIONS", "/v1/verify");
  await post(env, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await post(env, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  await post(env, "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "about" } });
  assert.deepEqual(env.QUOTA._names, [], "no counting subject was ever addressed");

  // And the first billable call afterwards still has the whole day.
  assert.equal(q((await allele(env)).headers).remaining, "99");
});

test("beta-signup is not billable but still answers with the caller's tier", async () => {
  const env = baseEnv();
  const { status, headers } = await post(env, "/v1/beta-signup", { email: "jo@lab.example" });
  assert.equal(status, 200);
  assert.equal(headers.get("x-hla-verify-tier"), "free");
  assert.equal(headers.get("x-hla-verify-daily-limit"), null, "no quota headers where no quota was spent");
});

// ---------------------------------------------------------------- /mcp

const mcpCall = (env, name, args = {}, opts = {}) =>
  post(env, "/mcp", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, opts);

test("an MCP tool call spends the same quota as the REST route, and says so in the headers", async () => {
  const env = baseEnv();
  const first = await mcpCall(env, "normalize_allele", { name: "A*0101" });
  assert.equal(first.status, 200);
  assert.equal(first.json.result.isError, false);
  assert.equal(q(first.headers).remaining, "99");

  // REST and MCP share one counter for the same caller.
  assert.equal(q((await allele(env)).headers).remaining, "98");
  assert.equal(q((await mcpCall(env, "allele_info", { name: "A*01:01" })).headers).remaining, "97");
  assert.equal(env.QUOTA._objects.size, 1);
});

test("over quota on /mcp is a readable JSON-RPC frame, not a broken one", async () => {
  const env = baseEnv();
  await mcpCall(env, "normalize_allele", { name: "A*0101" });
  env.QUOTA.seed(env.QUOTA._names[0], utcDay(), TIER_LIMITS.free.calls);

  const over = await mcpCall(env, "normalize_allele", { name: "A*0101" });
  // 200, not 429: the official MCP client throws SdkHttpError on any non-2xx
  // POST without matching the body to the pending request, so a refusal sent on
  // 429 never reaches the agent as text. The machine-readable signal is in the
  // headers below instead. (REST keeps its 429 — asserted further up.)
  assert.equal(over.status, 200);
  assert.equal(over.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal(q(over.headers).remaining, "0");
  // A well-formed JSON-RPC response carrying a tool error the agent can read.
  assert.equal(over.json.jsonrpc, "2.0");
  assert.equal(over.json.id, 9);
  assert.equal(over.json.error, undefined);
  assert.equal(over.json.result.isError, true);
  assert.equal(over.json.result.structuredContent, undefined);
  assert.equal(over.json.result.content[0].type, "text");
  assert.match(over.json.result.content[0].text, /free tier allows 100 API calls per UTC day/);
  assert.match(over.json.result.content[0].text, /pricing/);

  // The free tools still work when the billable ones are spent.
  const about = await mcpCall(env, "about");
  assert.equal(about.status, 200);
  assert.equal(about.json.result.isError, false);
  assert.match(about.json.result.structuredContent.limits, /free \(free, no key\) 100 calls\/day/);
  assert.match(about.json.result.structuredContent.limits, /'pro' is the legacy name for 'lab'/);
});

test("over quota on the 2026-07-28 era keeps the modern envelope", async () => {
  const env = baseEnv();
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const body = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "verify_text", arguments: { text: "A*01:01" }, _meta: meta } };
  const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "verify_text" };
  const ok = await post(env, "/mcp", body, { headers });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.resultType, "complete");

  env.QUOTA.seed(env.QUOTA._names[0], utcDay(), TIER_LIMITS.free.calls);
  const over = await post(env, "/mcp", body, { headers });
  assert.equal(over.status, 200);
  assert.equal(over.json.result.resultType, "complete");
  assert.equal(over.json.result.isError, true);
  assert.ok(over.json.result._meta["io.modelcontextprotocol/serverInfo"]);
  assert.match(over.json.result.content[0].text, /daily quota exhausted/);
});

test("an MCP call with a key is counted against the key, at the key's tier", async () => {
  const env = baseEnv();
  const { headers } = await mcpCall(env, "allele_info", { name: "A*01:01" }, keyed(LAB_KEY));
  assert.deepEqual(q(headers), { tier: "lab", limit: "10000", remaining: "9999",
    reset: nextUtcMidnight().toISOString(), maxTypings: "5000" });
  assert.match(env.QUOTA._names[0], /^k:/);
});

// -------------------------------------------------------------- fail open

test("a counter that errors fails OPEN: the call is served, remaining is unknown", async () => {
  const env = baseEnv({ QUOTA: fakeQuotaNamespace({ fail: true }) });
  const { status, headers, json } = await allele(env);
  assert.equal(status, 200);
  assert.equal(json.name, "A*01:01");
  assert.equal(q(headers).remaining, "unknown", "never a number the counter cannot stand behind");
  assert.equal(q(headers).limit, "100");
  assert.equal(q(headers).tier, "free");

  const mcp = await mcpCall(env, "allele_info", { name: "A*01:01" });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.json.result.isError, false);
});

test("no QUOTA binding at all (an older deployment) also fails open", async () => {
  const env = baseEnv({ QUOTA: undefined });
  const { status, headers } = await allele(env);
  assert.equal(status, 200);
  assert.equal(q(headers).remaining, "unknown");
  const norm = await post(env, "/v1/normalize", { typings: Array(251).fill("A*01:01") });
  assert.equal(norm.status, 422, "the batch cap still applies without a counter");
});

// ------------------------------------------------- the counter in isolation

test("DailyQuota: counts, refuses at the limit, rolls the day over, and writes only when it must", async () => {
  const storage = memStorage();
  const obj = new DailyQuota({ storage });
  const spend = async (day, limit = 3) =>
    (await obj.fetch(new Request("https://quota.hlaverify.internal/spend",
      { method: "POST", body: JSON.stringify({ day, limit }) }))).json();

  assert.deepEqual(await spend("2026-03-01"), { count: 1, limit: 3, day: "2026-03-01", over: false });
  await spend("2026-03-01");
  assert.deepEqual(await spend("2026-03-01"), { count: 3, limit: 3, day: "2026-03-01", over: false });
  assert.deepEqual(await spend("2026-03-01"), { count: 3, limit: 3, day: "2026-03-01", over: true });
  assert.equal((await storage.get("q")).count, 3, "a refused call is not written as a spent one");

  assert.deepEqual(await spend("2026-03-02"), { count: 1, limit: 3, day: "2026-03-02", over: false });
  // A new day schedules the sweep that stops per-IP-per-day objects piling up.
  assert.ok((await storage.getAlarm()) > Date.parse("2026-03-02T00:00:00Z"));
});

test("DailyQuota: the sweep deletes a finished counter and never a live one", async () => {
  const storage = memStorage();
  const obj = new DailyQuota({ storage });
  await storage.put("q", { day: "2020-01-01", count: 9 });
  await obj.alarm();
  assert.equal(storage._map.size, 0, "a counter whose day is over is deleted");

  await storage.put("q", { day: utcDay(), count: 9 });
  await obj.alarm();
  assert.deepEqual(await storage.get("q"), { day: utcDay(), count: 9 }, "today's counter survives an early alarm");
  assert.ok((await storage.getAlarm()) > Date.now());
});

test("quotaHeaders renders unlimited, unknown and a number distinctly", () => {
  const reset = nextUtcMidnight().toISOString();
  assert.equal(quotaHeaders({ tier: "enterprise", limit: null, remaining: null, reset, maxTypings: 5000 })["x-hla-verify-daily-remaining"], "unlimited");
  assert.equal(quotaHeaders({ tier: "free", limit: 100, remaining: null, reset, maxTypings: 250 })["x-hla-verify-daily-remaining"], "unknown");
  assert.equal(quotaHeaders({ tier: "free", limit: 100, remaining: 0, reset, maxTypings: 250 })["x-hla-verify-daily-remaining"], "0");
});

test("the docs, the OpenAPI document and the pricing page publish the enforced numbers", async () => {
  const env = baseEnv();
  const docs = (await call(env, "GET", "/docs")).text;
  const pricing = (await call(env, "GET", "/pricing")).text;
  const spec = (await call(env, "GET", "/openapi.json")).json;
  for (const page of [docs, pricing]) {
    assert.match(page, /100 calls\/day|100 calls a day/);
    assert.match(page, /10,000/);
    assert.match(page, /1,000,000/);
    assert.match(page, /pro/);
  }
  assert.match(docs, /x-hla-verify-daily-remaining/);
  assert.match(pricing, /UTC day/);
  assert.match(spec.info.description, /free 100 calls\/day per IP and 250 typings/);
  assert.match(spec.paths["/v1/normalize"].post.description, /x-hla-verify-max-typings/);
  assert.equal(spec.paths["/v1/normalize"].post.requestBody.content["application/json"].schema.properties.typings.maxItems, 5000);
});

test("a counter that answers with nonsense is treated as an outage, not as a zero", async () => {
  const env = baseEnv({ QUOTA: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => new Response("{}") }) } });
  const { status, headers } = await allele(env);
  assert.equal(status, 200);
  assert.equal(q(headers).remaining, "unknown", "never NaN, never a fabricated remaining");
});

// ------------------------------------------------- what the review caught

test("a request rejected before its body is read still reports the call it spent", async () => {
  const env = baseEnv();
  const noType = await call(env, "POST", "/v1/verify", { body: "{}" });
  assert.equal(noType.status, 415);
  assert.equal(q(noType.headers).remaining, "99", "charged, and told so");
  const badJson = await call(env, "POST", "/v1/verify", { headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(badJson.status, 400);
  assert.equal(q(badJson.headers).remaining, "98");
  const notObject = await post(env, "/v1/verify", ["nope"]);
  assert.equal(notObject.status, 422);
  assert.equal(q(notObject.headers).remaining, "97");
});

test("the counter fails OPEN on a body it cannot read, never closed", async () => {
  const storage = memStorage();
  const obj = new DailyQuota({ storage });
  const resp = await obj.fetch(new Request("https://quota.hlaverify.internal/spend", { method: "POST", body: "{not json" }));
  assert.equal(resp.status, 500, "an unreadable body is an outage, not a caller over quota");
  assert.equal(storage._map.size, 0, "and nothing was written");

  // Which spendQuota then turns into a served request with an unknown count.
  const env = baseEnv({ QUOTA: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } });
  const { status, headers } = await allele(env);
  assert.equal(status, 200);
  assert.equal(q(headers).remaining, "unknown");
});

test("quota headers are readable cross-origin", async () => {
  const env = baseEnv();
  const exposed = (await allele(env)).headers.get("access-control-expose-headers") || "";
  for (const h of ["x-hla-verify-tier", "x-hla-verify-daily-limit", "x-hla-verify-daily-remaining",
    "x-hla-verify-daily-reset", "x-hla-verify-max-typings", "retry-after"])
    assert.ok(exposed.includes(h), `${h} must be exposed to browser JS`);
  const preflight = await call(env, "OPTIONS", "/v1/verify");
  assert.equal(preflight.status, 204);
  assert.ok((preflight.headers.get("access-control-expose-headers") || "").includes("x-hla-verify-daily-remaining"));
});

test("metering never records a requested allele name as the endpoint label", async () => {
  const seen = [];
  const env = baseEnv({ USAGE: { writeDataPoint: (p) => seen.push(p.blobs[1]) } });
  await call(env, "GET", "/v1/allele/A*01:01");
  env.QUOTA.seed(env.QUOTA._names[0], utcDay(), TIER_LIMITS.free.calls);
  const over = await call(env, "GET", "/v1/allele/A*01:01");
  assert.equal(over.status, 429);
  assert.deepEqual(seen, ["allele", "allele"], "counts per route, never content");
});

test("a keyed caller with no key reference fails open rather than sharing a counter", async () => {
  // subjectName() must not fall back to the label: two unlabelled self-serve
  // keys would then be billed as one subject.
  await assert.rejects(() => subjectName({ keyed: true, tier: "starter" }, null, utcDay(), baseEnv()));
});
