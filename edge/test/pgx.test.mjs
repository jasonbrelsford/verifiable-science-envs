// Pharmacogenomics routes and tools (src/pgx.js), driven end to end through
// index.js's real fetch handler over the vendored bundle edge/public/pgx.json
// (written by sci_envs/service/pgx_export.py; absent, every test here skips).
//
// What must hold (issue #112):
// 1. /v1/pgx/table is free: no key, no quota spent, cached a day, CSV on request,
//    and carries the CC BY-SA attribution block and the snapshot.
// 2. /v1/pgx/screen normalizes first: A*3101 -> A*31:01 -> the carbamazepine CPIC A
//    rows, with the deprecated_name flag kept; B*57:01 positive -> abacavir,
//    "Testing Required", in summary.actionable.
// 3. An unknown allele returns empty associations with the normalize flags.
// 4. /v1/pgx/pair marks donor_only / recipient_only / both correctly.
// 5. screen and pair are billed exactly like /v1/normalize and /v1/match; table never.
// 6. pgx_lookup and pgx_pair are on tools/list under both handshakes, mirror the
//    REST bodies byte for byte, and are billable tools.
// 7. The scoping sentence is on every pgx response and both tool descriptions, verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker, { DailyQuota } from "../src/index.js";
import { SCOPE, isActionable, pgxInputNames, MAX_PGX_ALLELES } from "../src/pgx.js";
import { BILLABLE_TOOLS } from "../src/quota.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const manifest = JSON.parse(await readFile(path.join(pub, "manifest.json"), "utf8"));
const haveBundle = await stat(path.join(pub, "pgx.json")).then(() => true, () => false);
const skip = haveBundle ? false : "edge/public/pgx.json not exported (python -m sci_envs.service.pgx_export)";

const ASSETS = {
  async fetch(url) {
    const p = new URL(url).pathname;
    const rel = p === "/pgx.json" ? "pgx.json" : path.join("data", p.replace(/^\/data\//, ""));
    try {
      return new Response(await readFile(path.join(pub, rel), "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e.code === "ENOENT") return new Response(null, { status: 404 });
      throw e;
    }
  },
};
function memStorage() {
  const map = new Map();
  let alarm = null;
  return {
    async get(k) { const v = map.get(k); return v === undefined ? undefined : structuredClone(v); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async deleteAll() { map.clear(); alarm = null; },
    async setAlarm(t) { alarm = t; },
    async getAlarm() { return alarm; },
  };
}
function fakeQuotaNamespace() {
  const objects = new Map();
  const spends = [];
  return {
    _spends: spends,
    object(name) { if (!objects.has(name)) objects.set(name, new DailyQuota({ storage: memStorage() })); return objects.get(name); },
    idFromName(name) { return { name }; },
    get(id) {
      const ns = this;
      return { fetch(url, init) { spends.push(id.name); return ns.object(id.name).fetch(new Request(url, init)); } };
    },
  };
}
const fakeRL = () => ({ async limit() { return { success: true }; } });
// QUOTA_IP_SALT must be at least 16 characters or quota.js fails open (quota.test.mjs).
const env = () => ({ PUBLIC_ACCESS: "1", RL: fakeRL(), QUOTA: fakeQuotaNamespace(), QUOTA_IP_SALT: "test-salt-0123456789abcdef", ASSETS });

const call = (e, method, p, body, headers = {}) => worker.fetch(new Request(`https://api.hlaverify.com${p}`, {
  method, headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) }), e, { waitUntil() {} });
const rpc = (e, method, params, headers = {}) => call(e, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params }, headers);
// 2026-07-28 era: the version travels in params._meta and must agree with the headers (mcp.js handleModern).
const MODERN = "2026-07-28";
const modernRpc = (e, method, params, name) => rpc(e, method, { ...params, _meta: {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
  { "mcp-protocol-version": MODERN, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

// ---------------------------------------------------------------- no bundle
// First, before any test loads the table: index.js caches a loaded bundle for
// the life of the isolate (one isolate per test file), and only a loaded one.

test("without a bundle the pgx routes answer 503 and nothing else changes", async () => {
  const e = { ...env(), ASSETS: { async fetch(url) { return new URL(url).pathname === "/pgx.json" ? new Response(null, { status: 404 }) : ASSETS.fetch(url); } } };
  assert.equal((await call(e, "GET", "/v1/pgx/table")).status, 503);
  const screen = await call(e, "POST", "/v1/pgx/screen", { alleles: ["B*57:01"] });
  assert.equal(screen.status, 503);
  assert.match((await screen.json()).detail, /not available/);
  assert.equal((await call(e, "GET", "/healthz")).status, 200);
  assert.equal((await call(e, "POST", "/v1/normalize", { typings: ["B*57:01"] })).status, 200);
  const tool = await (await rpc(e, "tools/call", { name: "pgx_lookup", arguments: { alleles: ["B*57:01"] } })).json();
  assert.equal(tool.result.isError, true);
  assert.match(tool.result.content[0].text, /not available/);
  // the other tools are untouched
  const names = (await (await rpc(e, "tools/list", {})).json()).result.tools.map((t) => t.name);
  assert.ok(names.includes("pgx_lookup") && names.includes("normalize_allele"));
});

// ------------------------------------------------------------------ table

test("GET /v1/pgx/table: free, no key, not billable, cached a day, attributed", { skip }, async () => {
  const e = env();
  const resp = await call(e, "GET", "/v1/pgx/table");
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(resp.headers.get("x-hla-verify-release"), manifest.release);
  const body = await resp.json();
  assert.equal(body.release, manifest.release);
  assert.equal(body.scope, SCOPE);
  assert.equal(body.license, "CC-BY-SA-4.0");
  assert.match(body.attribution, /CPIC/);
  assert.match(body.attribution, /PharmGKB/);
  assert.equal(typeof body.pgx_snapshot.date, "string");
  assert.ok(body.row_count > 300 && body.rows.length === body.row_count);
  assert.ok(body.columns.includes("hlaverify_2field"));
  assert.ok(body.rows.some((r) => r.allele === "HLA-B*57:01" && r.drug === "abacavir"));
  assert.deepEqual(e.QUOTA._spends, [], "the table must never spend quota");

  const csv = await call(e, "GET", "/v1/pgx/table?format=csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  const text = await csv.text();
  assert.match(text.split("\n")[0], /^source,source_record_id,gene,allele,/);
  assert.ok(text.includes("HLA-B*57:01"));
  assert.equal(text.trim().split("\n").length, body.row_count + 1);

  assert.equal((await call(e, "POST", "/v1/pgx/table", {})).status, 405);
  // Never served raw through the assets binding either.
  assert.equal((await call(e, "GET", "/pgx.json")).status, 404);
});

test("GET /v1/pgx/table works with PUBLIC_ACCESS=0 (open data needs no key)", { skip }, async () => {
  const e = { ...env(), PUBLIC_ACCESS: "0" };
  assert.equal((await call(e, "GET", "/v1/pgx/table")).status, 200);
  assert.equal((await call(e, "POST", "/v1/pgx/screen", { alleles: ["B*57:01"] })).status, 401);
});

// ----------------------------------------------------------------- screen

test("POST /v1/pgx/screen: A*3101 normalizes to A*31:01 and finds the carbamazepine CPIC A row", { skip }, async () => {
  const e = env();
  const resp = await call(e, "POST", "/v1/pgx/screen", { alleles: ["A*3101"] });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-hla-verify-daily-limit"), "100", "billed on the anonymous quota");
  assert.equal(resp.headers.get("x-hla-verify-daily-remaining"), "99");
  const body = await resp.json();
  assert.equal(body.scope, SCOPE);
  assert.equal(body.pgx_snapshot.date.length, 10);
  assert.equal(body.alleles.length, 1);
  const a = body.alleles[0];
  assert.equal(a.reported, "A*3101");
  assert.equal(a.allele_2field, "A*31:01");
  assert.ok(a.flags.includes("deprecated_name"), "legacy spelling must keep its flag");
  const cbz = a.associations.filter((x) => x.source === "cpic" && x.drug === "carbamazepine" && x.evidence_level === "CPIC A");
  assert.ok(cbz.length > 0, "carbamazepine CPIC A row for A*31:01");
  assert.ok(cbz.every((x) => x.guideline_url.startsWith("https://")));
  assert.ok(body.summary.actionable.some((x) => x.drug === "carbamazepine" && x.allele_status === "positive"));
  assert.ok(body.summary.drugs_actionable.includes("carbamazepine"));
  assert.equal(body.summary.unresolvable, 0);
});

test("POST /v1/pgx/screen: B*57:01 positive -> abacavir, Testing Required, in summary.actionable", { skip }, async () => {
  const resp = await call(env(), "POST", "/v1/pgx/screen", { typing: { B: ["B*57:01", "B*44:02"], A: ["A*02:01"] } });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.summary.names, 3);
  const b5701 = body.alleles.find((a) => a.reported === "B*57:01");
  assert.ok(b5701);
  const abc = b5701.associations.find((x) => x.source === "cpic" && x.drug === "abacavir" && x.allele_status === "positive");
  assert.ok(abc, "abacavir positive row");
  assert.equal(abc.evidence_level, "CPIC A");
  assert.equal(abc.pgx_testing, "Testing Required");
  assert.match(abc.recommendation, /not recommended/i);
  assert.ok(body.summary.actionable.some((x) => x.drug === "abacavir" && x.reported === "B*57:01"));
  // negative-status rows are reported but never "actionable"
  assert.ok(b5701.associations.some((x) => x.allele_status === "negative"));
  assert.ok(!body.summary.actionable.some((x) => x.allele_status === "negative"));
  assert.ok(body.summary.actionable.every(isActionable));
});

test("POST /v1/pgx/screen: an unknown allele returns empty associations with the normalize flags", { skip }, async () => {
  const resp = await call(env(), "POST", "/v1/pgx/screen", { alleles: ["A*99:99", "B*5701"] });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const fake = body.alleles.find((a) => a.reported === "A*99:99");
  assert.equal(fake.allele_2field, "UNRESOLVABLE");
  assert.ok(fake.flags.includes("nonexistent_allele"));
  assert.deepEqual(fake.associations, []);
  assert.equal(body.summary.unresolvable, 1);
  assert.equal(body.summary.with_associations, 1);
});

test("POST /v1/pgx/screen: input shape is validated", { skip }, async () => {
  const e = env();
  for (const [body, re] of [
    [{}, /exactly one of/],
    [{ typing: { B: ["B*57:01"] }, alleles: ["B*57:01"] }, /exactly one of/],
    [{ alleles: [] }, /no allele names/],
    [{ alleles: ["B*57:01", 7] }, /list of non-empty allele strings/],
    [{ alleles: Array.from({ length: MAX_PGX_ALLELES + 1 }, (_, i) => `B*${i}`) }, /at most/],
    [{ typing: { B: ["a", "b", "c", "d", "e"] } }, /up to 4/],
  ]) {
    const resp = await call(e, "POST", "/v1/pgx/screen", body);
    assert.equal(resp.status, 422, JSON.stringify(body).slice(0, 60));
    assert.match((await resp.json()).detail, re);
  }
  assert.equal(pgxInputNames({ alleles: ["B*57:01", "B*57:01"] }).names.length, 1, "de-duplicated");
});

// ------------------------------------------------------------------- pair

test("POST /v1/pgx/pair: donor_only / recipient_only / both", { skip }, async () => {
  const e = env();
  const resp = await call(e, "POST", "/v1/pgx/pair", {
    recipient: { alleles: ["B*57:01", "A*31:01", "A*02:01"] },
    donor: { typing: { B: ["B*15:02", "B*44:02"], A: ["A*31:01", "A*02:01"] } },
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-hla-verify-daily-remaining"), "99", "one call, one unit of quota");
  const body = await resp.json();
  assert.equal(body.scope, SCOPE);
  assert.equal(body.recipient.alleles.length, 3);
  assert.equal(body.donor.alleles.length, 4);
  const by = (drug, allele) => body.actionable.filter((a) => a.drug === drug && a.allele === allele);
  const abacavir = by("abacavir", "HLA-B*57:01");
  assert.ok(abacavir.length && abacavir.every((a) => a.whose_hla === "recipient_only" && a.in_recipient && !a.in_donor && a.discordant));
  const cbz1502 = by("carbamazepine", "HLA-B*15:02");
  assert.ok(cbz1502.length && cbz1502.every((a) => a.whose_hla === "donor_only" && a.in_donor && !a.in_recipient && a.discordant));
  const cbz3101 = by("carbamazepine", "HLA-A*31:01");
  assert.ok(cbz3101.length && cbz3101.every((a) => a.whose_hla === "both" && !a.discordant));
  assert.equal(body.summary.actionable, body.actionable.length);
  assert.equal(body.summary.discordant, body.actionable.filter((a) => a.discordant).length);
  assert.ok(body.summary.drugs.includes("abacavir") && body.summary.drugs.includes("carbamazepine"));
  assert.ok(body.actionable.every((a) => !("reported" in a)));

  const bad = await call(e, "POST", "/v1/pgx/pair", { recipient: { alleles: ["B*57:01"] } });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).detail, /^donor/);
});

// ---------------------------------------------------------------- billing

test("screen and pair spend the daily quota; the table and a 422 refusal still count like the other routes", { skip }, async () => {
  const e = env();
  await call(e, "GET", "/v1/pgx/table");
  assert.equal(e.QUOTA._spends.length, 0);
  await call(e, "POST", "/v1/pgx/screen", { alleles: ["B*57:01"] });
  assert.equal(e.QUOTA._spends.length, 1);
  await call(e, "POST", "/v1/pgx/pair", { recipient: { alleles: ["B*57:01"] }, donor: { alleles: ["B*44:02"] } });
  assert.equal(e.QUOTA._spends.length, 2);
  // a malformed request is charged before validation, exactly as /v1/normalize is
  await call(e, "POST", "/v1/pgx/screen", {});
  assert.equal(e.QUOTA._spends.length, 3);
  const last = await call(e, "POST", "/v1/pgx/screen", { alleles: ["B*57:01"] });
  assert.equal(last.headers.get("x-hla-verify-daily-remaining"), "96");
});

// -------------------------------------------------------------------- MCP

test("tools/list carries pgx_lookup and pgx_pair under the legacy and modern handshakes, with the scope sentence", { skip }, async () => {
  const e = env();
  const legacy = await (await rpc(e, "tools/list", {})).json();
  const names = legacy.result.tools.map((t) => t.name);
  assert.ok(names.includes("pgx_lookup") && names.includes("pgx_pair"));
  for (const n of ["pgx_lookup", "pgx_pair"]) {
    const t = legacy.result.tools.find((x) => x.name === n);
    assert.ok(t.description.includes(SCOPE), `${n} description must carry the scope sentence verbatim`);
    assert.equal(t.outputSchema.type, "object");
    assert.deepEqual(t.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    assert.ok(BILLABLE_TOOLS.has(n));
  }
  const modern = await (await modernRpc(e, "tools/list", {})).json();
  assert.equal(modern.result.resultType, "complete");
  assert.ok(modern.result.tools.some((t) => t.name === "pgx_lookup") && modern.result.tools.some((t) => t.name === "pgx_pair"));
  // and a modern tools/call reaches the same handler
  const called = await (await modernRpc(e, "tools/call", { name: "pgx_lookup", arguments: { alleles: ["B*57:01"] } }, "pgx_lookup")).json();
  assert.equal(called.result.isError, false);
  assert.ok(called.result.structuredContent.summary.drugs_actionable.includes("abacavir"));
});

test("pgx_lookup and pgx_pair return the same bodies as the REST routes and are billed", { skip }, async () => {
  const e = env();
  const rest = await (await call(e, "POST", "/v1/pgx/screen", { alleles: ["B*5701", "A*31:01"] })).json();
  const tool = await (await rpc(e, "tools/call", { name: "pgx_lookup", arguments: { alleles: ["B*5701", "A*31:01"] } })).json();
  assert.equal(tool.result.isError, false);
  assert.deepEqual(tool.result.structuredContent, rest);
  assert.deepEqual(JSON.parse(tool.result.content[0].text), rest);
  assert.equal(e.QUOTA._spends.length, 2);

  const pairArgs = { recipient: { alleles: ["B*57:01"] }, donor: { typing: { B: ["B*15:02"] } } };
  const restPair = await (await call(e, "POST", "/v1/pgx/pair", pairArgs)).json();
  const toolPair = await (await rpc(e, "tools/call", { name: "pgx_pair", arguments: pairArgs })).json();
  assert.deepEqual(toolPair.result.structuredContent, restPair);
  assert.equal(e.QUOTA._spends.length, 4);

  const refused = await (await rpc(e, "tools/call", { name: "pgx_lookup", arguments: {} })).json();
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /exactly one of/);
});
