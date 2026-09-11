// HLA-Verify API on Cloudflare Workers — routing, keys, rate limits, usage metering.
// Deterministic, no LLM: every verdict is a lookup into tables precomputed from
// the pinned IPD-IMGT/HLA release by the HLA-Bench grader engine (see engine.js).
// Stores nothing: request bodies are processed in memory and discarded; usage
// metering records counts per key label, never content.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { createEngine, FRAMEWORKS } from "./engine.js";
import manifest from "../public/manifest.json" with { type: "json" };
import { DOCS_HTML, openapi, PRICING_HTML, CHECKOUT_SUCCESS_HTML } from "./docs.js";
import { parseKeys } from "./keys.js";
import { doVerify, doNormalize, doAllele, doMatch } from "./handlers.js";
import { handleMcp } from "./mcp.js";
import { handleStripeWebhook, resolveCheckoutSuccess } from "./stripe.js";

let STARTED = 0; // Workers freeze the clock at module load; start it on the first request
const PRICING_NOTE = "see https://api.hlaverify.com/pricing";
const ANON_LIMIT_NOTE = `60 requests/minute without an API key — keys for labs, LIMS vendors and agent platforms: ${PRICING_NOTE}`;

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
  "access-control-allow-headers": "content-type, x-api-key, authorization",
  "access-control-max-age": "86400",
};
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-hla-verify-release": manifest.release, ...CORS, ...extra },
  });
}
const err = (status, detail) => json({ detail }, status);
const tierHeader = (who) => ({ "x-hla-verify-tier": who.tier });

// Tier -> rate-limit binding. "free" (anonymous) is metered by IP on RL;
// "enterprise" is uncapped; "starter"/"pro" are metered by the presented key.
function limiterFor(env, tier) {
  if (tier === "starter") return env.RL_STARTER;
  if (tier === "pro") return env.RL_PRO;
  return null;
}

async function authorize(req, env) {
  const keys = parseKeys(env.HLA_VERIFY_API_KEYS);
  let presented = req.headers.get("x-api-key") || "";
  const bearer = req.headers.get("authorization") || "";
  if (!presented && bearer.toLowerCase().startsWith("bearer ")) presented = bearer.slice(7).trim();

  if (presented) {
    if (keys.has(presented)) {
      const { label, tier } = keys.get(presented);
      return { label, tier, keyed: true };
    }
    if (env.KEYS) {
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
            if (!success) return err(429, `rate limited for the ${tier} tier — upgrade at ${PRICING_NOTE}`);
          } catch (_) { /* limiter unavailable: fail open */ }
        }
        return { label: rec.label || "self-serve", tier, keyed: true };
      }
    }
    return err(401, "missing or invalid X-API-Key");
  }

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

async function readJson(req) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return [null, err(415, "send application/json")];
  let body;
  try { body = await req.json(); } catch (_) { return [null, err(400, "malformed JSON body")]; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return [null, err(422, "body must be a JSON object")];
  return [body, null];
}

export default {
  async fetch(req, env, ctx) {
    if (!STARTED) STARTED = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Never serve the precomputed tables directly: the API is the product; the
    // reference data are CC-BY-ND and not redistributed in bulk.
    if (path.startsWith("/data/") || path === "/manifest.json") return err(404, "Not Found");

    if (path === "/healthz")
      return json({ ok: true, release: manifest.release, alleles: manifest.alleles, uptime_s: Math.floor((Date.now() - STARTED) / 1000) });
    if (path === "/" || path === "/docs")
      return new Response(DOCS_HTML(manifest), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", ...CORS } });
    if (path === "/openapi.json")
      return json(openapi(manifest), 200, { "cache-control": "public, max-age=300" });
    if (path === "/llms.txt") return Response.redirect("https://hlaverify.com/llms.txt", 302);

    if (path === "/pricing") {
      if (req.method !== "GET") return err(405, "GET /pricing");
      return new Response(PRICING_HTML(manifest, { starterLink: env.STRIPE_STARTER_LINK, proLink: env.STRIPE_PRO_LINK }),
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", ...CORS } });
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

    // Remote MCP endpoint: stateless Streamable HTTP transport, one JSON
    // response per POST. Same keys, same rate limits, same engine as /v1/*.
    if (path === "/mcp") {
      if (req.method === "GET")
        return json({ detail: "GET not supported on /mcp", hint: "POST a JSON-RPC 2.0 message (MCP Streamable HTTP transport)." }, 405);
      if (req.method !== "POST") return err(405, "POST JSON-RPC 2.0 to /mcp");
      const who = await authorize(req, env);
      if (who instanceof Response) return who;
      const t0 = Date.now();
      const eng = getEngine(env);
      const resp = await handleMcp(req, eng, who, manifest, (tool, status, units) => meter(env, ctx, who, `mcp:${tool}`, status, units, Date.now() - t0));
      const body = await resp.text();
      return new Response(body || null, {
        status: resp.status,
        headers: {
          ...(body ? { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } : {}),
          "x-hla-verify-release": manifest.release,
          ...tierHeader(who),
          ...CORS,
        },
      });
    }

    if (!path.startsWith("/v1/")) return err(404, "Not Found");

    const who = await authorize(req, env);
    if (who instanceof Response) return who;
    const t0 = Date.now();
    const eng = getEngine(env);
    try {
      if (path === "/v1/verify") {
        if (req.method !== "POST") return err(405, "POST {\"text\": ...}");
        const [body, e] = await readJson(req); if (e) return e;
        const r = await doVerify(eng, manifest, body.text);
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "verify", 200, r.units, Date.now() - t0);
        return json(r.body, 200, tierHeader(who));
      }
      if (path === "/v1/normalize") {
        if (req.method !== "POST") return err(405, "POST {\"typings\": [...]}");
        const [body, e] = await readJson(req); if (e) return e;
        const r = await doNormalize(eng, manifest, body.typings);
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "normalize", 200, r.units, Date.now() - t0);
        return json(r.body, 200, tierHeader(who));
      }
      if (path.startsWith("/v1/allele/")) {
        if (req.method !== "GET") return err(405, "GET /v1/allele/{name}");
        let name;
        try { name = decodeURIComponent(url.pathname.slice("/v1/allele/".length)); } catch (_) { return err(400, "bad name encoding"); }
        const r = await doAllele(eng, manifest, name);
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "allele", r.status, r.units, Date.now() - t0);
        return json(r.body, r.status, tierHeader(who));
      }
      if (path === "/v1/match") {
        if (req.method !== "POST") return err(405, "POST {\"framework\": \"8/8\", \"recipient\": {...}, \"donor\": {...}}");
        const [body, e] = await readJson(req); if (e) return e;
        const r = await doMatch(eng, manifest, body.framework, body.recipient, body.donor);
        if (!r.ok) return err(r.status, r.detail);
        meter(env, ctx, who, "match", 200, r.units, Date.now() - t0);
        return json(r.body, 200, tierHeader(who));
      }
      return err(404, "Not Found");
    } catch (ex) {
      meter(env, ctx, who, path.slice(4), 500, 0, Date.now() - t0);
      return err(500, "internal error computing the verdict; nothing was stored");
    }
  },
};

export { FRAMEWORKS };
