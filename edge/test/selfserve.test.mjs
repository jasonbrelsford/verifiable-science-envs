// Instant self-serve keys: POST /v1/research-access (and its alias /v1/keys)
// with just an email address mints a free_key-tier key and returns it once.
// Driven end to end through index.js's real fetch handler with a fake KV, fake
// rate limiters and a per-name quota counter.
//
// 1. Issuance: the key's shape (same as stripe.js / founding_lab.py), the KV
//    record AT the key, the research/<email> record (status "issued", key_ref),
//    and the response (key once, limits, usage instructions).
// 2. Idempotency: one free key per address; asking again never shows the key.
// 3. Abuse limits: 3 new keys per IP per UTC day (salted digest, no IP stored),
//    disposable inboxes refused, revoked keys refused.
// 4. The key works: x-hla-verify-tier free_key, daily limit 1,000.
// 5. The lab-access job (tower-ops jobs/lab_access.py) selects only status
//    "pending": an issued record must never look like an application.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { RESEARCH_PREFIX, newApiKey, isDisposable, FREE_KEY_TIER, KEY_PROVIDER } from "../src/handlers.js";
import { KEYS_PER_IP_PER_DAY, issuanceName, utcDay } from "../src/quota.js";
import { TIER_LIMITS } from "../src/keys.js";

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
  return { async limit({ key }) { calls.push(key); return { success: allow }; }, calls };
}
function fakeQuota({ fail = false } = {}) {
  const spends = [];
  const counts = new Map();
  return {
    idFromName(name) { return name; },
    get(name) {
      return {
        async fetch(_url, init) {
          if (fail) throw new Error("durable object unreachable");
          const { day, limit } = JSON.parse(init.body);
          spends.push({ name, day, limit });
          const prev = counts.get(name) || 0;
          const over = prev >= limit;
          const count = over ? prev : prev + 1;
          counts.set(name, count);
          return new Response(JSON.stringify({ count, limit, day, over }), { headers: { "content-type": "application/json" } });
        },
      };
    },
    spends,
  };
}

const SALT = "0123456789abcdef0123456789abcdef";
function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    KEYS: fakeKV(),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_LAB: fakeRL(), RL_SCALE: fakeRL(),
    QUOTA: fakeQuota(), QUOTA_IP_SALT: SALT,
    ASSETS,
    ...extra,
  };
}

const ORIGIN = "https://api.hlaverify.com";
const IP = "203.0.113.42";

async function call(env, method, p, { headers = {}, body, ip = IP, country = "GB" } = {}) {
  const h = { "cf-connecting-ip": ip, ...headers };
  if (country !== null) h["cf-ipcountry"] = country;
  const init = { method, headers: h };
  if (body !== undefined) init.body = body;
  const resp = await worker.fetch(new Request(ORIGIN + p, init), env, {});
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}
const getKey = (env, payload, { route = "/v1/research-access", ...opts } = {}) =>
  call(env, "POST", route, { headers: { "content-type": "application/json" }, body: JSON.stringify(payload), ...opts });

const keyRecords = (env) => [...env.KEYS._store.keys()].filter((k) => k.startsWith("hlv_"));
const rec = (env, k) => JSON.parse(env.KEYS._store.get(k));

// ---------------------------------------------------------------- issuance

test("an email address alone gets a free key at once, shown in the response", async () => {
  const env = baseEnv();
  const r = await getKey(env, { email: "New.User@Example.org" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store", "a response carrying a key must never be cached");
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, "issued");
  assert.equal(r.json.tier, FREE_KEY_TIER);
  assert.match(r.json.key, /^hlv_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.key_ref, r.json.key.slice(0, 8));
  assert.deepEqual(r.json.limits, { calls_per_day: 1000, typings_per_call: 250, burst: TIER_LIMITS.free_key.burst });
  assert.equal(r.json.usage.header, "X-API-Key");
  assert.match(r.json.usage.curl, /X-API-Key: YOUR_KEY/);
  assert.equal(r.json.usage.mcp, "https://hlaverify.com/product#mcp");
  assert.deepEqual(JSON.parse(r.json.usage.mcp_config).mcpServers["hla-verify"],
    { url: "https://api.hlaverify.com/mcp", headers: { Authorization: "Bearer YOUR_KEY" } });
  assert.match(r.json.message, /shown once/i);
  assert.match(r.json.message, /1,000 calls a day/);
  assert.match(r.json.message, /Lab tier \(10,000 calls a day/);
  assert.match(r.json.message, /hello@hlaverify\.com/);
  assert.equal(r.json.release, manifest.release);

  // The key record, AT the key, in the format every other minting path writes.
  assert.deepEqual(keyRecords(env), [r.json.key]);
  const k = rec(env, r.json.key);
  assert.deepEqual(Object.keys(k).sort(), ["created", "email", "label", "provider", "status", "tier"]);
  assert.equal(k.tier, "free_key");
  assert.equal(k.status, "active");
  assert.equal(k.provider, KEY_PROVIDER);
  assert.equal(k.provider, "self-serve");
  assert.equal(k.email, "New.User@Example.org");
  assert.equal(k.label, `self-serve:${r.json.key_ref}`, "one label per key, so /v1/usage never pools two keys");
  assert.ok(Date.parse(k.created) > 0);

  // The research/ record: status issued, key_ref only, never the key, never the IP.
  const a = rec(env, `${RESEARCH_PREFIX}new.user@example.org`);
  assert.equal(a.status, "issued");
  assert.equal(a.key_ref, r.json.key_ref);
  assert.equal(a.provider, "self-serve");
  assert.equal(a.country, "GB");
  assert.equal(JSON.stringify(a).includes(r.json.key), false, "the full key is stored only AT the key");
  assert.equal(JSON.stringify(a).includes(IP), false);
  assert.equal(JSON.stringify(k).includes(IP), false);
});

test("POST /v1/keys is an alias, and two requests mint two different keys", async () => {
  const env = baseEnv();
  const a = await getKey(env, { email: "one@example.org" }, { route: "/v1/keys" });
  const b = await getKey(env, { email: "two@example.org" });
  assert.equal(a.json.status, "issued");
  assert.equal(b.json.status, "issued");
  assert.notEqual(a.json.key, b.json.key);
  const keys = new Set(Array.from({ length: 200 }, () => newApiKey()));
  assert.equal(keys.size, 200);
  for (const k of keys) assert.match(k, /^hlv_[A-Za-z0-9_-]{43}$/);
});

test("the issued key works at once: tier free_key, 1,000 calls a day", async () => {
  const env = baseEnv();
  const { json } = await getKey(env, { email: "works@example.org" });
  const v = await call(env, "POST", "/v1/verify", {
    headers: { "content-type": "application/json", "x-api-key": json.key },
    body: JSON.stringify({ text: "HLA-A*02:01" }),
  });
  assert.equal(v.status, 200);
  assert.equal(v.headers.get("x-hla-verify-tier"), "free_key");
  assert.equal(v.headers.get("x-hla-verify-daily-limit"), "1000");
  assert.equal(v.headers.get("x-hla-verify-daily-remaining"), "999");
  assert.equal(v.headers.get("x-hla-verify-max-typings"), "250");
  assert.deepEqual(env.RL_STARTER.calls, [json.key], "60/min burst, per key");
});

test("a revoked self-serve key is refused", async () => {
  const env = baseEnv();
  const { json } = await getKey(env, { email: "revoke-me@example.org" });
  const k = rec(env, json.key);
  env.KEYS._store.set(json.key, JSON.stringify({ ...k, status: "revoked" }));
  const r = await call(env, "GET", "/v1/allele/A*01:01", { headers: { "x-api-key": json.key } });
  assert.equal(r.status, 401);
  assert.match(r.json.detail, /revoked/);
});

// -------------------------------------------------------------- idempotency

test("one free key per address: asking again never shows the key", async () => {
  const env = baseEnv();
  const first = await getKey(env, { email: "Same@Example.org" });
  const again = await getKey(env, { email: "same@example.ORG" }, { ip: "198.51.100.1" });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, "already_issued");
  assert.equal(again.json.key, undefined);
  assert.equal(JSON.stringify(again.json).includes(first.json.key), false);
  assert.equal(again.json.key_ref, first.json.key_ref);
  assert.match(again.json.message, /already issued/i);
  assert.match(again.json.message, /Lost your key\? Email hello@hlaverify\.com/);
  assert.deepEqual(keyRecords(env), [first.json.key], "no second key minted");
  // The first key is untouched (no self-serve re-issue revokes it).
  assert.equal(rec(env, first.json.key).status, "active");
  // A repeat costs nothing from the per-IP issuance cap.
  assert.equal(env.QUOTA.spends.length, 1);
});

test("an address with an approved Lab application is told so, not issued a second key", async () => {
  const env = baseEnv();
  env.KEYS._store.set(`${RESEARCH_PREFIX}pi@lab.example`, JSON.stringify({
    email: "pi@lab.example", institution: "Lab", use_case: "x", status: "approved", key_ref: "hlv_Lab1" }));
  const r = await getKey(env, { email: "PI@lab.example" });
  assert.equal(r.json.status, "already_issued");
  assert.match(r.json.message, /Lab-tier key was already emailed/);
  assert.deepEqual(keyRecords(env), []);
});

test("a pending Lab application gets a free key now and keeps its place in the queue", async () => {
  const env = baseEnv();
  const kvKey = `${RESEARCH_PREFIX}waiting@lab.example`;
  env.KEYS._store.set(kvKey, JSON.stringify({ email: "waiting@lab.example", institution: "Lab", use_case: "x",
    ts: "2026-10-30T00:00:00Z", status: "pending" }));
  const r = await getKey(env, { email: "waiting@lab.example" });
  assert.equal(r.json.status, "issued");
  const a = rec(env, kvKey);
  assert.equal(a.status, "pending", "the lab-access job still sees it");
  assert.equal(a.free_key_ref, r.json.key_ref);
  assert.equal(a.key_ref, undefined, "key_ref is the Lab key's field, written by the job on approval");
  const again = await getKey(env, { email: "waiting@lab.example" });
  assert.equal(again.json.status, "already_issued");
  assert.equal(again.json.key_ref, r.json.key_ref);
});

test("a revoked address gets a 403, not a fresh key", async () => {
  const env = baseEnv();
  env.KEYS._store.set(`${RESEARCH_PREFIX}gone@example.org`, JSON.stringify({ email: "gone@example.org", status: "revoked" }));
  const r = await getKey(env, { email: "gone@example.org" });
  assert.equal(r.status, 403);
  assert.match(r.json.detail, /hello@hlaverify\.com/);
  assert.deepEqual(keyRecords(env), []);
});

test("a free-key holder can apply for the Lab tier; the free key's ref is kept apart", async () => {
  const env = baseEnv();
  const free = await getKey(env, { email: "grow@lab.example" });
  const lab = await getKey(env, { tier: "lab", email: "grow@lab.example", institution: "Grow Lab", use_case: "registry QC" });
  assert.equal(lab.json.status, "recorded");
  const a = rec(env, `${RESEARCH_PREFIX}grow@lab.example`);
  assert.equal(a.status, "pending");
  assert.equal(a.free_key_ref, free.json.key_ref);
  assert.equal(a.key_ref, undefined);
  assert.equal(rec(env, free.json.key).status, "active", "applying does not touch the free key");
  // And applying again is already_recorded; asking for a free key is already_issued.
  assert.equal((await getKey(env, { tier: "lab", email: "grow@lab.example", institution: "G", use_case: "u" })).json.status, "already_recorded");
  assert.equal((await getKey(env, { email: "grow@lab.example" })).json.status, "already_issued");
});

// ------------------------------------------------------------ abuse limits

test(`at most ${KEYS_PER_IP_PER_DAY} new keys per IP per UTC day; other IPs unaffected; no IP stored`, async () => {
  const env = baseEnv();
  for (let i = 0; i < KEYS_PER_IP_PER_DAY; i++) {
    const r = await getKey(env, { email: `farm${i}@example.org` });
    assert.equal(r.json.status, "issued", `key ${i + 1}`);
  }
  const over = await getKey(env, { email: "farm9@example.org" });
  assert.equal(over.status, 429);
  assert.match(over.json.detail, /at most 3 new keys a day from one connection/);
  assert.equal(env.KEYS._store.has(`${RESEARCH_PREFIX}farm9@example.org`), false);
  assert.equal(keyRecords(env).length, KEYS_PER_IP_PER_DAY);

  // A different connection is counted separately.
  assert.equal((await getKey(env, { email: "elsewhere@example.org" }, { ip: "198.51.100.77" })).json.status, "issued");

  // The counter is named by a salted digest of the day and the IP: never the IP.
  const names = [...new Set(env.QUOTA.spends.map((x) => x.name))];
  assert.equal(names.length, 2);
  for (const n of names) {
    assert.match(n, /^i:[0-9a-f]{32}$/);
    assert.equal(n.includes(IP), false);
  }
  assert.equal(names[0], await issuanceName(IP, utcDay(), { QUOTA_IP_SALT: SALT }));
  assert.notEqual(names[0], await issuanceName(IP, utcDay(), { QUOTA_IP_SALT: SALT.replace("0", "f") }), "salted");
  assert.ok(env.QUOTA.spends.every((x) => x.limit === KEYS_PER_IP_PER_DAY));
  for (const v of env.KEYS._store.values()) assert.equal(v.includes(IP), false);
});

test("a counter outage fails open: a key is still issued", async () => {
  const env = baseEnv({ QUOTA: fakeQuota({ fail: true }) });
  assert.equal((await getKey(env, { email: "outage@example.org" })).json.status, "issued");
});

test("the per-minute limiter still covers the route", async () => {
  const env = baseEnv({ RL: fakeRL(false) });
  const r = await getKey(env, { email: "fast@example.org" });
  assert.equal(r.status, 429);
  assert.deepEqual(keyRecords(env), []);
});

test("disposable inboxes are refused; ordinary and relay addresses are not", async () => {
  for (const e of ["x@mailinator.com", "x@sub.mailinator.com", "x@YOPMAIL.com", "x@10minutemail.net",
    "x@guerrillamail.org", "x@my-tempmail.xyz", "x@throwaway.email"]) {
    assert.equal(isDisposable(e), true, e);
  }
  for (const e of ["x@gmail.com", "x@lab.example", "x@uni.ac.uk", "x@duck.com", "x@privaterelay.appleid.com"]) {
    assert.equal(isDisposable(e), false, e);
  }
  const env = baseEnv();
  const r = await getKey(env, { email: "farmer@mailinator.com" });
  assert.equal(r.status, 422);
  assert.match(r.json.detail, /disposable/);
  assert.equal(env.QUOTA.spends.length, 0, "a refused address does not spend the IP's allowance");
  assert.deepEqual([...env.KEYS._store.keys()], []);
});

test("bad input is refused before anything is written", async () => {
  const env = baseEnv();
  for (const [body, re] of [
    [{}, /email must be a string/],
    [{ email: "nope" }, /email must look like an address/],
    [{ email: "a@b.cc", tier: "enterprise" }, /tier must be omitted/],
    [{ email: "a@b.cc", institution: "x".repeat(201) }, /institution must be at most 200/],
  ]) {
    const r = await getKey(env, body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.match(r.json.detail, re);
  }
  assert.deepEqual([...env.KEYS._store.keys()], []);
});

// -------------------------------------------------------------------- MCP

test("MCP research_access issues the key in the tool result", async () => {
  const env = baseEnv();
  const resp = await call(env, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "research_access", arguments: { email: "agent-user@example.org", source: "mcp" } } }),
  });
  const sc = resp.json.result.structuredContent;
  assert.equal(resp.json.result.isError, false);
  assert.equal(sc.status, "issued");
  assert.match(sc.key, /^hlv_/);
  assert.equal(rec(env, sc.key).tier, "free_key");
  // The MCP path is under the same per-IP cap.
  assert.equal(env.QUOTA.spends.length, 1);
  assert.match(env.QUOTA.spends[0].name, /^i:/);
});

// ------------------------------------------- tower-ops lab-access contract

test("an issued record is never a pending application (jobs/lab_access.py selects status == pending)", async () => {
  const env = baseEnv();
  await getKey(env, { email: "selfserve@example.org" });
  const a = rec(env, `${RESEARCH_PREFIX}selfserve@example.org`);
  // lab_access.py sweep(): rec.get("status", "pending") == "pending"
  const pendingInJob = (r) => (r.status ?? "pending") === "pending";
  assert.equal(pendingInJob(a), false);
  assert.equal(a.status, "issued");
});
