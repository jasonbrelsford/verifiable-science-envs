// The release-history endpoints (edge/src/history.js), driven through index.js's
// real fetch handler on the files sci_envs/service/history_export.py writes from the
// official Allelelist_history.txt and Deleted_alleles.txt (public/history/).
//
//   GET  /v1/releases                         the releases covered; free
//   POST /v1/translate                        a name as written in release X -> its name in Y
//   GET  /v1/releases/diff?from=&to=          added / removed / renamed between two releases
//   GET  /v1/allele/{name}/history[?as_of=]   every name the allele behind it has had
//
// Facts asserted here are IPD-IMGT/HLA's own: HLA00001 was A*0101 in 1.05.0 and is
// A*01:01:01:01 today; A*24:02:03 became A*24:02:03Q (April 2011).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const manifest = JSON.parse(await readFile(path.join(pub, "manifest.json"), "utf8"));
const meta = JSON.parse(await readFile(path.join(pub, "history", "releases.json"), "utf8"));

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

function env() {
  const spends = [];
  return {
    PUBLIC_ACCESS: "1",
    KEYS: { async get() { return null; }, async put() {} },
    RL: { async limit() { return { success: true }; } },
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
async function call(e, method, p, body) {
  const init = { method, headers: { "cf-connecting-ip": "203.0.113.5" } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const resp = await worker.fetch(new Request("https://api.hlaverify.com" + p, init), e, {});
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}
const translate = (e, body) => call(e, "POST", "/v1/translate", body);
const row = async (e, body) => (await translate(e, body)).json.rows[0];

// ------------------------------------------------------------------ releases

test("GET /v1/releases: oldest to newest, ends at the pinned release, and is free", async () => {
  const e = env();
  const r = await call(e, "GET", "/v1/releases");
  assert.equal(r.status, 200);
  assert.equal(r.json.releases[0], "1.05.0");
  assert.equal(r.json.latest, manifest.release);
  assert.equal(r.json.releases.at(-1), manifest.release);
  assert.equal(r.json.count, r.json.releases.length);
  assert.ok(r.json.loci.includes("A") && r.json.loci.includes("DRB1"));
  assert.equal(e.QUOTA.spends.length, 0, "the release list costs no call");
});

// ------------------------------------------------------------------ translate

test("translate: A*0101 as written in 1.05.0 is A*01:01:01:01 today (HLA00001)", async () => {
  const r = await row(env(), { names: ["A*0101"], from: "1.05.0" });
  assert.deepEqual([r.status, r.to_name, r.hla_id], ["renamed", "A*01:01:01:01", "HLA00001"]);
});

test("translate: to an older release gives the name used then", async () => {
  const r = await row(env(), { names: ["A*01:01:01:01"], from: "3.00.0", to: "2.10.0" });
  assert.deepEqual([r.status, r.to_name], ["renamed", "A*01010101"]);
});

test("translate: unchanged, the expression-suffix rename, and an HLA- prefix", async () => {
  const e = env();
  assert.deepEqual(await row(e, { names: ["A*01:01:01:01"], from: "3.00.0" }),
    { name: "A*01:01:01:01", status: "unchanged", to_name: "A*01:01:01:01", hla_id: "HLA00001" });
  const q = await row(e, { names: ["HLA-A*24:02:03"] });
  assert.deepEqual([q.status, q.to_name, q.hla_id], ["renamed", "A*24:02:03Q", "HLA01616"]);
});

test("translate: a name not used in the from release says where it was used", async () => {
  const r = await row(env(), { names: ["A*0101"], from: "2.25.0" });
  assert.equal(r.status, "not_in_from_release");
  assert.match(r.note, /used in 1\.05\.0–1\.06\.0/);
});

test("translate: a name new in the latest release is not_yet_named in the one before", async () => {
  const d = (await call(env(), "GET", `/v1/releases/diff?from=${meta.releases.at(-2)}&to=${meta.latest}&locus=A&limit=1`)).json;
  const fresh = d.added[0].name;
  const r = await row(env(), { names: [fresh], to: meta.releases.at(-2) });
  assert.equal(r.status, "not_yet_named");
  assert.equal(r.to_name, null);
});

test("translate: a deleted name reports the reason and its successor's name in the target release", async () => {
  // Find, from the data, a name that left the database for good with a named successor.
  const ids = JSON.parse(await readFile(path.join(pub, "history", "ids", "A.json"), "utf8"));
  const last = meta.releases.length - 1;
  let probe = null;
  for (const rec of Object.values(ids)) {
    const end = rec.t.at(-1);
    if (end[1] < last && rec.d && rec.d[end[2]] && rec.d[end[2]].successor) { probe = end[2]; break; }
  }
  assert.ok(probe, "the A locus has at least one deleted name with a successor");
  const r = await row(env(), { names: [probe] });
  assert.equal(r.status, "deleted");
  assert.ok(r.note.length > 0);
  assert.ok(r.successor, "the successor from Deleted_alleles.txt");
});

test("translate: a name never used in any release is unknown, and points to /v1/normalize", async () => {
  const r = await row(env(), { names: ["B*1501"] });
  assert.equal(r.status, "unknown");
  assert.match(r.note, /\/v1\/normalize/);
});

test("translate: counts by status, one call per batch, units per name", async () => {
  const e = env();
  const r = await translate(e, { names: ["A*0101", "A*01:01:01:01", "B*1501"], from: "1.05.0" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.counts, { renamed: 1, not_in_from_release: 1, unknown: 1 });
  assert.equal(r.json.to, meta.latest);
  assert.equal(e.QUOTA.spends.length, 1, "one billable call");
});

test("translate: validation and the batch cap", async () => {
  const e = env();
  for (const [body, re] of [
    [{ names: [] }, /non-empty list/],
    [{ names: "A*01" }, /non-empty list/],
    [{ names: ["A*01"], from: "9.99.0" }, /from must be a release/],
    [{ names: ["A*01"], to: 3 }, /to must be a release/],
    [{ names: Array(251).fill("A*01:01") }, /at most 250 names per call on the free tier/],
  ]) {
    const r = await translate(e, body);
    assert.equal(r.status, 422, JSON.stringify(body).slice(0, 60));
    assert.match(r.json.detail, re);
  }
  assert.equal((await call(e, "GET", "/v1/translate")).status, 405);
});

// ------------------------------------------------------------------ diff

test("diff: names added and renamed between two releases, for one locus", async () => {
  const e = env();
  const from = meta.releases.at(-2), to = meta.latest;
  const r = await call(e, "GET", `/v1/releases/diff?from=${from}&to=${to}&locus=A`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.from, r.json.to, r.json.locus], [from, to, "A"]);
  assert.ok(r.json.counts.added > 0);
  for (const a of r.json.added) assert.match(a.name, /^A\*/);
  for (const x of r.json.renamed) assert.notEqual(x.from_name, x.to_name);
  const again = await call(e, "GET", `/v1/allele/${encodeURIComponent(r.json.added[0].name)}/history`);
  assert.equal(again.json.alleles[0].name_first_release, to, "an added name first appears in the 'to' release");
  assert.equal(e.QUOTA.spends.length, 2);
});

test("diff: reversing the releases swaps added and removed", async () => {
  const a = (await call(env(), "GET", `/v1/releases/diff?from=3.50.0&to=3.60.0&locus=B`)).json;
  const b = (await call(env(), "GET", `/v1/releases/diff?from=3.60.0&to=3.50.0&locus=B`)).json;
  assert.equal(a.counts.added, b.counts.removed);
  assert.equal(a.counts.removed, b.counts.added);
  assert.equal(a.counts.renamed, b.counts.renamed);
});

test("diff: limit truncates every list and says so; validation", async () => {
  const e = env();
  const r = await call(e, "GET", "/v1/releases/diff?from=2.00.0&to=3.66.0&locus=A&limit=3");
  assert.equal(r.json.truncated, true);
  assert.ok(r.json.added.length <= 3 && r.json.renamed.length <= 3);
  for (const [q, re] of [
    ["to=3.66.0", /from and to are both required/],
    ["from=3.65.0&to=1.00.0", /to must be a release/],
    ["from=3.65.0&to=3.66.0&locus=ZZZ", /locus must be one of/],
    ["from=3.65.0&to=3.66.0&limit=5001", /limit must be 1 to 5000/],
  ]) {
    const x = await call(e, "GET", `/v1/releases/diff?${q}`);
    assert.equal(x.status, 422, q);
    assert.match(x.json.detail, re);
  }
});

// ------------------------------------------------------------------ history

test("history: every name HLA00001 has had, oldest first, and its name as of a release", async () => {
  const e = env();
  const r = await call(e, "GET", `/v1/allele/${encodeURIComponent("A*0101")}/history?as_of=2.10.0`);
  assert.equal(r.status, 200);
  const a = r.json.alleles[0];
  assert.equal(a.hla_id, "HLA00001");
  assert.equal(a.current_name, "A*01:01:01:01");
  assert.deepEqual(a.timeline[0], { name: "A*0101", from: "1.05.0", to: "1.06.0" });
  assert.equal(a.timeline.at(-1).name, "A*01:01:01:01");
  assert.equal(a.timeline.at(-1).to, meta.latest);
  assert.deepEqual([a.name_first_release, a.name_last_release], ["1.05.0", "1.06.0"]);
  assert.deepEqual(a.as_of, { release: "2.10.0", name: "A*01010101" });
  assert.equal(e.QUOTA.spends.length, 1, "billable like /v1/allele");
});

test("history: a retired name carries its deletion note", async () => {
  const r = await call(env(), "GET", `/v1/allele/${encodeURIComponent("A*24:02:03")}/history`);
  const a = r.json.alleles[0];
  assert.equal(a.current_name, "A*24:02:03Q");
  assert.match(a.deleted.reason, /Suffix added/);
  assert.equal(a.deleted.successor, "A*24:02:03Q");
});

test("history: unknown names are 404, a bad as_of is 422, and /v1/allele/{name} is unchanged", async () => {
  const e = env();
  assert.equal((await call(e, "GET", `/v1/allele/${encodeURIComponent("A*99:99:99")}/history`)).status, 404);
  const bad = await call(e, "GET", `/v1/allele/${encodeURIComponent("A*0101")}/history?as_of=nope`);
  assert.equal(bad.status, 422);
  assert.match(bad.json.detail, /as_of must be a release/);
  const plain = await call(e, "GET", `/v1/allele/${encodeURIComponent("A*01:01:01:01")}`);
  assert.equal(plain.status, 200);
  assert.equal(plain.json.name, "A*01:01:01:01");
});

// ------------------------------------------------------------------ MCP

async function tool(e, name, args) {
  const resp = await worker.fetch(new Request("https://api.hlaverify.com/mcp", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "203.0.113.5" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), e, {});
  return (await resp.json()).result;
}

test("MCP: translate_names, release_diff and allele_history answer as the REST routes do, and are billable", async () => {
  const e = env();
  const t = await tool(e, "translate_names", { names: ["A*0101"], from: "1.05.0" });
  assert.equal(t.isError, false);
  assert.deepEqual(t.structuredContent.rows[0], (await translate(env(), { names: ["A*0101"], from: "1.05.0" })).json.rows[0]);
  const d = await tool(e, "release_diff", { from: "3.65.0", to: "3.66.0", locus: "A", limit: 2 });
  assert.equal(d.structuredContent.counts.added,
    (await call(env(), "GET", "/v1/releases/diff?from=3.65.0&to=3.66.0&locus=A")).json.counts.added);
  const h = await tool(e, "allele_history", { name: "A*0101", as_of: "2.10.0" });
  assert.equal(h.structuredContent.alleles[0].as_of.name, "A*01010101");
  assert.equal(e.QUOTA.spends.length, 3);
  const bad = await tool(e, "release_diff", { from: "3.65.0" });
  assert.equal(bad.isError, true);
});
