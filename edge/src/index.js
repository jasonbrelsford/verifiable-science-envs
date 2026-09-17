// HLA-Verify API on Cloudflare Workers — routing, keys, rate limits, usage metering.
// Deterministic, no LLM: every verdict is a lookup into tables precomputed from
// the pinned IPD-IMGT/HLA release by the HLA-Bench grader engine (see engine.js).
// Stores nothing: request bodies are processed in memory and discarded; usage
// metering records counts per key label, never content.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { createEngine, FRAMEWORKS } from "./engine.js";
import manifest from "../public/manifest.json" with { type: "json" };
import { DOCS_HTML, openapi, PRICING_HTML, CHECKOUT_SUCCESS_HTML } from "./docs.js";
import { parseKeys, TIER_LIMITS, limitsFor } from "./keys.js";
import { doVerify, doNormalize, doAllele, doMatch, doTypingCheck, doCompat, doGlString,
  doBetaSignup, doResearchAccess, RESERVED_PREFIXES } from "./handlers.js";
import { handleMcp } from "./mcp.js";
import { handleDiscovery } from "./discovery.js";
import { handleStripeWebhook, resolveCheckoutSuccess } from "./stripe.js";
import { getPricing, createCheckoutSession } from "./pricing.js";
import { oauthConfig, handleOAuth, authorizeMcp } from "./oauth.js";
import { DailyQuota, spendQuota, quotaHeaders, quotaDetail, retryAfterSeconds, isBillablePath,
  BILLABLE_TOOLS } from "./quota.js";

let STARTED = 0; // Workers freeze the clock at module load; start it on the first request
const PRICING_NOTE = "see https://api.hlaverify.com/pricing";
const ANON_LIMIT_NOTE = `${TIER_LIMITS.free.calls} calls/day per IP and 60 requests/minute without an API key — ` +
  `keys for labs, LIMS vendors and agent platforms: ${PRICING_NOTE}`;

let engine = null;
function getEngine(env) {
  if (!engine) {
    engine = createEngine({
      manifest,
      loadShard: async (sh) => {
        const r = await env.ASSETS.fetch(`https://assets.local/data/${sh}.json`);
        return r.ok ? r.json() : null;
      },
    });
  }
  return engine;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key, authorization, mcp-protocol-version, mcp-method, mcp-name",
  "access-control-max-age": "86400",
  // Without this, browser JS can read none of the headers below — including the
  // whole quota contract /docs tells callers to read. Same mechanism the Server
  // Card (discovery.js) and the OAuth challenge (oauth.js) already use.
  "access-control-expose-headers": "x-hla-verify-release, x-hla-verify-tier, x-hla-verify-daily-limit, " +
    "x-hla-verify-daily-remaining, x-hla-verify-daily-reset, x-hla-verify-max-typings, retry-after",
};
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-hla-verify-release": manifest.release, ...CORS, ...extra },
  });
}
const err = (status, detail, extra = {}) => json({ detail }, status, extra);
const tierHeader = (who) => ({ "x-hla-verify-tier": who.tier });

// Tier -> per-minute rate-limit binding (the burst dial; the daily quota is
// quota.js). "free" (anonymous) is metered by IP on RL; "enterprise" is
// uncapped; the rest are metered by the presented key. "pro" is the legacy name
// for "lab" and shares its limiter.
function limiterFor(env, tier) {
  if (tier === "starter") return env.RL_STARTER;
  if (tier === "lab" || tier === "pro") return env.RL_LAB;
  if (tier === "scale") return env.RL_SCALE;
  return null;
}

async function authorize(req, env) {
  let presented = req.headers.get("x-api-key") || "";
  const bearer = req.headers.get("authorization") || "";
  if (!presented && bearer.toLowerCase().startsWith("bearer ")) presented = bearer.slice(7).trim();

  if (presented) return authorizeKey(presented, env);

  if (env.PUBLIC_ACCESS === "0") return err(401, "missing or invalid X-API-Key");
  if (env.RL) {
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    try {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return err(429, `rate limited: ${ANON_LIMIT_NOTE}`);
    } catch (_) { /* limiter unavailable: fail open */ }
  }
  return { label: "anonymous", tier: "free", keyed: false };
}

// A presented API key -> caller identity or a 401/429 Response. Shared by
// authorize() and by OAuth access tokens on /mcp (oauth.js), which carry a key.
// `keyRef` is the presented key itself; it never leaves the request beyond
// quota.js, which hashes it into this caller's daily-counter name so two keys
// can never share a counter and an OAuth token counts against its own key.
async function authorizeKey(presented, env) {
  const keys = parseKeys(env.HLA_VERIFY_API_KEYS);
  if (keys.has(presented)) {
    const { label, tier } = keys.get(presented);
    return { label, tier, keyed: true, keyRef: presented };
  }
  if (env.KEYS) {
    // The KEYS namespace also holds records that are not keys: the free-beta
    // list under "beta/" and research access applications under "research/"
    // (handlers.js RESERVED_PREFIXES). Any KV value that parses as truthy JSON
    // is treated below as a starter key, so a prefixed record must never be
    // looked up as one: without this guard, presenting
    // "beta/someone@example.com" or "research/someone@example.com" as an
    // X-API-Key would authenticate. Issued keys are "hlv_" + base64url and
    // contain no "/". A new prefix in that namespace belongs in that list.
    if (RESERVED_PREFIXES.some((p) => presented.startsWith(p))) return err(401, "missing or invalid X-API-Key");
    let rec = null;
    try {
      const raw = await env.KEYS.get(presented);
      rec = raw ? JSON.parse(raw) : null;
    } catch (_) { /* malformed record: treat as absent */ }
    if (rec) {
      if (rec.status === "revoked") return err(401, "API key revoked");
      const tier = rec.tier || "starter";
      const rl = limiterFor(env, tier);
      if (rl) {
        try {
          const { success } = await rl.limit({ key: presented });
          if (!success) return err(429, `rate limited for the ${tier} tier (${limitsFor(tier).burst}) — upgrade, ${PRICING_NOTE}`);
        } catch (_) { /* limiter unavailable: fail open */ }
      }
      return { label: rec.label || "self-serve", tier, keyed: true, keyRef: presented };
    }
  }
  return err(401, "missing or invalid X-API-Key");
}

function meter(env, ctx, who, endpoint, status, units, ms) {
  if (!env.USAGE) return;
  try {
    env.USAGE.writeDataPoint({
      indexes: [who.label],
      blobs: [who.label, endpoint, manifest.release, String(status), who.keyed ? "keyed" : "anon", who.tier],
      doubles: [units, ms],
    });
  } catch (_) { /* metering must never break a verdict */ }
}

// `extra` is the caller's quota headers: a request rejected here has already
// been charged, so it must still be told what it has left.
async function readJson(req, extra = {}) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return [null, err(415, "send application/json", extra)];
  let body;
  try { body = await req.json(); } catch (_) { return [null, err(400, "malformed JSON body", extra)]; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return [null, err(422, "body must be a JSON object", extra)];
  return [body, null];
}

export default {
  async fetch(req, env, ctx) {
    if (!STARTED) STARTED = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Pre-connection MCP discovery (Server Card + AI Catalog); owns its own
    // CORS/ETag handling, including preflight, so it routes before OPTIONS.
    const discovery = await handleDiscovery(req, path);
    if (discovery) return discovery;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Never serve the precomputed tables directly: the API is the product; the
    // reference data are CC-BY-ND and not redistributed in bulk.
    if (path.startsWith("/data/") || path === "/manifest.json") return err(404, "Not Found");

    if (path === "/healthz")
      return json({ ok: true, release: manifest.release, alleles: manifest.alleles, uptime_s: Math.floor((Date.now() - STARTED) / 1000) });
    // /docs, /openapi.json and /pricing all read the same cached Stripe answer:
    // the pricing page publishes it, and the other two only use it to decide
    // whether to claim self-serve checkout works. getPricing() never throws and
    // never blocks on Stripe once the cache is warm.
    if (path === "/" || path === "/docs")
      return new Response(DOCS_HTML(manifest, await getPricing(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", ...CORS } });
    if (path === "/openapi.json")
      return json(openapi(manifest, await getPricing(env)), 200, { "cache-control": "public, max-age=300" });
    if (path === "/llms.txt") return Response.redirect("https://hlaverify.com/llms.txt", 302);

    // Prices come from Stripe (pricing.js), so the page is cached for a minute
    // rather than five: the server-side cache already holds Stripe calls down to
    // one per ten minutes, and a short browser cache is what makes "change the
    // price in Stripe, reload the page" behave the way the owner expects.
    if (path === "/pricing") {
      if (req.method !== "GET") return err(405, "GET /pricing");
      return new Response(PRICING_HTML(manifest, await getPricing(env)),
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", ...CORS } });
    }

    // Landing page after Stripe Checkout redirects back; shows the issued key once.
    if (path === "/checkout/success") {
      if (req.method !== "GET") return err(405, "GET /checkout/success?session_id=...");
      const result = await resolveCheckoutSuccess(url.searchParams.get("session_id") || "", env);
      return new Response(CHECKOUT_SUCCESS_HTML(manifest, result),
        { status: result.status === "not_found" ? 404 : 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS } });
    }

    // Self-serve key issuance: verifies its own signature, no API key needed.
    if (path === "/webhooks/stripe") {
      if (req.method !== "POST") return err(405, "POST (signed webhook)");
      return handleStripeWebhook(req, env);
    }

    // OAuth sign-in for /mcp (oauth.js). Off unless OAUTH_ENABLED=1 plus its
    // secret and KV binding; otherwise these paths fall through to the 404 below.
    if (path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) {
      const oauth = oauthConfig(env);
      if (oauth) return handleOAuth(req, env, oauth, url, path, { json, err });
    }

    // Remote MCP endpoint: stateless Streamable HTTP transport, one JSON
    // response per POST. Same keys, same rate limits, same engine as /v1/*.
    if (path === "/mcp") {
      if (req.method === "GET")
        return json({ detail: "GET not supported on /mcp", hint: "POST a JSON-RPC 2.0 message (MCP Streamable HTTP transport)." }, 405);
      if (req.method !== "POST") return err(405, "POST JSON-RPC 2.0 to /mcp");
      const oauth = oauthConfig(env);
      const who = oauth ? await authorizeMcp(req, env, oauth, url, { authorize, authorizeKey, err }) : await authorize(req, env);
      if (who instanceof Response) return who;
      const t0 = Date.now();
      const eng = getEngine(env);
      // The daily quota is charged per billable tools/call, not per POST, so an
      // initialize handshake, tools/list or server/discover costs nothing — the
      // same rule the REST side applies to /docs and /openapi.json. handleMcp
      // calls spend() before running the tool and renders a refusal as a tool
      // error, so an over-quota agent gets a readable frame, never a broken one.
      let q = null;
      const spend = async (tool) => {
        if (!BILLABLE_TOOLS.has(tool)) return null;
        q = await spendQuota(env, who, req);
        return q.ok ? null : quotaDetail(q);
      };
      const resp = await handleMcp(req, eng, who, manifest,
        (tool, status, units) => meter(env, ctx, who, `mcp:${tool}`, status, units, Date.now() - t0), env, spend);
      const body = await resp.text();
      return new Response(body || null, {
        status: resp.status,
        headers: {
          ...(body ? { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } : {}),
          "x-hla-verify-release": manifest.release,
          ...(q ? quotaHeaders(q) : tierHeader(who)),
          ...(q && !q.ok ? { "retry-after": String(retryAfterSeconds(q)) } : {}),
          ...CORS,
        },
      });
    }

    if (!path.startsWith("/v1/")) return err(404, "Not Found");

    const who = await authorize(req, env);
    if (who instanceof Response) return who;
    const t0 = Date.now();

    // Daily quota. Charged once per request to a billable route, before the
    // body is validated — the same rule the per-minute limiter already uses, so
    // a malformed request costs what a good one does. /v1/beta-signup and an
    // unknown /v1/* path are not billable and never reach this.
    // Metering records counts, never content: /v1/allele/{name} carries the
    // requested name in its path, so the endpoint label is the route, not the path.
    const endpoint = path.startsWith("/v1/allele/") ? "allele" : path.slice(4);
    let q = null;
    if (isBillablePath(path)) {
      q = await spendQuota(env, who, req);
      if (!q.ok) {
        const headers = { ...quotaHeaders(q), "retry-after": String(retryAfterSeconds(q)) };
        meter(env, ctx, who, endpoint, 429, 0, Date.now() - t0);
        return err(429, quotaDetail(q), headers);
      }
    }
    const hdrs = q ? quotaHeaders(q) : tierHeader(who);

    const eng = getEngine(env);
    try {
      if (path === "/v1/verify") {
        if (req.method !== "POST") return err(405, "POST {\"text\": ...}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doVerify(eng, manifest, body.text);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "verify", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      if (path === "/v1/normalize") {
        if (req.method !== "POST") return err(405, "POST {\"typings\": [...]}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doNormalize(eng, manifest, body.typings, { tier: who.tier, cap: q.maxTypings });
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "normalize", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      if (path.startsWith("/v1/allele/")) {
        if (req.method !== "GET") return err(405, "GET /v1/allele/{name}", hdrs);
        let name;
        try { name = decodeURIComponent(url.pathname.slice("/v1/allele/".length)); } catch (_) { return err(400, "bad name encoding", hdrs); }
        const r = await doAllele(eng, manifest, name);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "allele", r.status, r.units, Date.now() - t0);
        return json(r.body, r.status, hdrs);
      }
      if (path === "/v1/match") {
        if (req.method !== "POST") return err(405, "POST {\"framework\": \"8/8\", \"recipient\": {...}, \"donor\": {...}}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doMatch(eng, manifest, body.framework, body.recipient, body.donor);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "match", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      if (path === "/v1/typing/check") {
        if (req.method !== "POST") return err(405, "POST {\"typing\": {...}}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doTypingCheck(eng, manifest, body.typing);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "typing/check", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      if (path === "/v1/compat") {
        if (req.method !== "POST") return err(405, "POST {\"recipient\": {...}, \"donor\": {...}}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doCompat(eng, manifest, body.recipient, body.donor);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "compat", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      if (path === "/v1/glstring") {
        if (req.method !== "POST") return err(405, "POST {\"gl\": \"...\"}", hdrs);
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doGlString(eng, manifest, body.gl);
        if (!r.ok) return err(r.status, r.detail, hdrs);
        meter(env, ctx, who, "glstring", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      // Starts a Stripe Checkout Session for a paid tier and hands back the
      // hosted url. Not billable — buying a bigger quota must not cost a call
      // out of the small one you have — but it goes through the same authorize()
      // above, so the anonymous 60/min per-IP limiter already rate-limits it.
      if (path === "/v1/checkout") {
        if (req.method !== "POST") return err(405, "POST {\"tier\": \"starter\"|\"lab\"|\"scale\"}");
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        // success_url and cancel_url must land back on THIS Worker.
        // hlaverify.com only routes /v1/* here — /checkout/success on that host
        // is the marketing site — so an apex or www request is sent home to
        // api.hlaverify.com. Any other host (wrangler dev, a preview) keeps its
        // own origin so local checkout redirects locally.
        const origin = /(^|\.)hlaverify\.com$/.test(url.hostname) ? "https://api.hlaverify.com" : url.origin;
        const r = await createCheckoutSession(env, body, { origin });
        if (!r.ok) {
          meter(env, ctx, who, "checkout", r.status, 0, Date.now() - t0);
          return err(r.status, r.detail, hdrs);
        }
        meter(env, ctx, who, "checkout", 200, 0, Date.now() - t0);
        return json({ url: r.url, session_id: r.id, tier: r.tier, price: r.price, amount: r.amount,
          currency: r.currency, interval: r.interval, promotion_code_applied: r.promotion_code_applied }, 200, hdrs);
      }
      // Free public beta notification list. Same anonymous limiter as every
      // other /v1/* route, so it cannot be spammed faster than 60/min per IP —
      // but not billable: joining the list must never cost a caller a call.
      if (path === "/v1/beta-signup") {
        if (req.method !== "POST") return err(405, "POST {\"email\": \"...\"}");
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doBetaSignup(env, manifest, body, req.headers.get("cf-ipcountry"));
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "beta-signup", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      // Research and education access applications. Same rules as the beta list
      // above: the anonymous limiter covers it, it is never billable (applying
      // for free access must not cost a call out of the free tier), and the
      // record it writes is not a key (handlers.js RESERVED_PREFIXES).
      if (path === "/v1/research-access") {
        if (req.method !== "POST") return err(405, "POST {\"email\": \"...\", \"institution\": \"...\", \"use_case\": \"...\"}");
        const [body, e] = await readJson(req, hdrs); if (e) return e;
        const r = await doResearchAccess(env, manifest, body, req.headers.get("cf-ipcountry"));
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "research-access", 200, r.units, Date.now() - t0);
        return json(r.body, 200, hdrs);
      }
      return err(404, "Not Found");
    } catch (ex) {
      meter(env, ctx, who, endpoint, 500, 0, Date.now() - t0);
      return err(500, "internal error computing the verdict; nothing was stored", hdrs);
    }
  },
};

export { FRAMEWORKS };
// The daily-quota counter. A Durable Object class has to be exported from the
// Worker's entrypoint for the binding in wrangler.jsonc to find it.
export { DailyQuota };
