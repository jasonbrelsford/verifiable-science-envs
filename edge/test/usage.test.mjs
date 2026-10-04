// Usage analytics: GET /v1/usage (a keyed caller's own usage, scoped to their
// label) and GET /admin/usage (the operator dashboard). Both read the
// Analytics Engine dataset the Worker already writes to (index.js meter())
// through the Analytics Engine SQL API, which is stubbed here: no network
// call ever leaves this process.
//
// What must hold:
// 1. The SQL sent for /v1/usage is scoped to the caller's own label (index1)
//    and carries the expected time window; the label is escaped (embedded
//    single quotes doubled) and a label with characters outside the safe set
//    is refused before any query is built.
// 2. /v1/usage: 401 with no key, 503 when Analytics Engine read access is not
//    configured, 200 with the documented shape otherwise, and a second call
//    within 60s is served from cache without a second SQL call.
// 3. /admin/usage: 503 with no ADMIN_TOKEN, 401 with a missing/wrong bearer,
//    503 when Analytics Engine read access is not configured, 200 (JSON) and
//    an HTML render (Accept: text/html) with the totals otherwise.
// 4. Neither route is billable against the daily quota, and both are metered
//    under "usage" / "admin:usage".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { isValidLabel, sqlString, buildCallerUsageSQL, buildAdminTotalsSQL, buildAdminUniqueLabelsSQL,
  buildAdminDailySeriesSQL, buildAdminBreakdownSQL, buildAdminTopLabelsSQL, buildAdminLatencySQL,
  buildAdminUnmetCallersSQL, buildAdminUnmetEndpointsSQL, buildAdminUnmetValuesSQL,
  handleUsageRequest, handleAdminUsageRequest, _resetUsageCache } from "../src/usage.js";
import { isBillablePath } from "../src/quota.js";
import { UNMET_CLASSES, CLASS_INDEX } from "../src/unmet.js";

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

function withFetch(mockFn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = orig; });
}

// Routes a stubbed SQL API call to a canned answer based on which query shape
// it recognizes in the request body, a small fake of Analytics Engine, not a
// real one, but it lets every code path be exercised without a network call.
function fakeAE({ callerRows, totalsRow, uniqueN = 3, dailyRows = [], breakdownRows = [], topRows = [], latencyRow = {},
  unmetCallerRows = [], unmetEndpointRows = [], unmetValueRows = [] } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const sql = String(opts.body);
    calls.push({ url: String(url), sql, headers: opts.headers });
    let data;
    if (sql.includes("count(DISTINCT blob1)")) data = [{ n: uniqueN }];
    else if (sql.includes("calls_24h")) data = totalsRow ? [totalsRow] : [];
    else if (sql.includes("AS caller_day")) data = unmetCallerRows;
    else if (sql.includes("AS unmet_endpoint")) data = unmetEndpointRows;
    else if (sql.includes("blob8 AS value")) data = unmetValueRows;
    else if (sql.includes("toStartOfDay(timestamp) AS day")) data = dailyRows;
    else if (sql.includes("GROUP BY endpoint, tier, status")) data = breakdownRows;
    else if (sql.includes("quantileExactWeighted")) data = [latencyRow];
    else if (sql.includes("LIMIT 20")) data = topRows;
    else if (sql.includes("GROUP BY endpoint, status")) data = callerRows || [];
    else data = [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

// ------------------------------------------------------- SQL construction

test("buildCallerUsageSQL scopes to index1 = the caller's label and the 30-day window", () => {
  const sql = buildCallerUsageSQL("hello");
  assert.match(sql, /index1 = 'hello'/);
  assert.match(sql, /INTERVAL '30' DAY/);
  assert.match(sql, /FROM hlaverify_usage/);
});

test("sqlString doubles an embedded single quote", () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  const sql = buildCallerUsageSQL("stripe:cus_O'Brien");
  assert.match(sql, /index1 = 'stripe:cus_O''Brien'/);
});

test("isValidLabel accepts the real label shapes and rejects anything with unsafe characters", () => {
  for (const ok of ["anonymous", "self-serve", "stripe:cus_9F3kd0", "my lab:starter", "a.b@c-d_1:23"]) {
    assert.equal(isValidLabel(ok), true, ok);
  }
  for (const bad of ["'; DROP TABLE x; --", "a\"b", "a;b", "a\nb", "", "a".repeat(300)]) {
    assert.equal(isValidLabel(bad), false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------- GET /v1/usage

test("GET /v1/usage: anonymous is 401 with a hint", async () => {
  const env = { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", ASSETS };
  const req = new Request("https://assets.local/v1/usage", { method: "GET" });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.match(body.detail, /API key/i);
});

test("GET /v1/usage: 503 when CF_ANALYTICS_TOKEN/CF_ACCOUNT_ID are unset", async () => {
  const env = { HLA_VERIFY_API_KEYS: "k1=customer-a:starter", ASSETS };
  const req = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k1" } });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 503);
  assert.deepEqual(await resp.json(), { detail: "usage reporting not configured" });
});

test("GET /v1/usage: 200 with the documented shape, scoped to the caller's own label", async () => {
  _resetUsageCache();
  const env = { HLA_VERIFY_API_KEYS: "k1=customer-a:lab", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const rows = [
    { endpoint: "verify", status: "200", calls_today: 5, calls_7d: 20, calls_30d: 80, units_today: 5, units_7d: 20, units_30d: 80 },
    { endpoint: "normalize", status: "429", calls_today: 1, calls_7d: 2, calls_30d: 3, units_today: 0, units_7d: 0, units_30d: 0 },
  ];
  const fetchStub = fakeAE({ callerRows: rows });
  const body = await withFetch(fetchStub, async () => {
    const req = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k1" } });
    const resp = await worker.fetch(req, env, {});
    assert.equal(resp.status, 200);
    return resp.json();
  });
  assert.equal(body.release, manifest.release);
  assert.equal(body.tier, "lab");
  assert.equal(body.daily_quota, 10000);
  assert.equal(body.max_typings, 5000);
  assert.equal(body.usage.today.calls, 6);
  assert.equal(body.usage.today.by_endpoint.verify, 5);
  assert.equal(body.usage["30d"].by_status["429"], 3);
  assert.equal(fetchStub.calls.length, 1);
  assert.match(fetchStub.calls[0].sql, /index1 = 'customer-a'/);
  assert.match(fetchStub.calls[0].headers.authorization, /Bearer tok1/);
  assert.match(String(fetchStub.calls[0].url), /accounts\/acct1\/analytics_engine\/sql/);
});

test("GET /v1/usage: enterprise (uncapped) reports daily_quota as 'unlimited'", async () => {
  _resetUsageCache();
  const env = { HLA_VERIFY_API_KEYS: "k2=customer-b:enterprise", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const body = await withFetch(fakeAE({ callerRows: [] }), async () => {
    const req = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k2" } });
    return (await worker.fetch(req, env, {})).json();
  });
  assert.equal(body.daily_quota, "unlimited");
});

test("GET /v1/usage: a second request for the same key within 60s is served from cache (no second SQL call)", async () => {
  _resetUsageCache();
  const env = { HLA_VERIFY_API_KEYS: "k3=customer-c:starter", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const fetchStub = fakeAE({ callerRows: [{ endpoint: "verify", status: "200", calls_today: 1, calls_7d: 1, calls_30d: 1, units_today: 1, units_7d: 1, units_30d: 1 }] });
  await withFetch(fetchStub, async () => {
    const req1 = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k3" } });
    const r1 = await worker.fetch(req1, env, {});
    assert.equal(r1.status, 200);
    const req2 = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k3" } });
    const r2 = await worker.fetch(req2, env, {});
    assert.equal(r2.status, 200);
  });
  assert.equal(fetchStub.calls.length, 1, "second request should be served from the 60s cache");
});

test("GET /v1/usage: a broken SQL API answers 502, not a 500 or a stack trace", async () => {
  _resetUsageCache();
  const env = { HLA_VERIFY_API_KEYS: "k4=customer-d:starter", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const broken = async () => new Response("nope", { status: 500 });
  await withFetch(broken, async () => {
    const req = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k4" } });
    const resp = await worker.fetch(req, env, {});
    assert.equal(resp.status, 502);
  });
});

test("GET /v1/usage is not a billable path and does not consume the daily quota", () => {
  assert.equal(isBillablePath("/v1/usage"), false);
});

test("GET /v1/usage: wrong method is 405", async () => {
  const env = { HLA_VERIFY_API_KEYS: "k1=customer-a:starter", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const req = new Request("https://assets.local/v1/usage", { method: "POST", headers: { "x-api-key": "k1" } });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 405);
});

test("GET /v1/usage: metered as 'usage'", async () => {
  _resetUsageCache();
  const points = [];
  const env = { HLA_VERIFY_API_KEYS: "k5=customer-e:starter", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS,
    USAGE: { writeDataPoint: (p) => points.push(p) } };
  await withFetch(fakeAE({ callerRows: [] }), async () => {
    const req = new Request("https://assets.local/v1/usage", { method: "GET", headers: { "x-api-key": "k5" } });
    await worker.fetch(req, env, {});
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[1], "usage");
  assert.equal(points[0].indexes[0], "customer-e");
});

// ------------------------------------------------------- GET /admin/usage

const totalsRow = { calls_24h: 100, anon_24h: 40, calls_7d: 700, anon_7d: 280, calls_30d: 3000, anon_30d: 1200 };
const breakdownRows = [
  { endpoint: "verify", tier: "starter", status: "200", calls: 500 },
  { endpoint: "verify", tier: "free", status: "200", calls: 900 },
  { endpoint: "normalize", tier: "lab", status: "429", calls: 20 },
  { endpoint: "normalize", tier: "lab", status: "500", calls: 5 },
];
const dailyRows = [{ day: "2026-09-01", calls: 90 }, { day: "2026-09-02", calls: 110 }];
const topRows = [{ label: "customer-a", calls: 400 }, { label: "customer-b", calls: 150 }];
const latencyRow = { p50_ms: 12.3, p95_ms: 88.1, avg_ms: 20.5, max_ms: 500 };

test("GET /admin/usage: 503 when ADMIN_TOKEN is unset", async () => {
  const env = { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", ASSETS };
  const req = new Request("https://assets.local/admin/usage", { method: "GET", headers: { authorization: "Bearer whatever" } });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 503);
});

test("GET /admin/usage: 401 with a missing or wrong bearer", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", ASSETS };
  const noAuth = await worker.fetch(new Request("https://assets.local/admin/usage", { method: "GET" }), env, {});
  assert.equal(noAuth.status, 401);
  const wrong = await worker.fetch(new Request("https://assets.local/admin/usage",
    { method: "GET", headers: { authorization: "Bearer nope" } }), env, {});
  assert.equal(wrong.status, 401);
});

test("GET /admin/usage: a presented customer API key is not accepted as the admin token", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", HLA_VERIFY_API_KEYS: "k1=customer-a:starter",
    CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", ASSETS };
  const resp = await worker.fetch(new Request("https://assets.local/admin/usage",
    { method: "GET", headers: { authorization: "Bearer k1" } }), env, {});
  assert.equal(resp.status, 401);
});

test("GET /admin/usage: 503 when Analytics Engine read access is not configured", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", ASSETS };
  const resp = await worker.fetch(new Request("https://assets.local/admin/usage",
    { method: "GET", headers: { authorization: "Bearer secret-admin-token" } }), env, {});
  assert.equal(resp.status, 503);
  assert.deepEqual(await resp.json(), { detail: "usage reporting not configured" });
});

test("GET /admin/usage: 200 JSON with totals, breakdowns, top labels and latency", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const fetchStub = fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow, uniqueN: 7 });
  const body = await withFetch(fetchStub, async () => {
    const req = new Request("https://assets.local/admin/usage", { method: "GET", headers: { authorization: "Bearer secret-admin-token" } });
    const resp = await worker.fetch(req, env, {});
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "application/json; charset=utf-8");
    return resp.json();
  });
  assert.equal(body.totals["24h"].calls, 100);
  assert.equal(body.totals["24h"].anonymous_calls, 40);
  assert.equal(body.totals["24h"].unique_labels, 7);
  assert.equal(body.totals["30d"].calls, 3000);
  assert.equal(body.by_endpoint.verify, 1400);
  assert.equal(body.by_tier.lab, 25);
  assert.equal(body.by_status_class["2xx"], 1400);
  assert.equal(body.by_status_class["4xx"], 20);
  assert.equal(body.by_status_class["5xx"], 5);
  assert.equal(body.top_labels[0].label, "customer-a");
  assert.equal(body.latency_ms.p50, 12.3);
  assert.equal(body.latency_ms.p95, 88.1);
  assert.ok(body.error_rate > 0 && body.error_rate < 1);
  assert.equal(body.daily_series.length, 2);
});

test("GET /admin/usage: HTML render (Accept: text/html) contains the totals", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const html = await withFetch(fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow, uniqueN: 7 }), async () => {
    const req = new Request("https://assets.local/admin/usage",
      { method: "GET", headers: { authorization: "Bearer secret-admin-token", accept: "text/html" } });
    const resp = await worker.fetch(req, env, {});
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type"), /text\/html/);
    return resp.text();
  });
  assert.match(html, /<svg/);
  assert.match(html, /100/); // 24h calls
  assert.match(html, /3,000|3000/); // 30d calls
  assert.match(html, /customer-a/);
});

test("GET /admin/usage: ?format=html also renders HTML", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const resp = await withFetch(fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow }), () =>
    worker.fetch(new Request("https://assets.local/admin/usage?format=html",
      { method: "GET", headers: { authorization: "Bearer secret-admin-token" } }), env, {}));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type"), /text\/html/);
});

test("GET /admin/usage: metered as 'admin:usage'", async () => {
  const points = [];
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS,
    USAGE: { writeDataPoint: (p) => points.push(p) } };
  await withFetch(fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow }), () =>
    worker.fetch(new Request("https://assets.local/admin/usage",
      { method: "GET", headers: { authorization: "Bearer secret-admin-token" } }), env, {}));
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[1], "admin:usage");
});

// ------------------------------------------------------- direct unit calls

test("handleUsageRequest and handleAdminUsageRequest reject anything but GET", async () => {
  const helpers = {
    json: (b, s = 200, e = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...e } }),
    err: (s, d, e = {}) => new Response(JSON.stringify({ detail: d }), { status: s, headers: { "content-type": "application/json", ...e } }),
    CORS: {},
  };
  const req1 = new Request("https://assets.local/v1/usage", { method: "DELETE" });
  assert.equal((await handleUsageRequest(req1, {}, { keyed: true, label: "x", tier: "starter" }, manifest, helpers)).status, 405);
  const req2 = new Request("https://assets.local/admin/usage", { method: "DELETE" });
  assert.equal((await handleAdminUsageRequest(req2, {}, manifest, helpers)).status, 405);
});

test("admin SQL builders name the expected windows and shapes", () => {
  assert.match(buildAdminTotalsSQL(), /calls_24h/);
  assert.match(buildAdminTotalsSQL(), /INTERVAL '1' DAY/);
  assert.match(buildAdminUniqueLabelsSQL("7"), /count\(DISTINCT blob1\)/);
  assert.match(buildAdminUniqueLabelsSQL("7"), /INTERVAL '7' DAY/);
  assert.match(buildAdminDailySeriesSQL(), /toStartOfDay\(timestamp\)/);
  assert.match(buildAdminBreakdownSQL(), /GROUP BY endpoint, tier, status/);
  assert.match(buildAdminTopLabelsSQL(), /LIMIT 20/);
  assert.match(buildAdminLatencySQL(), /quantileExactWeighted\(0\.5\)\(double2, _sample_interval\)/);
  assert.match(buildAdminLatencySQL(), /quantileExactWeighted\(0\.95\)\(double2, _sample_interval\)/);
});

// ------------------------------------------------------- unmet requests section

test("unmet SQL builders read the unmet.js columns, one per class, sample-corrected, over 30 days", () => {
  const callers = buildAdminUnmetCallersSQL();
  assert.match(callers, /blob7 AS caller, blob5 AS keyed, blob6 AS tier, toStartOfDay\(timestamp\) AS caller_day/);
  assert.match(callers, /sumIf\(_sample_interval, double3 > 0\) AS c0/);
  assert.match(callers, new RegExp(`double${2 + UNMET_CLASSES.length} > 0\\) AS c${UNMET_CLASSES.length - 1}`));
  assert.match(callers, /blob7 <> ''/);
  assert.match(callers, /INTERVAL '30' DAY/);
  assert.match(callers, /LIMIT 10000/);
  const endpoints = buildAdminUnmetEndpointsSQL();
  assert.match(endpoints, /blob2 AS unmet_endpoint/);
  assert.match(endpoints, /sum\(_sample_interval \* double3\) AS o0/);
  assert.match(endpoints, /GROUP BY unmet_endpoint/);
  const values = buildAdminUnmetValuesSQL();
  assert.match(values, /blob8 AS value/);
  assert.match(values, /count\(DISTINCT blob7\) AS callers/);
  assert.match(values, /blob8 <> ''/);
  // nothing in any of them reaches for a raw column that could hold content
  for (const sql of [callers, endpoints, values]) assert.doesNotMatch(sql, /blob1[^0-9]|index1/);
});

const i = CLASS_INDEX;
const unmetCallerRows = [
  { caller: "k:customer-a", keyed: "keyed", tier: "lab", caller_day: "2026-09-01T00:00:00Z", [`c${i.mac_code}`]: 3 },
  { caller: "k:customer-a", keyed: "keyed", tier: "lab", caller_day: "2026-09-04T00:00:00Z", [`c${i.mac_code}`]: 1 },
  { caller: "a:00ff00ff00ff00ff", keyed: "anon", tier: "free", caller_day: "2026-09-02T00:00:00Z", [`c${i.mac_code}`]: 2, [`c${i.framework_unsupported}`]: 1 },
];
const unmetEndpointRows = [
  { unmet_endpoint: "normalize", [`c${i.mac_code}`]: 4, [`o${i.mac_code}`]: 9 },
  { unmet_endpoint: "mcp:check_typing", [`c${i.mac_code}`]: 2, [`o${i.mac_code}`]: 2, [`c${i.framework_unsupported}`]: 1, [`o${i.framework_unsupported}`]: 1 },
];
const unmetValueRows = [{ value: "framework_unsupported=9/10", requests: 1, callers: 1 }];

test("GET /admin/usage: JSON carries the unmet-requests report, ranked, with the score components", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const fetchStub = fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow, unmetCallerRows, unmetEndpointRows, unmetValueRows });
  const body = await withFetch(fetchStub, async () => {
    const req = new Request("https://assets.local/admin/usage", { method: "GET", headers: { authorization: "Bearer secret-admin-token" } });
    return (await worker.fetch(req, env, {})).json();
  });
  assert.equal(fetchStub.calls.length, 11, "eight existing queries plus three unmet queries");
  assert.equal(body.unmet.window, "30d");
  assert.equal(body.unmet.classes.length, UNMET_CLASSES.length);
  const mac = body.unmet.classes.find((c) => c.id === "mac_code");
  assert.equal(mac.requests, 6);
  assert.equal(mac.occurrences, 11);
  assert.equal(mac.callers, 2);
  assert.equal(mac.paid_callers, 1);
  assert.equal(mac.repeat_callers, 1);
  assert.deepEqual(mac.by_endpoint, { normalize: 4, "mcp:check_typing": 2 });
  assert.ok(mac.score > 0);
  assert.equal(mac.verdict, "investigate");
  const fw = body.unmet.classes.find((c) => c.id === "framework_unsupported");
  assert.deepEqual(fw.values, [{ value: "9/10", requests: 1, callers: 1 }]);
  assert.equal(body.unmet.classes[0].id, "mac_code", "ranked by score");
  assert.equal(body.unmet.classes.find((c) => c.id === "serology").verdict, "none");
  assert.match(body.unmet.note, /never request content/);
});

test("GET /admin/usage: the HTML render has the unmet-requests table with titles, values and verdicts", async () => {
  const env = { ADMIN_TOKEN: "secret-admin-token", CF_ACCOUNT_ID: "acct1", CF_ANALYTICS_TOKEN: "tok1", ASSETS };
  const html = await withFetch(fakeAE({ totalsRow, dailyRows, breakdownRows, topRows, latencyRow, unmetCallerRows, unmetEndpointRows, unmetValueRows }), async () => {
    const req = new Request("https://assets.local/admin/usage?format=html", { method: "GET", headers: { authorization: "Bearer secret-admin-token" } });
    return (await worker.fetch(req, env, {})).text();
  });
  assert.match(html, /Unmet requests \(30 days\)/);
  assert.match(html, /NMDP multiple allele codes/);
  assert.match(html, /9\/10 ×1/);
  assert.match(html, /v-investigate/);
  assert.match(html, /What it would take/);
  assert.ok(!html.includes("a:00ff00ff00ff00ff"), "caller buckets are counted, not listed");
});
