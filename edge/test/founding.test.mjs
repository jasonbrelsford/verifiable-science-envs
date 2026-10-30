// Founding Lab trial keys (scripts/founding_lab.py): a Lab-tier key written
// straight into KEYS with an `expires` date. Driven through index.js's real
// fetch handler with a fake KV, as the other worker tests are.
//
// 1. Before `expires` the key is an ordinary Lab key.
// 2. From `expires` on it is refused with a 401 that says it was a trial and
//    where to keep going, never served at a lower tier and never billed.
// 3. Keys without `expires` (every key issued before this) never expire, and a
//    malformed date does not lock anyone out.
// 4. Containment: a "founding/" trial record can never authenticate as a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { RESERVED_PREFIXES } from "../src/handlers.js";

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

const KEY = "hlv_founding_trial_key_0123456789abcdefghijklmn";
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function env(record, extra = {}) {
  const store = new Map(Object.entries({ [KEY]: JSON.stringify(record), ...extra }));
  const spends = [];
  return {
    PUBLIC_ACCESS: "1",
    KEYS: { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } },
    RL: { async limit() { return { success: true }; } },
    RL_STARTER: { async limit() { return { success: true }; } },
    RL_LAB: { async limit() { return { success: true }; } },
    RL_SCALE: { async limit() { return { success: true }; } },
    QUOTA: {
      idFromName: (n) => n,
      get: (n) => ({ async fetch(_u, init) { const { day, limit } = JSON.parse(init.body); spends.push(n);
        return new Response(JSON.stringify({ count: spends.length, limit, day, over: false })); } }),
      spends,
    },
    QUOTA_IP_SALT: "0123456789abcdef0123456789abcdef",
    ASSETS,
  };
}

async function allele(e, key = KEY) {
  const resp = await worker.fetch(new Request("https://api.hlaverify.com/v1/allele/A*01:01", {
    headers: { "x-api-key": key, "cf-connecting-ip": "203.0.113.7" } }), e, {});
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}

const TRIAL = { label: "founding:Example Hospital HLA Lab", tier: "lab", status: "active", provider: "founding-lab" };

test("a trial key works as a Lab key before it expires", async () => {
  const r = await allele(env({ ...TRIAL, expires: iso(Date.now() + 30 * DAY) }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-hla-verify-tier"), "lab");
});

test("an expired trial key is refused with a 401 that says how to keep going, and is not billed", async () => {
  const e = env({ ...TRIAL, expires: iso(Date.now() - DAY) });
  const r = await allele(e);
  assert.equal(r.status, 401);
  assert.match(r.json.detail, /expired on \d{4}-\d{2}-\d{2}: this was a trial key/);
  assert.match(r.json.detail, /hlaverify\.com\/research/);
  assert.match(r.json.detail, /free during early access/);
  assert.equal(e.QUOTA.spends.length, 0);
});

test("keys without expires never expire, and an unparseable date locks nobody out", async () => {
  assert.equal((await allele(env({ ...TRIAL }))).status, 200);
  assert.equal((await allele(env({ ...TRIAL, expires: "someday" }))).status, 200);
});

test("revoked still wins over an unexpired trial", async () => {
  const r = await allele(env({ ...TRIAL, status: "revoked", expires: iso(Date.now() + DAY) }));
  assert.equal(r.status, 401);
  assert.match(r.json.detail, /revoked/);
});

test("a founding/ trial record can never authenticate as a key", async () => {
  assert.ok(RESERVED_PREFIXES.includes("founding/"));
  const rec = "founding/lab@hospital.example";
  const e = env(TRIAL, { [rec]: JSON.stringify({ email: "lab@hospital.example", lab: "X", status: "trial", key_ref: KEY }) });
  assert.equal((await allele(e, rec)).status, 401);
});
