// Unmet-request classification (src/unmet.js) and its wiring into metering
// (index.js meter(), mcp.js runTool()).
//
// What must hold:
// 1. Each class fires on the input shape it is for, and only there: a request
//    the service fully served contributes zeros; a valid allele never counts.
// 2. Nothing written to the data point is request content: blob8 carries only
//    a sanitised class=value from a closed or gene-symbol-shaped set, and the
//    anonymous caller bucket is a salted per-day digest, never an address.
// 3. The REST route and the mirrored MCP tool produce the same classification
//    for the same input, and refusals (422 framework, 422 batch cap, 429 quota,
//    unknown MCP tool) are metered with their class.
// 4. The report aggregation and the score behave as documented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { createEngine } from "../src/engine.js";
import { UNMET_CLASSES, CLASS_INDEX, DOUBLE_OFFSET, BUCKET_BLOB, VALUE_BLOB, summarizeUnmet, rejectionUnmet,
  callerBucket, ANON_BUCKET, cleanupCandidates, isSerologyShaped, isAlleleList, isKirShaped, sanitizeLocus, sanitizeFramework,
  sanitizeTool, scoreUnmet, verdictUnmet, aggregateUnmet, emptyCounts } from "../src/unmet.js";
import { handleMcp } from "../src/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const manifest = JSON.parse(await readFile(path.join(pub, "manifest.json"), "utf8"));
assert.ok(Array.isArray(manifest.loci) && manifest.loci.includes("A") && manifest.loci.includes("DRB1"),
  "manifest.loci is written by sci_envs/service/edge_export.py; re-run the export");

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
const eng = createEngine({ manifest, loadShard: async (sh) => { const r = await ASSETS.fetch(`https://assets.local/data/${sh}.json`); return r.ok ? r.json() : null; } });

// Counts as {class: n} for readable assertions.
const hits = (u) => Object.fromEntries(u.counts.map((c, i) => [UNMET_CLASSES[i].id, c]).filter(([, c]) => c > 0));
const SALT = "0123456789abcdef0123456789abcdef";

// ------------------------------------------------------------- the schema
test("the class table fits Analytics Engine and every class has its product fields", () => {
  assert.ok(UNMET_CLASSES.length + DOUBLE_OFFSET - 1 <= 20, "at most 20 doubles");
  assert.equal(new Set(UNMET_CLASSES.map((c) => c.id)).size, UNMET_CLASSES.length, "ids unique");
  for (const c of UNMET_CLASSES) {
    assert.ok(["feature", "pricing"].includes(c.kind), c.id);
    assert.ok(c.feasibility > 0 && c.feasibility <= 1, c.id);
    for (const k of ["title", "seen", "would_take"]) assert.ok(typeof c[k] === "string" && c[k].length > 10, `${c.id}.${k}`);
  }
  assert.equal(CLASS_INDEX.mac_code, 0);
  assert.equal(BUCKET_BLOB, 7);
  assert.equal(VALUE_BLOB, 8);
});

// ------------------------------------------------------------- shape tests
test("shape tests: serology, allele lists, KIR, star-dropped and fields-only names", () => {
  for (const s of ["A2", "B44", "Cw6", "DR4", "DQ2", "DP1", "Bw4", "DR53", "A203", "B2708", "hla-a2"]) assert.equal(isSerologyShaped(s), true, s);
  for (const s of ["A*02", "A*02:01", "A0201", "DRB1", "banana", "2"]) assert.equal(isSerologyShaped(s), false, s);
  assert.equal(isSerologyShaped("2", "A"), true, "bare antigen number under a serology key");
  assert.equal(isSerologyShaped("44", "HLA-B"), true);
  assert.equal(isSerologyShaped("0201", "A"), false, "leading zero is allele digits, not an antigen");
  assert.equal(isSerologyShaped("2", "KIR2DL1"), false);

  assert.equal(isAlleleList("A*02:01/A*02:05"), true);
  assert.equal(isAlleleList("A*02:01/02:05/02:07"), true);
  assert.equal(isAlleleList("HLA-A*02:01/HLA-A*02:05N"), true);
  assert.equal(isAlleleList("02:01/02:05", "A"), true, "fields-only list under a locus key");
  assert.equal(isAlleleList("02:01/02:05"), false, "fields-only list with no locus is not recognised");
  assert.equal(isAlleleList("A*02:01"), false);
  assert.equal(isAlleleList("A*02:01/banana"), false);

  for (const s of ["KIR2DL1", "KIR2DL1*001", "2DL1", "3DL1*00101", "KIR2DL5A", "DL1*001"]) assert.equal(isKirShaped(s), true, s);
  for (const s of ["DP1", "DPB1*04:01", "A*02:01", "DL1"]) assert.equal(isKirShaped(s), false, s);
});

test("cleanupCandidates names each fix and leaves a clean name alone", () => {
  assert.equal(cleanupCandidates("A*02:01"), null);
  assert.equal(cleanupCandidates("HLA-A*02:01"), null, "the HLA- prefix is accepted already, not a fix");
  assert.deepEqual(cleanupCandidates("a*02:01"), { candidates: ["A*02:01"], fixes: ["case"] });
  assert.deepEqual(cleanupCandidates("A*02 :01"), { candidates: ["A*02:01"], fixes: ["space"] });
  assert.deepEqual(cleanupCandidates("Cw*07:01"), { candidates: ["C*07:01"], fixes: ["cw"] });
  assert.deepEqual(cleanupCandidates("DRB1 04:01"), { candidates: ["DRB1*04:01"], fixes: ["star"] });
  assert.deepEqual(cleanupCandidates("A0201"), { candidates: ["A*0201"], fixes: ["star"] });
  assert.deepEqual(cleanupCandidates("DRB10401N"), { candidates: ["DRB1*0401N"], fixes: ["star"] });
  assert.deepEqual(cleanupCandidates("02:01", "A"), { candidates: ["A*02:01"], fixes: ["locus"] });
  assert.deepEqual(cleanupCandidates("0201", "HLA-A"), { candidates: ["A*0201"], fixes: ["locus"] });
  assert.deepEqual(cleanupCandidates("a*02:01:01g"), { candidates: ["A*02:01:01g", "A*02:01:01G"], fixes: ["case"] });
  assert.deepEqual(cleanupCandidates("hla-cw*07 :01"), { candidates: ["C*07:01"], fixes: ["case", "cw", "space"] });
});

test("value sanitisers admit only short gene-symbol, framework and tool-name tokens", () => {
  assert.equal(sanitizeLocus("KIR2DL1"), "KIR2DL1");
  assert.equal(sanitizeLocus("abo"), "ABO");
  assert.equal(sanitizeLocus("John Smith MRN 12345678"), "JOHNSMITHMRN");
  assert.equal(sanitizeLocus(""), "other");
  assert.equal(sanitizeFramework("9/10"), "9/10");
  assert.equal(sanitizeFramework(" TCE "), "tce");
  assert.equal(sanitizeFramework("patient John Smith"), "other");
  assert.equal(sanitizeFramework({ a: 1 }), "other");
  assert.equal(sanitizeTool("expand_mac_code"), "expand_mac_code");
  assert.equal(sanitizeTool("Get Patient Record"), "other");
  assert.equal(sanitizeTool("x".repeat(60)), "other");
});

// ------------------------------------------------------- per-endpoint classification
async function classifyNormalize(s) {
  const body = await eng.normalizeBatch([s]);
  return summarizeUnmet(eng, manifest, "normalize", { typings: [s] }, body);
}

test("normalize: each unmet shape lands in its class; served names contribute nothing", async () => {
  const expect = {
    "A*02:AB": { mac_code: 1 },
    "a*02:01": { format_variant: 1 },
    "A*02 :01": { format_variant: 1 },
    "Cw*07:01": { format_variant: 1 },
    "DRB1 04:01": { format_variant: 1 },
    "A0201": { format_variant: 1 },
    "DRB10401": { format_variant: 1 },
    "a*02:01:01g": { format_variant: 1 },
    "A2": { serology: 1 },
    "DR4": { serology: 1 },
    "Bw4": { serology: 1 },
    "A*02:01/A*02:05": { allele_list: 1 },
    "A*02:01/02:05": { allele_list: 1 },
    "KIR2DL1*001": { unknown_locus: 1 },
    "2DL1": { unknown_locus: 1 },
    "ABO*A1": { unknown_locus: 1 },
    "A*99:99": { unknown_allele: 1 },
    "DRB1*99:01N": { unknown_allele: 1 },
    "banana": { unresolvable_other: 1 },
    // fully served, whatever the shorthand
    "A*02:01": {}, "A*02": {}, "A*02:XX": {}, "A*02:01g": {}, "A*0201": {}, "HLA-A*02:01:01:01": {},
    "DPB1*04:01P": {}, "A*02:01:01G": {}, "A*24:09N": {},
  };
  for (const [s, want] of Object.entries(expect)) {
    const u = await classifyNormalize(s);
    assert.deepEqual(hits(u), want, s);
  }
});

test("normalize: blob8 value names the fix, the locus, never the string", async () => {
  assert.equal((await classifyNormalize("a*02 :01")).value, "format_variant=case+space");
  assert.equal((await classifyNormalize("Cw*07:01")).value, "format_variant=cw");
  assert.equal((await classifyNormalize("KIR2DL1*001")).value, "unknown_locus=KIR");
  assert.equal((await classifyNormalize("ABO*A1")).value, "unknown_locus=ABO");
  assert.equal((await classifyNormalize("A*99:99")).value, "", "unknown_allele carries no value: the name is content");
  assert.equal((await classifyNormalize("banana")).value, "");
  assert.equal((await classifyNormalize("A2")).value, "");
});

test("typing/check: bare antigen numbers and fields-only names read against their locus key; an unknown key counts once", async () => {
  const typing = { A: ["02:01", "0201"], B: ["44", "B*44:02"], C: ["7", "Cw*07:01"], DRB1: ["4", "DRB1*04:01"],
    KIR2DL1: ["KIR2DL1*001", "KIR2DL1*002"], DQA1: ["DQA1*01:01", "DQA1*05:01"] };
  const body = await eng.checkTyping(typing);
  const u = await summarizeUnmet(eng, manifest, "typing/check", { typing }, body);
  assert.deepEqual(hits(u), { format_variant: 3, serology: 3, unknown_locus: 1 });
  assert.equal(u.value, "unknown_locus=KIR");
});

test("match: low-resolution typing at an allele-level locus, and loci the framework does not score", async () => {
  const rec = { A: ["A*02", "A*24:02"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "C*07:02"], DRB1: ["DRB1*15:01", "DRB1*03:01"],
    DQA1: ["DQA1*01:02", "DQA1*05:01"], DPB1: ["DPB1*04:01", "DPB1*02:01"] };
  const don = { A: ["A*02:XX", "A*24:02"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "C*07:02"], DRB1: ["DRB1*15:01", "DRB1*03:01"],
    DQA1: ["DQA1*01:02", "DQA1*05:01"], MICA: ["MICA*008"] };
  const body = await eng.match("8/8", rec, don);
  assert.equal(body.verdicts.A, "potential");
  const u = await summarizeUnmet(eng, manifest, "match", { framework: "8/8", recipient: rec, donor: don }, body);
  assert.deepEqual(hits(u), { low_resolution: 2, extra_loci: 4 });
  assert.equal(u.value, "extra_loci=DQA1");
  // 12/12 scores DPB1, and antigen-level A accepts A*02: fewer gaps for the same typing
  const u2 = await summarizeUnmet(eng, manifest, "match", { framework: "12/12", recipient: rec, donor: don }, await eng.match("12/12", rec, don));
  assert.deepEqual(hits(u2), { low_resolution: 2, extra_loci: 3 });
  const u3 = await summarizeUnmet(eng, manifest, "match", { framework: "6/6", recipient: rec, donor: don }, await eng.match("6/6", rec, don));
  assert.equal(hits(u3).low_resolution, undefined, "A*02 is a usable antigen-level typing");
});

test("match: MICA*008 (a one-field assigned allele) is not low resolution", async () => {
  const t = { A: ["A*02:01", "A*24:02"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "C*07:02"], DRB1: ["DRB1*15:01", "DRB1*03:01"] };
  const u = await summarizeUnmet(eng, manifest, "match", { framework: "8/8", recipient: t, donor: t }, await eng.match("8/8", t, t));
  assert.deepEqual(hits(u), {});
});

test("verify: fabricated tokens split by locus; MAC codes counted; a clean report contributes zeros", async () => {
  const text = "Typed A*02:01, B*44:02, A*99:99, KIR2DL1*001, A*02:AB, DRB1*04:01:01G, DRB1*04:01:99G and HLA-X*01:01.";
  const body = await eng.verify(text);
  const u = await summarizeUnmet(eng, manifest, "verify", { text }, body);
  assert.deepEqual(hits(u), { mac_code: 1, unknown_locus: 2, unknown_allele: 2 });
  assert.equal(u.value, "unknown_locus=KIR", "an out_of_scope KIR token is still counted as the KIR gap");
  assert.deepEqual(body.tokens.filter((t) => t.status === "out_of_scope").map((t) => t.token), ["KIR2DL1*001"]);
  assert.equal(body.tokens.some((t) => t.token === "DL1*001"), false, "no fragment of a KIR name is read as an HLA name");
  const clean = await eng.verify("A*02:01 and B*44:02 and DRB1*04:01:01G");
  assert.deepEqual(hits(await summarizeUnmet(eng, manifest, "verify", {}, clean)), {});
});

test("glstring, allele and compat classify their unresolvable tokens the same way", async () => {
  const gl = "HLA-A*02:01+HLA-A*02:AB^HLA-B*44:02+HLA-B*99:99^KIR2DL1*001+KIR2DL1*002";
  const g = await summarizeUnmet(eng, manifest, "glstring", { gl }, await eng.glString(gl));
  assert.deepEqual(hits(g), { mac_code: 1, unknown_locus: 2, unknown_allele: 1 });

  for (const [name, want] of [["A*02:AB", { mac_code: 1 }], ["A*99:99", { unknown_allele: 1 }], ["a*02:01", { format_variant: 1 }],
    ["A2", { serology: 1 }], ["KIR2DL1*001", { unknown_locus: 1 }], ["A*02:01", {}], ["A*02:01:01G", {}]]) {
    const r = await eng.allele(name);
    assert.deepEqual(hits(await summarizeUnmet(eng, manifest, "allele", { name }, r.body)), want, name);
  }

  const rec = { A: ["A*02:01", "a*24:02"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "C*07:02"] };
  const don = { A: ["A*02:01", "A*24:02"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "Cw*07:02"] };
  const c = await summarizeUnmet(eng, manifest, "compat", { recipient: rec, donor: don }, await eng.compat(rec, don));
  assert.deepEqual(hits(c), { format_variant: 2 });
});

test("summarizeUnmet never throws on garbage and bounds its re-work", async () => {
  assert.deepEqual(await summarizeUnmet(eng, manifest, "match", null, null), { counts: emptyCounts(), value: "" });
  assert.deepEqual(await summarizeUnmet(eng, manifest, "nope", {}, {}), { counts: emptyCounts(), value: "" });
  assert.deepEqual(await summarizeUnmet(eng, manifest, "typing/check", { typing: 5 }, { loci: 5 }), { counts: emptyCounts(), value: "" });
  const many = Array.from({ length: 1000 }, (_, i) => `a*02:0${i % 9 + 1}`);
  const u = await summarizeUnmet(eng, manifest, "normalize", { typings: many }, await eng.normalizeBatch(many));
  const total = u.counts.reduce((a, b) => a + b, 0);
  assert.ok(total <= 200 && total > 0, `re-work is capped (${total})`);
});

test("rejectionUnmet: one class, a sanitised value for the two that carry one", () => {
  assert.deepEqual(hits(rejectionUnmet("quota_exceeded")), { quota_exceeded: 1 });
  assert.deepEqual(hits(rejectionUnmet("batch_over_cap")), { batch_over_cap: 1 });
  const f = rejectionUnmet("framework_unsupported", "9/10");
  assert.deepEqual(hits(f), { framework_unsupported: 1 });
  assert.equal(f.value, "framework_unsupported=9/10");
  assert.equal(rejectionUnmet("framework_unsupported", "John Smith").value, "framework_unsupported=other");
  assert.equal(rejectionUnmet("mcp_unknown_tool", "expand_mac").value, "mcp_unknown_tool=expand_mac");
  assert.deepEqual(rejectionUnmet("not_a_class"), { counts: emptyCounts(), value: "" });
});

// ------------------------------------------------------------- caller bucket
test("callerBucket: label for keyed callers; one shared bucket for anonymous callers unless the owner switches per-day digests on", async () => {
  const req = (ip) => new Request("https://assets.local/v1/verify", { headers: { "cf-connecting-ip": ip } });
  assert.equal(await callerBucket({ keyed: true, label: "customer-a", tier: "lab" }, req("1.2.3.4"), { QUOTA_IP_SALT: SALT }), "k:customer-a");
  const anon = { keyed: false, label: "anonymous", tier: "free" };
  // default: the privacy page's row, unchanged — no per-address anything
  assert.equal(await callerBucket(anon, req("1.2.3.4"), { QUOTA_IP_SALT: SALT }), ANON_BUCKET);
  assert.equal(await callerBucket(anon, req("1.2.3.4"), {}), ANON_BUCKET);
  assert.equal(await callerBucket(anon, req("1.2.3.4"), { UNMET_ANON_BUCKETS: "0", QUOTA_IP_SALT: SALT }), ANON_BUCKET);
  // switched on: a salted per-day digest, never the address
  const on = { UNMET_ANON_BUCKETS: "1", QUOTA_IP_SALT: SALT };
  const b1 = await callerBucket(anon, req("1.2.3.4"), on, Date.parse("2026-10-04T10:00:00Z"));
  assert.match(b1, /^a:[0-9a-f]{16}$/);
  assert.ok(!b1.includes("1.2.3.4"));
  assert.equal(await callerBucket(anon, req("1.2.3.4"), on, Date.parse("2026-10-04T23:59:00Z")), b1, "stable within the day");
  assert.notEqual(await callerBucket(anon, req("1.2.3.4"), on, Date.parse("2026-10-05T00:01:00Z")), b1, "a new bucket each UTC day");
  assert.notEqual(await callerBucket(anon, req("1.2.3.5"), on, Date.parse("2026-10-04T10:00:00Z")), b1);
  assert.notEqual(await callerBucket(anon, req("1.2.3.4"), { ...on, QUOTA_IP_SALT: "x".repeat(32) }, Date.parse("2026-10-04T10:00:00Z")), b1, "salt-dependent");
  assert.equal(await callerBucket(anon, req("1.2.3.4"), { UNMET_ANON_BUCKETS: "1" }), ANON_BUCKET, "no salt: back to the shared bucket, never the address");
  assert.equal(await callerBucket(anon, req("1.2.3.4"), { UNMET_ANON_BUCKETS: "1", QUOTA_IP_SALT: "short" }), ANON_BUCKET);
  assert.equal(await callerBucket(null, req("1.2.3.4"), {}), "");
});

// ------------------------------------------------------------- wiring: REST
function captureEnv(extra = {}) {
  const points = [];
  return { points, env: { ASSETS, QUOTA_IP_SALT: SALT, UNMET_ANON_BUCKETS: "1", USAGE: { writeDataPoint: (p) => points.push(p) }, ...extra } };
}
const post = (p, body, headers = {}) => new Request(`https://assets.local${p}`,
  { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...headers }, body: JSON.stringify(body) });
const classesOf = (point) => Object.fromEntries(point.doubles.slice(DOUBLE_OFFSET - 1).map((c, i) => [UNMET_CLASSES[i].id, c]).filter(([, c]) => c > 0));

test("REST: the data point carries the bucket, the value and one double per class; a served request is all zeros", async () => {
  const { points, env } = captureEnv();
  let resp = await worker.fetch(post("/v1/normalize", { typings: ["A*02:01", "a*24:02", "A*02:AB"] }), env, {});
  assert.equal(resp.status, 200);
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.blobs.length, 8);
  assert.equal(p.blobs[1], "normalize");
  assert.match(p.blobs[BUCKET_BLOB - 1], /^a:[0-9a-f]{16}$/);
  assert.equal(p.blobs[VALUE_BLOB - 1], "format_variant=case");
  assert.equal(p.doubles.length, 2 + UNMET_CLASSES.length);
  assert.equal(p.doubles[0], 3, "units unchanged");
  assert.deepEqual(classesOf(p), { mac_code: 1, format_variant: 1 });
  for (const b of p.blobs) assert.ok(!b.includes("a*24:02") && !b.includes("A*02:AB"), "no content in blobs");

  resp = await worker.fetch(post("/v1/normalize", { typings: ["A*02:01", "B*44:02"] }), env, {});
  assert.equal(resp.status, 200);
  assert.deepEqual(classesOf(points[1]), {});
  assert.equal(points[1].blobs[VALUE_BLOB - 1], "");
});

test("REST: by default an anonymous caller's bucket is the shared constant — the metering row gains counts and nothing per-address", async () => {
  const { points, env } = captureEnv({ UNMET_ANON_BUCKETS: undefined });
  await worker.fetch(post("/v1/normalize", { typings: ["A*02:AB"] }), env, {});
  assert.equal(points[0].blobs[BUCKET_BLOB - 1], ANON_BUCKET);
  assert.deepEqual(classesOf(points[0]), { mac_code: 1 });
});

test("REST: a keyed caller's bucket is its label", async () => {
  const { points, env } = captureEnv({ HLA_VERIFY_API_KEYS: "k1=customer-a:lab" });
  await worker.fetch(post("/v1/verify", { text: "A*02:01 and A*99:99" }, { "x-api-key": "k1" }), env, {});
  assert.equal(points[0].blobs[BUCKET_BLOB - 1], "k:customer-a");
  assert.deepEqual(classesOf(points[0]), { unknown_allele: 1 });
});

test("REST: 422 refusals that are product signals are metered with their class", async () => {
  const { points, env } = captureEnv();
  const t = { A: ["A*02:01", "A*24:02"] };
  let resp = await worker.fetch(post("/v1/match", { framework: "9/10", recipient: t, donor: t }), env, {});
  assert.equal(resp.status, 422);
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[3], "422");
  assert.deepEqual(classesOf(points[0]), { framework_unsupported: 1 });
  assert.equal(points[0].blobs[VALUE_BLOB - 1], "framework_unsupported=9/10");

  const big = Array.from({ length: 251 }, () => "A*02:01");   // free tier cap is 250 per call (keys.js)
  resp = await worker.fetch(post("/v1/normalize", { typings: big }), env, {});
  assert.equal(resp.status, 422);
  assert.deepEqual(classesOf(points[1]), { batch_over_cap: 1 });

  // malformed input is not a product signal: metered as a plain 422 with zeros
  resp = await worker.fetch(post("/v1/verify", { text: 5 }), env, {});
  assert.equal(resp.status, 422);
  assert.deepEqual(classesOf(points[2]), {});
});

test("REST: the daily-quota 429 is metered as quota_exceeded", async () => {
  // A QUOTA binding whose counter always says "over".
  const QUOTA = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ count: 999, over: true })) }) };
  const { points, env } = captureEnv({ QUOTA });
  const resp = await worker.fetch(post("/v1/verify", { text: "A*02:01" }), env, {});
  assert.equal(resp.status, 429);
  assert.deepEqual(classesOf(points[0]), { quota_exceeded: 1 });
});

test("REST: classification runs after the response when the runtime offers waitUntil", async () => {
  const { points, env } = captureEnv();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const resp = await worker.fetch(post("/v1/normalize", { typings: ["a*02:01"] }), env, ctx);
  assert.equal(resp.status, 200);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(classesOf(points[0]), { format_variant: 1 });
});

// ------------------------------------------------------------- wiring: MCP
const rpc = (name, args) => new Request("https://assets.local/mcp", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});

test("MCP: the same input classifies the same as its /v1 route, through the onCall hook", async () => {
  const calls = [];
  const who = { label: "anonymous", tier: "free", keyed: false };
  const hook = (tool, status, units, unmet) => calls.push({ tool, status, units, unmet });
  await handleMcp(rpc("normalize_allele", { name: "Cw*07:01" }), eng, who, manifest, hook);
  await handleMcp(rpc("check_typing", { typing: { A: ["2", "A*24:02"], KIR2DL1: ["KIR2DL1*001"] } }), eng, who, manifest, hook);
  await handleMcp(rpc("match_score", { framework: "9/10", recipient: { A: ["A*02:01"] }, donor: { A: ["A*02:01"] } }), eng, who, manifest, hook);
  await handleMcp(rpc("about", {}), eng, who, manifest, hook);
  assert.equal(calls.length, 4);
  assert.deepEqual(hits(calls[0].unmet), { format_variant: 1 });
  assert.equal(calls[0].unmet.value, "format_variant=cw");
  assert.deepEqual(hits(calls[1].unmet), { serology: 1, unknown_locus: 1 });
  assert.equal(calls[2].status, 422);
  assert.deepEqual(hits(calls[2].unmet), { framework_unsupported: 1 });
  assert.equal(calls[2].unmet.value, "framework_unsupported=9/10");
  assert.deepEqual(hits(calls[3].unmet), {});
});

test("MCP: an unknown tool name is the signal — recorded sanitised, never as free text", async () => {
  const calls = [];
  const who = { label: "anonymous", tier: "free", keyed: false };
  const hook = (tool, status, units, unmet) => calls.push({ tool, status, units, unmet });
  const resp = await handleMcp(rpc("expand_mac_code", { code: "A*02:AB" }), eng, who, manifest, hook);
  const body = await resp.json();
  assert.equal(body.result.isError, true);
  assert.deepEqual(hits(calls[0].unmet), { mcp_unknown_tool: 1 });
  assert.equal(calls[0].unmet.value, "mcp_unknown_tool=expand_mac_code");
  await handleMcp(rpc("Look up John Smith", {}), eng, who, manifest, hook);
  assert.equal(calls[1].unmet.value, "mcp_unknown_tool=other");
});

test("MCP over the Worker: the data point for a tool call carries the bucket and the classes", async () => {
  const { points, env } = captureEnv();
  const resp = await worker.fetch(rpc("normalize_allele", { name: "A*02:AB" }), env, {});
  assert.equal(resp.status, 200);
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[1], "mcp:normalize_allele");
  assert.match(points[0].blobs[BUCKET_BLOB - 1], /^a:[0-9a-f]{16}$/);
  assert.deepEqual(classesOf(points[0]), { mac_code: 1 });
});

// ------------------------------------------------------------- scoring and aggregation
test("scoreUnmet and verdictUnmet behave as documented", () => {
  const cls = UNMET_CLASSES[CLASS_INDEX.format_variant];   // feasibility 1.0
  assert.equal(scoreUnmet({ requests: 0, callers: 0, paid_callers: 0, repeat_callers: 0 }, cls), 0);
  // 7 requests, one caller: log2(8)=3 x 2 x 1 x 1 x 1.0 = 6
  assert.equal(scoreUnmet({ requests: 7, callers: 1, paid_callers: 0, repeat_callers: 0 }, cls), 6);
  // same requests, one paying repeat caller: 3 x 2 x 3 x 2 = 36
  assert.equal(scoreUnmet({ requests: 7, callers: 1, paid_callers: 1, repeat_callers: 1 }, cls), 36);
  // ten callers beat a thousand requests from one: 3 x 11 = 33 vs log2(1001)~9.97 x 2 ~ 19.9
  assert.ok(scoreUnmet({ requests: 7, callers: 10, paid_callers: 0, repeat_callers: 0 }, cls) >
    scoreUnmet({ requests: 1000, callers: 1, paid_callers: 0, repeat_callers: 0 }, cls));
  const mac = UNMET_CLASSES[CLASS_INDEX.mac_code];
  assert.equal(verdictUnmet({ requests: 0 }, mac), "none");
  assert.equal(verdictUnmet({ requests: 5, callers: 1, paid_callers: 0 }, mac), "watch");
  assert.equal(verdictUnmet({ requests: 5, callers: 3, paid_callers: 0 }, mac), "investigate", "feasibility 0.4: investigate, not build");
  assert.equal(verdictUnmet({ requests: 5, callers: 1, paid_callers: 1 }, cls), "build");
  assert.equal(verdictUnmet({ requests: 5, callers: 9, paid_callers: 2 }, UNMET_CLASSES[CLASS_INDEX.quota_exceeded]), "pricing");
});

test("aggregateUnmet: callers, paid and repeat callers from caller-days; requests and occurrences from the endpoint rows", () => {
  const i = CLASS_INDEX;
  const callerDays = [
    { caller: "k:lab-a", keyed: "keyed", tier: "lab", caller_day: "2026-09-01T00:00:00Z", [`c${i.mac_code}`]: 3 },
    { caller: "k:lab-a", keyed: "keyed", tier: "lab", caller_day: "2026-09-03T00:00:00Z", [`c${i.mac_code}`]: 2 },
    { caller: "a:0011", keyed: "anon", tier: "free", caller_day: "2026-09-01T00:00:00Z", [`c${i.mac_code}`]: 1, [`c${i.serology}`]: 4 },
    { caller: "a:0022", keyed: "anon", tier: "free", caller_day: "2026-09-02T00:00:00Z", [`c${i.serology}`]: 1 },
    { caller: "k:uni-b", keyed: "keyed", tier: "academic", caller_day: "2026-09-02T00:00:00Z", [`c${i.serology}`]: 2 },
    { caller: "", keyed: "anon", tier: "free", caller_day: "2026-09-02T00:00:00Z", [`c${i.serology}`]: 9 },   // pre-feature rows: ignored
  ];
  const endpoints = [
    { endpoint: "normalize", [`c${i.mac_code}`]: 5, [`o${i.mac_code}`]: 12, [`c${i.serology}`]: 2, [`o${i.serology}`]: 2 },
    { endpoint: "mcp:check_typing", [`c${i.mac_code}`]: 1, [`o${i.mac_code}`]: 1, [`c${i.serology}`]: 5, [`o${i.serology}`]: 20 },
  ];
  const values = [{ value: "unknown_locus=KIR", requests: 4, callers: 2 }, { value: "format_variant=case", requests: 10, callers: 3 }];
  const rep = aggregateUnmet(callerDays, endpoints, values, { anonBuckets: true });
  assert.equal(rep.window, "30d");
  assert.equal(rep.anon_buckets, true);
  assert.match(rep.note, /per UTC day/);
  assert.match(aggregateUnmet([], [], []).note, /ONE caller/);
  const mac = rep.classes.find((c) => c.id === "mac_code");
  assert.equal(mac.requests, 6);
  assert.equal(mac.occurrences, 13);
  assert.equal(mac.callers, 2);
  assert.equal(mac.keyed_callers, 1);
  assert.equal(mac.paid_callers, 1);
  assert.equal(mac.repeat_callers, 1, "lab-a hit it on two days");
  assert.deepEqual(mac.by_endpoint, { normalize: 5, "mcp:check_typing": 1 });
  assert.equal(mac.verdict, "investigate");
  const ser = rep.classes.find((c) => c.id === "serology");
  assert.equal(ser.requests, 7);
  assert.equal(ser.callers, 3);
  assert.equal(ser.keyed_callers, 1);
  assert.equal(ser.paid_callers, 0, "academic is keyed but not paid");
  assert.equal(ser.repeat_callers, 0);
  assert.equal(ser.verdict, "build");
  const kir = rep.classes.find((c) => c.id === "unknown_locus");
  assert.deepEqual(kir.values, [{ value: "KIR", requests: 4, callers: 2 }]);
  assert.equal(rep.classes.find((c) => c.id === "format_variant").values[0].value, "case");
  assert.ok(rep.classes[0].score >= rep.classes[rep.classes.length - 1].score, "sorted by score");
  assert.equal(rep.classes.find((c) => c.id === "quota_exceeded").verdict, "none");
});
