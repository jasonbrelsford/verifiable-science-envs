// Slow-request logging (#164): a request over its route budget leaves one structured
// `slow_request` line in Workers Logs, carrying the route template and timings but never the
// allele name, query string or body; a fast request leaves none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { routeLabel, SLOW_BUDGET_MS } from "../src/index.js";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
let assetDelayMs = 0;
const ASSETS = {
  async fetch(url) {
    if (assetDelayMs) await new Promise((r) => setTimeout(r, assetDelayMs));
    const rel = new URL(url).pathname.replace(/^\//, "");
    try { return new Response(await readFile(path.join(pub, rel), "utf8"), { status: 200 }); }
    catch (e) { if (e.code === "ENOENT") return new Response(null, { status: 404 }); throw e; }
  },
};
const env = () => ({
  PUBLIC_ACCESS: "1", ASSETS,
  RL: { async limit() { return { success: true }; } },
  QUOTA: { idFromName: (n) => n, get: () => ({ async fetch(_u, init) {
    const { day, limit } = JSON.parse(init.body); return new Response(JSON.stringify({ count: 1, limit, day, over: false })); } }) },
  QUOTA_IP_SALT: "0123456789abcdef0123456789abcdef",
});
async function withWarnings(fn) {
  const lines = [], orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { console.warn = orig; }
  return lines;
}
const get = (p) => worker.fetch(new Request("https://api.hlaverify.com" + p,
  { headers: { "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc123-ORD" } }), env(), {});

test("route labels never carry a path parameter", () => {
  assert.equal(routeLabel("/v1/allele/A*24:09N"), "/v1/allele/{name}");
  assert.equal(routeLabel("/v1/allele/A*24:09N/history"), "/v1/allele/{name}/history");
  assert.equal(routeLabel("/v1/report/abc"), "/v1/report/{id}");
  assert.equal(routeLabel("/v1/releases/diff"), "/v1/releases/diff");
  assert.equal(routeLabel("/something/else"), "other");
  assert.ok(SLOW_BUDGET_MS["/v1/normalize"] > SLOW_BUDGET_MS.default);
});

test("a fast request logs nothing", async () => {
  let resp;
  const lines = await withWarnings(async () => { resp = await get("/healthz"); });
  assert.equal(resp.status, 200);
  assert.deepEqual(lines, []);
});

test("a request over budget logs one slow_request line with no allele name", async () => {
  assetDelayMs = SLOW_BUDGET_MS.default + 150;
  let resp;
  const lines = await withWarnings(async () => { resp = await get("/v1/allele/B*44:02?secret=1"); });
  assetDelayMs = 0;
  assert.equal(resp.status, 200);
  const slow = lines.filter((l) => l.includes("slow_request"));
  assert.equal(slow.length, 1);
  const rec = JSON.parse(slow[0]);
  assert.equal(rec.route, "/v1/allele/{name}");
  assert.equal(rec.status, 200);
  assert.ok(rec.ms > rec.budget_ms);
  assert.equal(rec.ray, "abc123-ORD");
  assert.equal(typeof rec.isolate_age_s, "number");
  assert.ok(!/B\*44|secret/.test(slow[0]), "no allele name or query string in the log");
});
