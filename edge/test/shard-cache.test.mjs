// Shard loading (#157): a cold shard is fetched once however many requests want it at the
// same moment, a batch starts its shard loads together, and a failed load is retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine.js";
import { createHistory } from "../src/history.js";
import manifest from "../public/manifest.json" with { type: "json" };

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const disk = async (sh) => JSON.parse(await readFile(path.join(pub, "data", sh + ".json"), "utf8"));

function counting(delayMs = 20) {
  const calls = { n: 0, live: 0, peak: 0, shards: [] };
  const loadShard = async (sh) => {
    calls.n++; calls.shards.push(sh);
    calls.live++; calls.peak = Math.max(calls.peak, calls.live);
    await new Promise((r) => setTimeout(r, delayMs));
    calls.live--;
    return disk(sh);
  };
  return { calls, loadShard };
}

test("concurrent requests share one load of a cold shard", async () => {
  const { calls, loadShard } = counting();
  const eng = createEngine({ manifest, loadShard });
  const rs = await Promise.all([1, 2, 3, 4].map(() => eng.verify("A*02:01 reported")));
  assert.equal(calls.shards.filter((s) => s === "A/02").length, 1);
  assert.ok(rs.every((r) => r.counts.valid === 1));
});

test("a batch across several shards loads them together, once each", async () => {
  const { calls, loadShard } = counting();
  const eng = createEngine({ manifest, loadShard });
  const out = await eng.normalizeBatch(["A*02:01", "B*07:02", "C*07:02", "A*02:05", "DRB1*15:01"]);
  assert.equal(out.rows.length, 5);
  assert.equal(new Set(calls.shards).size, calls.n, "no shard loaded twice");
  assert.ok(calls.peak >= 4, `shards were loaded in turn (peak ${calls.peak})`);
});

test("verify answers the same warm and cold", async () => {
  const a = createEngine({ manifest, loadShard: disk });
  const b = createEngine({ manifest, loadShard: disk });
  const text = "A*02:01, B*07:02, Cw*07:02, A*02:XX, A*0201, A*02:01g";
  const first = await a.verify(text);
  assert.deepEqual(await a.verify(text), first);
  assert.deepEqual(await b.verify(text), first);
});

test("a failed shard load is not cached", async () => {
  let fail = true, n = 0;
  const eng = createEngine({ manifest, loadShard: async (sh) => { n++; if (fail) throw new Error("boom"); return disk(sh); } });
  await assert.rejects(() => eng.verify("A*02:01"));
  fail = false;
  const r = await eng.verify("A*02:01");
  assert.equal(r.counts.valid, 1);
  assert.ok(n >= 2);
});

test("release diff loads every locus file at once, and only once", async () => {
  const loads = []; let live = 0, peak = 0;
  const hist = createHistory(async (p) => {
    loads.push(p); live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    return JSON.parse(await readFile(path.join(pub, p), "utf8"));
  });
  const r1 = await hist.diff("3.58.0", "3.66.0");
  assert.equal(r1.ok, true);
  const idsLoads = loads.filter((p) => p.startsWith("history/ids/"));
  assert.ok(idsLoads.length > 3 && peak > 3, `loci loaded in turn (peak ${peak})`);
  const before = loads.length;
  const r2 = await hist.diff("3.58.0", "3.66.0");
  assert.deepEqual(r2, r1);
  assert.equal(loads.length, before);
});
