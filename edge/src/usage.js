// Usage analytics, read from the Cloudflare Analytics Engine dataset the Worker
// already writes to (index.js meter()). The Worker's USAGE binding is
// write-only; every read here goes through the Analytics Engine SQL API:
//   POST https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql
//   Authorization: Bearer <CF_ANALYTICS_TOKEN>, raw SQL as the request body.
// https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
// https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
//
// SCHEMA (index.js meter()): indexes[0] = key label (index1); blobs = [label,
// endpoint, release, status, "keyed"|"anon", tier] (blob1..blob6); doubles =
// [units, ms] (double1, double2).
//
// SAMPLING. Analytics Engine may sample writes, so count() undercounts. Every
// row carries `_sample_interval`; the documented fix is sum(_sample_interval)
// for counts and sum(_sample_interval * doubleN) for a weighted sum, with
// sum(_sample_interval * doubleN) / sum(_sample_interval) for a weighted
// average. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
//
// QUANTILES. The SQL reference's aggregate-functions page documents exactly one
// quantile function: quantileExactWeighted(q)(column, weight_column), used
// below for p50/p95 latency, weighted by _sample_interval so a sampled deployment
// still reports an unbiased percentile. countIf/sumIf/avgIf (conditional
// aggregates) let one query cover several time windows at once, which is how
// the per-caller endpoint stays a single SQL call for its 60s cache to protect.
// https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/
//
// NOT INDEPENDENTLY VERIFIED IN THE DOCS: the exact escaping rule for a literal
// single quote inside a string (the Literals reference page shows only the
// quoting character, not how to escape one within a value). This dialect is
// ClickHouse-derived and ClickHouse doubles an embedded quote ('' ), which is
// what sqlString() below does; labels are also restricted to a safe character
// class first (see LABEL_RE) so this is defense in depth, not the only guard.
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { limitsFor } from "./keys.js";

const DATASET = "hlaverify_usage";
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ------------------------------------------------------------ label safety
// Every real label (keys.js parseKeys, stripe.js "stripe:<customer>" /
// "self-serve", or "anonymous") already fits this set; it exists so a hand-typed
// HLA_VERIFY_API_KEYS entry can never inject SQL through index1, and so a
// caller whose label somehow doesn't fit gets a clean refusal instead of a
// malformed query. Labels may contain colons (keys.js) so ":" is included.
export const LABEL_RE = /^[A-Za-z0-9:_.@ -]+$/;
export const MAX_LABEL = 200;

export function isValidLabel(label) {
  return typeof label === "string" && label.length > 0 && label.length <= MAX_LABEL && LABEL_RE.test(label);
}

// ClickHouse-style literal: wrap in single quotes, double any embedded one.
// Callers must run isValidLabel() first: this alone is not the injection
// guard, the character-class check is.
export function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ------------------------------------------------------------ the SQL API
export function usageConfigured(env) {
  return Boolean(env && env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID);
}

// POSTs `sql` as the raw request body and returns the `data` rows. Throws on a
// non-2xx response or a body that isn't the expected shape; callers turn that
// into a 502, never a stack trace in the response.
export async function queryAE(env, sql) {
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: sql,
  });
  let body = null;
  try { body = await resp.json(); } catch (_) { /* fall through to the status check below */ }
  if (!resp.ok || !body || !Array.isArray(body.data)) {
    const detail = body && body.errors ? JSON.stringify(body.errors) : `Analytics Engine SQL API returned ${resp.status}`;
    throw new Error(detail);
  }
  return body.data;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round = (v) => Math.round(num(v));

// ------------------------------------------------------- GET /v1/usage
// One query, scoped to the caller's own label, windowed with conditional
// aggregates so today/7d/30d, calls and units, all come back in one round
// trip, the thing the 60s cache exists to make cheap even so.
export function buildCallerUsageSQL(label) {
  return `SELECT blob2 AS endpoint, blob4 AS status,
  sumIf(_sample_interval, timestamp >= toStartOfDay(now())) AS calls_today,
  sumIf(_sample_interval, timestamp >= now() - INTERVAL '7' DAY) AS calls_7d,
  sumIf(_sample_interval, timestamp >= now() - INTERVAL '30' DAY) AS calls_30d,
  sumIf(_sample_interval * double1, timestamp >= toStartOfDay(now())) AS units_today,
  sumIf(_sample_interval * double1, timestamp >= now() - INTERVAL '7' DAY) AS units_7d,
  sumIf(_sample_interval * double1, timestamp >= now() - INTERVAL '30' DAY) AS units_30d
FROM ${DATASET}
WHERE index1 = ${sqlString(label)} AND timestamp > now() - INTERVAL '30' DAY
GROUP BY endpoint, status
ORDER BY endpoint, status`;
}

const emptyWindow = () => ({ calls: 0, units: 0, by_endpoint: {}, by_status: {} });

export async function getCallerUsage(env, label) {
  const rows = await queryAE(env, buildCallerUsageSQL(label));
  const windows = { today: emptyWindow(), "7d": emptyWindow(), "30d": emptyWindow() };
  for (const row of rows) {
    const endpoint = row.endpoint || "unknown";
    const status = String(row.status || "unknown");
    for (const [key, sfx] of [["today", "today"], ["7d", "7d"], ["30d", "30d"]]) {
      const calls = round(row[`calls_${sfx}`]);
      const units = num(row[`units_${sfx}`]);
      if (!calls && !units) continue;
      const w = windows[key];
      w.calls += calls;
      w.units += units;
      w.by_endpoint[endpoint] = (w.by_endpoint[endpoint] || 0) + calls;
      w.by_status[status] = (w.by_status[status] || 0) + calls;
    }
  }
  for (const w of Object.values(windows)) w.units = Math.round(w.units * 100) / 100;
  return windows;
}

// -------------------------------------------------------- 60s cache
// Keyed by label, so a dashboard polling its own usage cannot hammer the SQL
// API. The Cache API (caches.default) exists in Workers but not under plain
// `node --test`; the in-isolate Map fallback below is the same trick
// pricing.js's cacheStore() uses, and is a real (if smaller) cache in
// production too since module state lives as long as the isolate.
const USAGE_CACHE_TTL_S = 60;
const usageCacheUrl = (label) => `https://usage.hlaverify.internal/v1/usage/${encodeURIComponent(label)}`;
let memoryUsageCache = new Map();

function usageCacheStore(env) {
  const api = (env && env.__CACHES) || (typeof caches !== "undefined" ? caches : null);
  if (!api || !api.default) {
    return {
      async read(label) {
        const hit = memoryUsageCache.get(label);
        if (hit && hit.expires > Date.now()) return hit.body;
        return null;
      },
      async write(label, body) {
        memoryUsageCache.set(label, { body, expires: Date.now() + USAGE_CACHE_TTL_S * 1000 });
      },
    };
  }
  return {
    async read(label) {
      try {
        const hit = await api.default.match(new Request(usageCacheUrl(label)));
        return hit ? await hit.json() : null;
      } catch (_) { return null; }
    },
    async write(label, body) {
      try {
        await api.default.put(new Request(usageCacheUrl(label)), new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${USAGE_CACHE_TTL_S}` },
        }));
      } catch (_) { /* cache unavailable: served uncached this once */ }
    },
  };
}

// Test seam only: forget the in-isolate copy between tests.
export function _resetUsageCache() { memoryUsageCache = new Map(); }

// GET /v1/usage: a keyed caller's own usage plus the tier's published quota,
// scoped strictly to index1 = the caller's own label. Anonymous callers (no
// key) are refused: there is no per-caller label to scope to, and anonymous
// traffic is counted per IP-day in quota.js, not in this dataset in a way that
// could be shown back safely. `who` is index.js authorize()'s result.
export async function handleUsageRequest(req, env, who, manifest, { json, err }) {
  if (req.method !== "GET") return err(405, "GET /v1/usage");
  if (!who.keyed) {
    return err(401, "usage reporting requires an API key: anonymous calls are counted per IP-day, not per caller. " +
      "Get a key: see https://api.hlaverify.com/pricing (or POST /v1/checkout, or email hello@hlaverify.com).");
  }
  if (!usageConfigured(env)) return err(503, "usage reporting not configured");
  if (!isValidLabel(who.label)) return err(400, "usage reporting is unavailable for this key right now; email hello@hlaverify.com");

  const store = usageCacheStore(env);
  const cached = await store.read(who.label);
  if (cached) return json(cached, 200, { "cache-control": "private, max-age=60" });

  let usage;
  try {
    usage = await getCallerUsage(env, who.label);
  } catch (_) {
    return err(502, "usage reporting is temporarily unavailable; try again shortly");
  }
  const lim = limitsFor(who.tier);
  const body = {
    release: manifest.release,
    tier: who.tier,
    daily_quota: lim.calls === null ? "unlimited" : lim.calls,
    max_typings: lim.typings,
    usage,
  };
  await store.write(who.label, body);
  return json(body, 200, { "cache-control": "private, max-age=60" });
}

// ------------------------------------------------------- GET /admin/usage
const ADMIN_WINDOWS = [["24h", "1"], ["7d", "7"], ["30d", "30"]];

export function buildAdminTotalsSQL() {
  const cols = ADMIN_WINDOWS.map(([name, days]) =>
    `sumIf(_sample_interval, timestamp >= now() - INTERVAL '${days}' DAY) AS calls_${name},\n` +
    `  sumIf(_sample_interval, blob5 = 'anon' AND timestamp >= now() - INTERVAL '${days}' DAY) AS anon_${name}`
  ).join(",\n  ");
  return `SELECT\n  ${cols}\nFROM ${DATASET}\nWHERE timestamp > now() - INTERVAL '30' DAY`;
}

export function buildAdminUniqueLabelsSQL(days) {
  return `SELECT count(DISTINCT blob1) AS n FROM ${DATASET} WHERE blob5 = 'keyed' AND timestamp >= now() - INTERVAL '${days}' DAY`;
}

export function buildAdminDailySeriesSQL() {
  return `SELECT toStartOfDay(timestamp) AS day, sum(_sample_interval) AS calls\nFROM ${DATASET}\n` +
    `WHERE timestamp > now() - INTERVAL '30' DAY\nGROUP BY day\nORDER BY day`;
}

// One query for endpoint, tier and status-class breakdowns together: each row
// is (endpoint, tier, status, calls) over the same 30-day window, bucketed
// three ways client-side rather than run as three separate queries.
export function buildAdminBreakdownSQL() {
  return `SELECT blob2 AS endpoint, blob6 AS tier, blob4 AS status, sum(_sample_interval) AS calls\nFROM ${DATASET}\n` +
    `WHERE timestamp > now() - INTERVAL '30' DAY\nGROUP BY endpoint, tier, status\nORDER BY calls DESC`;
}

export function buildAdminTopLabelsSQL() {
  return `SELECT blob1 AS label, sum(_sample_interval) AS calls\nFROM ${DATASET}\n` +
    `WHERE blob5 = 'keyed' AND timestamp > now() - INTERVAL '30' DAY\nGROUP BY label\nORDER BY calls DESC\nLIMIT 20`;
}

export function buildAdminLatencySQL() {
  return `SELECT quantileExactWeighted(0.5)(double2, _sample_interval) AS p50_ms,\n` +
    `  quantileExactWeighted(0.95)(double2, _sample_interval) AS p95_ms,\n` +
    `  sum(_sample_interval * double2) / sum(_sample_interval) AS avg_ms,\n` +
    `  max(double2) AS max_ms\nFROM ${DATASET}\nWHERE timestamp > now() - INTERVAL '30' DAY`;
}

const statusClass = (status) => {
  const c = String(status || "")[0];
  return c === "2" ? "2xx" : c === "4" ? "4xx" : c === "5" ? "5xx" : "other";
};

export async function getAdminUsage(env) {
  const [totalsRows, uniq24, uniq7, uniq30, daily, breakdown, top, latencyRows] = await Promise.all([
    queryAE(env, buildAdminTotalsSQL()),
    queryAE(env, buildAdminUniqueLabelsSQL("1")),
    queryAE(env, buildAdminUniqueLabelsSQL("7")),
    queryAE(env, buildAdminUniqueLabelsSQL("30")),
    queryAE(env, buildAdminDailySeriesSQL()),
    queryAE(env, buildAdminBreakdownSQL()),
    queryAE(env, buildAdminTopLabelsSQL()),
    queryAE(env, buildAdminLatencySQL()),
  ]);

  const t = totalsRows[0] || {};
  const uniqueLabels = { "24h": round(uniq24[0] && uniq24[0].n), "7d": round(uniq7[0] && uniq7[0].n), "30d": round(uniq30[0] && uniq30[0].n) };
  const totals = {};
  for (const [name] of ADMIN_WINDOWS) {
    totals[name] = { calls: round(t[`calls_${name}`]), unique_labels: uniqueLabels[name], anonymous_calls: round(t[`anon_${name}`]) };
  }

  const by_endpoint = {}, by_tier = {}, by_status_class = { "2xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  let total30 = 0, nonOk = 0;
  for (const row of breakdown) {
    const calls = round(row.calls);
    by_endpoint[row.endpoint || "unknown"] = (by_endpoint[row.endpoint || "unknown"] || 0) + calls;
    by_tier[row.tier || "unknown"] = (by_tier[row.tier || "unknown"] || 0) + calls;
    const cls = statusClass(row.status);
    by_status_class[cls] += calls;
    total30 += calls;
    if (cls !== "2xx") nonOk += calls;
  }

  const daily_series = daily.map((r) => ({ day: r.day, calls: round(r.calls) }));
  const top_labels = top.map((r) => ({ label: r.label, calls: round(r.calls) }));
  const lat = latencyRows[0] || {};
  const numOrNull = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

  return {
    totals,
    daily_series,
    by_endpoint,
    by_tier,
    by_status_class,
    top_labels,
    latency_ms: { p50: numOrNull(lat.p50_ms), p95: numOrNull(lat.p95_ms), avg: numOrNull(lat.avg_ms), max: numOrNull(lat.max_ms) },
    error_rate: total30 > 0 ? Math.round((nonOk / total30) * 10000) / 10000 : 0,
  };
}

// Constant-time-ish string compare for the admin bearer token. Workers do not
// expose Node's crypto.timingSafeEqual; this is a small manual equivalent
// (length is not secret: an admin token's length leaking costs nothing a
// brute-force guess didn't already have).
function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !presented || !expected) return false;
  const a = new TextEncoder().encode(presented), b = new TextEncoder().encode(expected);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

// ---------------------------------------------------------------- HTML
// Same styling as docs.js (same CSS variables and shapes) so /admin/usage
// looks like the rest of the deployment's operator-facing pages.
function svgBars(items, { width = 640, barHeight = 16, gap = 5, color = "#2F5D3A" } = {}) {
  if (!items.length) return `<p class="mut">No data in this window.</p>`;
  const max = Math.max(1, ...items.map((i) => i.value));
  const labelW = 190;
  const chartW = Math.max(60, width - labelW - 70);
  const rowH = barHeight + gap;
  const rows = items.map((it, i) => {
    const y = i * rowH;
    const w = Math.max(1, Math.round((it.value / max) * chartW));
    return `<text x="0" y="${y + barHeight - 3}" font-size="11" fill="currentColor">${esc(String(it.label))}</text>` +
      `<rect x="${labelW}" y="${y}" width="${w}" height="${barHeight}" rx="3" fill="${color}"></rect>` +
      `<text x="${labelW + w + 6}" y="${y + barHeight - 3}" font-size="11" fill="currentColor">${it.value.toLocaleString("en-US")}</text>`;
  }).join("\n");
  const height = items.length * rowH;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="bar chart">${rows}</svg>`;
}

const sortedEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

export function renderAdminHTML(manifest, data) {
  const t = data.totals;
  const statTiles = ["24h", "7d", "30d"].map((w) =>
    `<div class="tile"><div class="mut">${w}</div><div class="big">${t[w].calls.toLocaleString("en-US")}</div>` +
    `<div class="mut">calls · ${t[w].unique_labels.toLocaleString("en-US")} unique labels · ${t[w].anonymous_calls.toLocaleString("en-US")} anonymous calls</div></div>`
  ).join("\n");
  const dailyItems = data.daily_series.map((d) => ({ label: String(d.day).slice(0, 10), value: d.calls }));
  const endpointItems = sortedEntries(data.by_endpoint).map(([k, v]) => ({ label: k, value: v }));
  const tierItems = sortedEntries(data.by_tier).map(([k, v]) => ({ label: k, value: v }));
  const statusItems = ["2xx", "4xx", "5xx", "other"].filter((k) => data.by_status_class[k])
    .map((k) => ({ label: k, value: data.by_status_class[k] }));
  const topItems = data.top_labels.map((r) => ({ label: r.label, value: r.calls }));
  const lat = data.latency_ms;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify usage</title>
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:900px;margin:0 auto;padding:28px 22px 60px}
h1{font-family:Georgia,serif;font-size:1.8rem;margin:.2em 0}h2{font-family:Georgia,serif;color:var(--green);margin-top:2em;border-bottom:1px solid var(--line);padding-bottom:.2em}
.mut{color:var(--mut);font-size:.85rem}
.tiles{display:flex;gap:16px;flex-wrap:wrap}
.tile{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:200px}
.big{font-size:1.6rem;font-weight:700;color:var(--green)}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}
</style></head><body><div class="wrap">
<h1>HLA-Verify operator usage</h1>
<p class="mut">Release ${esc(manifest.release)}. Counts are sample-corrected (sum of _sample_interval); Analytics Engine may sample writes under load.</p>
<h2>Totals</h2>
<div class="tiles">${statTiles}</div>
<p class="mut">Error rate (30d, non-2xx / total): ${(data.error_rate * 100).toFixed(2)}%. Latency p50 ${lat.p50 ?? "n/a"} ms, p95 ${lat.p95 ?? "n/a"} ms, avg ${lat.avg ?? "n/a"} ms, max ${lat.max ?? "n/a"} ms.</p>
<h2>Daily calls (30 days)</h2>
<div class="card">${svgBars(dailyItems, { width: 820 })}</div>
<h2>By endpoint (30 days)</h2>
<div class="card">${svgBars(endpointItems)}</div>
<h2>By tier (30 days)</h2>
<div class="card">${svgBars(tierItems)}</div>
<h2>By status class (30 days)</h2>
<div class="card">${svgBars(statusItems)}</div>
<h2>Top 20 key labels by calls (30 days)</h2>
<div class="card">${svgBars(topItems)}</div>
</div></body></html>`;
}

// GET /admin/usage, protected by ADMIN_TOKEN (a secret distinct from every
// customer-facing key), never authorize()'s key store. JSON by default;
// text/html with an Accept header or ?format=html.
export async function handleAdminUsageRequest(req, env, manifest, { json, err, CORS }) {
  if (req.method !== "GET") return err(405, "GET /admin/usage");
  if (!env.ADMIN_TOKEN) return err(503, "admin usage dashboard not configured");
  const auth = req.headers.get("authorization") || "";
  const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!tokenMatches(presented, env.ADMIN_TOKEN)) return err(401, "missing or invalid admin token");
  if (!usageConfigured(env)) return err(503, "usage reporting not configured");

  let data;
  try {
    data = await getAdminUsage(env);
  } catch (_) {
    return err(502, "usage reporting is temporarily unavailable; try again shortly");
  }

  const url = new URL(req.url);
  const wantsHtml = (req.headers.get("accept") || "").includes("text/html") || url.searchParams.get("format") === "html";
  if (wantsHtml) {
    return new Response(renderAdminHTML(manifest, data),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS } });
  }
  return json({ release: manifest.release, ...data }, 200, { "cache-control": "no-store" });
}
