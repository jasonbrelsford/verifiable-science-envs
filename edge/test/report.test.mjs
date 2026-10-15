// POST /v1/report and GET /v1/report/{id}: the support portal's intake, driven
// end to end through index.js's real fetch handler with a fake KV, fake rate
// limiters and the disk-backed ASSETS stub the other worker tests use.
//
// 1. The contract hlaverify.com/support depends on: 200 with an id and a status
//    URL, {"detail": ...} on 405/415/422, CORS on the answer.
// 2. The record: what was submitted plus a timestamp, cf-ipcountry, the live
//    release and status "received" (never the IP) under "report/" in KEYS, which
//    the private site repo's support intake reads and writes status back to.
// 3. Containment: a "report/" record must never authenticate as an API key, the
//    same class of bug beta/ once had.
// 4. No quota: reporting a wrong answer must never cost a call.
// 5. Patient data: anything shaped like a patient identifier is refused, with a
//    reason, before anything is stored.
// 6. The status lookup shows the status and never the input or the email.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { REPORT_PREFIX, REPORT_KINDS, RESERVED_PREFIXES, REPORT_ID_RE, MAX_REPORT_INPUT } from "../src/handlers.js";

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
function fakeRL() { return { async limit() { return { success: true }; } }; }
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

function baseEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    KEYS: fakeKV(),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_LAB: fakeRL(), RL_SCALE: fakeRL(),
    QUOTA: fakeQuota(), QUOTA_IP_SALT: "0123456789abcdef0123456789abcdef",
    ASSETS,
    ...extra,
  };
}

const ORIGIN = "https://api.hlaverify.com";
const IP = "203.0.113.42";

async function call(env, method, p, { headers = {}, body } = {}) {
  const init = { method, headers: { "cf-connecting-ip": IP, "cf-ipcountry": "US", ...headers } };
  if (body !== undefined) init.body = body;
  const resp = await worker.fetch(new Request(ORIGIN + p, init), env, {});
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text ? JSON.parse(text) : null };
}
const report = (env, payload, headers = {}) => call(env, "POST", "/v1/report", {
  headers: { "content-type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});
const records = (env) => [...env.KEYS._store.keys()].filter((k) => k.startsWith(REPORT_PREFIX));

const GOOD = {
  kind: "wrong_result",
  endpoint: "/v1/verify",
  input: "A*02:01:01:01 B*07:02 DRB1*15:01",
  received: '{"clean": false, "fabricated": ["B*07:02"]}',
  expected: "B*07:02 is a valid allele and should not be flagged",
  details: "Seen in our nightly QC run.",
  email: "qc@lab.example",
  source: "site",
};

// ------------------------------------------------------------- happy path

test("POST /v1/report: records the report and answers with an id and a status URL", async () => {
  const env = baseEnv();
  const { status, headers, json } = await report(env, GOOD);
  assert.equal(status, 200);
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.equal(json.ok, true);
  assert.match(json.id, REPORT_ID_RE);
  assert.equal(json.status, "received");
  assert.equal(json.status_url, `https://hlaverify.com/support?id=${json.id}`);
  assert.equal(json.release, manifest.release);
  assert.match(json.message, new RegExp(json.id));
});

test("the record holds what was sent, the release and a status, never the IP", async () => {
  const env = baseEnv();
  const { json } = await report(env, GOOD);
  const keys = records(env);
  assert.deepEqual(keys, [REPORT_PREFIX + json.id]);
  const rec = JSON.parse(env.KEYS._store.get(keys[0]));
  for (const f of ["kind", "endpoint", "input", "received", "expected", "details", "email", "source"]) assert.equal(rec[f], GOOD[f], f);
  assert.equal(rec.status, "received");
  assert.equal(rec.release, manifest.release);
  assert.equal(rec.country, "US");
  assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  assert.ok(!JSON.stringify(rec).includes(IP), "the IP must never be stored");
});

test("only input and expected are required; kind defaults to wrong_result", async () => {
  const env = baseEnv();
  const { status, json } = await report(env, { input: "A*0201", expected: "should normalize to A*02:01" });
  assert.equal(status, 200);
  const rec = JSON.parse(env.KEYS._store.get(REPORT_PREFIX + json.id));
  assert.equal(rec.kind, "wrong_result");
  assert.equal(rec.email, null);
});

test("each report gets its own id, even with identical content", async () => {
  const env = baseEnv();
  const a = await report(env, GOOD), b = await report(env, GOOD);
  assert.notEqual(a.json.id, b.json.id);
  assert.equal(records(env).length, 2);
});

// ------------------------------------------------------------- validation

test("validation: 422 with a reason, and nothing is stored", async () => {
  const cases = [
    [{ ...GOOD, kind: "rant" }, /kind must be one of/],
    [{ ...GOOD, input: "  " }, /input must be a non-empty string/],
    [{ ...GOOD, input: undefined }, /input must be a non-empty string/],
    [{ ...GOOD, expected: "" }, /expected must be a non-empty string/],
    [{ ...GOOD, input: "A".repeat(MAX_REPORT_INPUT + 1) }, /input must be at most/],
    [{ ...GOOD, email: "not-an-address" }, /email must look like an address/],
    [{ ...GOOD, details: 5 }, /details must be a string/],
  ];
  for (const [payload, re] of cases) {
    const env = baseEnv();
    const { status, json } = await report(env, payload);
    assert.equal(status, 422, JSON.stringify(payload).slice(0, 80));
    assert.match(json.detail, re);
    assert.equal(records(env).length, 0);
  }
});

test("wrong method, wrong content type and malformed JSON get the documented errors", async () => {
  const env = baseEnv();
  assert.equal((await call(env, "GET", "/v1/report")).status, 405);
  assert.equal((await report(env, GOOD, { "content-type": "text/plain" })).status, 415);
  assert.equal((await report(env, "{not json")).status, 400);
  assert.equal((await call(env, "POST", "/v1/report/r0123456789abcdef")).status, 405);
});

test("patient identifiers are refused before anything is stored", async () => {
  const cases = [
    ["details", "Patient MRN 4471923, typing below"],
    ["details", "DOB: 03/14/1961"],
    ["input", "A*02:01 B*07:02 born 3/14/1961"],
    ["received", "ssn 123-45-6789"],
    ["expected", "patient name John Smith should match"],
  ];
  for (const [field, text] of cases) {
    const env = baseEnv();
    const { status, json } = await report(env, { ...GOOD, [field]: text });
    assert.equal(status, 422, text);
    assert.match(json.detail, new RegExp(`^${field} contains`));
    assert.match(json.detail, /must not include patient identifiers/);
    assert.equal(records(env).length, 0);
  }
});

test("HLA names, GL strings and release dates are not mistaken for patient data", async () => {
  const env = baseEnv();
  const { status } = await report(env, { ...GOOD,
    input: "HLA-A*01:01/A*01:02+A*02:01^B*07:02 DRB1*15:01:01G Cw*0702",
    details: "Release 3.66.0 from 2026-10-14; also seen on 3.65.0" });
  assert.equal(status, 200);
});

// ------------------------------------------------------------- containment and quota

test("a report record can never authenticate as an API key", async () => {
  assert.ok(RESERVED_PREFIXES.includes(REPORT_PREFIX), "REPORT_PREFIX must be listed in RESERVED_PREFIXES");
  const env = baseEnv();
  const { json } = await report(env, GOOD);
  const key = REPORT_PREFIX + json.id;
  const r = await call(env, "POST", "/v1/verify", {
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ text: "A*02:01" }) });
  assert.equal(r.status, 401);
});

test("reporting and checking a report never spend quota", async () => {
  const env = baseEnv();
  const { json } = await report(env, GOOD);
  await call(env, "GET", `/v1/report/${json.id}`);
  assert.equal(env.QUOTA.spends.length, 0);
});

// ------------------------------------------------------------- status lookup

test("GET /v1/report/{id}: public status only, never the input or the email", async () => {
  const env = baseEnv();
  const { json: made } = await report(env, GOOD);
  const { status, json } = await call(env, "GET", `/v1/report/${made.id}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ["created", "fixed_in", "id", "kind", "note", "release_at_report", "status", "updated"]);
  assert.equal(json.status, "received");
  const text = JSON.stringify(json);
  for (const secret of [GOOD.input, GOOD.email, GOOD.details, GOOD.received]) assert.ok(!text.includes(secret));
});

test("GET /v1/report/{id}: shows the status, note and release the support intake wrote back", async () => {
  const env = baseEnv();
  const { json: made } = await report(env, GOOD);
  const k = REPORT_PREFIX + made.id;
  const rec = JSON.parse(env.KEYS._store.get(k));
  env.KEYS._store.set(k, JSON.stringify({ ...rec, status: "fixed", note: "B*07:02 was misread; fixed.", fixed_in: "3.66.0", updated: "2026-10-16T00:00:00Z" }));
  const { json } = await call(env, "GET", `/v1/report/${made.id}`);
  assert.equal(json.status, "fixed");
  assert.equal(json.note, "B*07:02 was misread; fixed.");
  assert.equal(json.fixed_in, "3.66.0");
});

test("GET /v1/report/{id}: unknown or malformed ids are 404, and a malformed id never reaches KV", async () => {
  const env = baseEnv();
  let reads = 0;
  const get = env.KEYS.get.bind(env.KEYS);
  env.KEYS.get = async (k) => { reads += 1; return get(k); };
  assert.equal((await call(env, "GET", "/v1/report/r0123456789abcdef")).status, 404);
  assert.equal(reads, 1);
  // An encoded traversal stays in the path (a literal ../ is resolved by URL
  // parsing before the Worker sees it) and must be refused by the id pattern.
  // (An empty id is "/v1/report/", which the Worker reads as "/v1/report": GET there is 405.)
  for (const bad of ["..%2Fbeta%2Fsomeone@example.com", "R0123456789ABCDEF", "x"]) {
    assert.equal((await call(env, "GET", `/v1/report/${bad}`)).status, 404, bad);
  }
  assert.equal(reads, 1);
});

test("every documented kind is accepted", async () => {
  for (const kind of REPORT_KINDS) {
    const env = baseEnv();
    assert.equal((await report(env, { ...GOOD, kind })).status, 200, kind);
  }
});
