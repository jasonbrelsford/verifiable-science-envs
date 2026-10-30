// Pre-2010 rollover names on POST /v1/normalize, through index.js's real fetch handler.
// A*9201, B*9501 and DPB1*0102 were renamed in 2010 to A*02:101, B*15:101 and DPB1*100:01,
// not to their digits split into pairs (A*92:01 does not exist). The mapping is the release
// history's own (imgt.rollover_of(), from Allelelist_history.txt — the file /v1/translate
// answers from), exported into the rows the Worker reads; an ordinary legacy name keeps
// its mechanical colon form. tests/test_rollover.py asserts the same on the Python side.
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
    const rel = new URL(url).pathname.replace(/^\//, "");
    try {
      return new Response(await readFile(path.join(pub, rel), "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e.code === "ENOENT") return new Response(null, { status: 404 });
      throw e;
    }
  },
};
const env = () => ({
  PUBLIC_ACCESS: "1",
  KEYS: { async get() { return null; }, async put() {} },
  RL: { async limit() { return { success: true }; } },
  QUOTA: {
    idFromName: (n) => n,
    get: () => ({ async fetch(_u, init) { const { day, limit } = JSON.parse(init.body);
      return new Response(JSON.stringify({ count: 1, limit, day, over: false })); } }),
  },
  QUOTA_IP_SALT: "0123456789abcdef0123456789abcdef",
  ASSETS,
});
async function post(p, body) {
  const resp = await worker.fetch(new Request("https://api.hlaverify.com" + p, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
  }), env(), {});
  return { status: resp.status, json: await resp.json() };
}
async function normalize(typings) {
  const r = await post("/v1/normalize", { typings });
  assert.equal(r.status, 200);
  return Object.fromEntries(r.json.rows.map((row) => [row.reported, row]));
}

const ROLLOVERS = [
  ["A*9201", "A*02:101"],
  ["B*9501", "B*15:101"],
  ["DPB1*0102", "DPB1*100:01"],
];

test("normalize: rollover names resolve through the 2010 mapping and say so", async () => {
  const rows = await normalize(ROLLOVERS.map(([l]) => l));
  for (const [legacy, colon] of ROLLOVERS) {
    const r = rows[legacy];
    assert.equal(r.current_name, colon, legacy);
    assert.equal(r.allele_2field, colon, legacy);
    assert.notEqual(r.g_group, "UNRESOLVABLE", legacy);
    assert.deepEqual(r.flags, ["deprecated_name", "legacy_rollover"], legacy);
    assert.deepEqual(Object.keys(r).sort(), ["allele_2field", "current_name", "flags", "g_group", "reported"]);
  }
});

test("normalize: the HLA- prefix on a rollover name changes nothing", async () => {
  const rows = await normalize(["HLA-A*9201"]);
  assert.equal(rows["HLA-A*9201"].current_name, "A*02:101");
  assert.deepEqual(rows["HLA-A*9201"].flags, ["deprecated_name", "legacy_rollover"]);
});

test("normalize: an ordinary legacy name keeps the mechanical colon form", async () => {
  const r = (await normalize(["A*0101"]))["A*0101"];
  assert.equal(r.current_name, "A*01:01");
  assert.equal(r.allele_2field, "A*01:01");
  assert.deepEqual(r.flags, ["deprecated_name"]);
});

test("normalize: a modern name is unchanged and a nonsense name is still UNRESOLVABLE", async () => {
  const rows = await normalize(["A*02:01:01:01", "A*02:101", "A*9999", "A*92:01"]);
  assert.equal(rows["A*02:01:01:01"].current_name, "A*02:01:01:01");
  assert.deepEqual(rows["A*02:01:01:01"].flags, []);
  assert.equal(rows["A*02:101"].current_name, "A*02:101");
  assert.deepEqual(rows["A*02:101"].flags, []);
  for (const bad of ["A*9999", "A*92:01"]) {
    assert.equal(rows[bad].current_name, "UNRESOLVABLE", bad);
    assert.equal(rows[bad].allele_2field, "UNRESOLVABLE", bad);
    assert.ok(rows[bad].flags.includes("nonexistent_allele"), bad);
  }
});

test("normalize agrees with /v1/translate on every rollover", async () => {
  const names = ROLLOVERS.map(([l]) => l);
  const tr = await post("/v1/translate", { names });
  assert.equal(tr.status, 200);
  const rows = await normalize(names);
  for (const t of tr.json.rows) {
    assert.equal(t.status, "renamed", t.name);
    const cur = rows[t.name].current_name;
    assert.ok(t.to_name === cur || t.to_name.startsWith(cur + ":"), `${t.name}: translate ${t.to_name}, normalize ${cur}`);
  }
});
