// HLA-Verify API on Cloudflare Workers — routing, keys, rate limits, usage metering.
// Deterministic, no LLM: every verdict is a lookup into tables precomputed from
// the pinned IPD-IMGT/HLA release by the HLA-Bench grader engine (see engine.js).
// Stores nothing: request bodies are processed in memory and discarded; usage
// metering records counts per key label, never content.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { createEngine, FRAMEWORKS } from "./engine.js";
import manifest from "../public/manifest.json";
import { DOCS_HTML, openapi } from "./docs.js";

let STARTED = 0; // Workers freeze the clock at module load; start it on the first request
const MAX_TEXT = 200_000, MAX_TYPINGS = 5_000, MAX_LOCI = 24, MAX_PER_LOCUS = 4;
const ANON_LIMIT_NOTE = "60 requests/minute without an API key — keys for labs, LIMS vendors and agent platforms: hello@hlaverify.com";

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

function parseKeys(s) {
  const out = new Map();
  for (const part of (s || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i > 0) out.set(p.slice(0, i).trim(), p.slice(i + 1).trim() || "key");
    else out.set(p, "key");
  }
  return out;
}

async function authorize(req, env) {
  const keys = parseKeys(env.HLA_VERIFY_API_KEYS);
  let presented = req.headers.get("x-api-key") || "";
  const bearer = req.headers.get("authorization") || "";
  if (!presented && bearer.toLowerCase().startsWith("bearer ")) presented = bearer.slice(7).trim();
  if (presented) {
    if (keys.has(presented)) return { label: keys.get(presented), keyed: true };
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
  return { label: "anonymous", keyed: false };
}

function meter(env, ctx, who, endpoint, status, units, ms) {
  if (!env.USAGE) return;
  try {
    env.USAGE.writeDataPoint({
      indexes: [who.label],
      blobs: [who.label, endpoint, manifest.release, String(status), who.keyed ? "keyed" : "anon"],
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

function validateTyping(obj, side) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return `${side} must be an object mapping locus -> [reported alleles]`;
  const loci = Object.keys(obj);
  if (loci.length > MAX_LOCI) return `${side}: at most ${MAX_LOCI} loci`;
  for (const l of loci) {
    const v = obj[l];
    if (!Array.isArray(v) || v.length > MAX_PER_LOCUS || !v.every((x) => typeof x === "string" && x.length <= 64))
      return `${side}.${l} must be a list of up to ${MAX_PER_LOCUS} reported allele strings`;
  }
  return null;
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

    if (!path.startsWith("/v1/")) return err(404, "Not Found");

    const who = await authorize(req, env);
    if (who instanceof Response) return who;
    const t0 = Date.now();
    const eng = getEngine(env);
    try {
      if (path === "/v1/verify") {
        if (req.method !== "POST") return err(405, "POST {\"text\": ...}");
        const [body, e] = await readJson(req); if (e) return e;
        if (typeof body.text !== "string") return err(422, "text must be a string");
        if (body.text.length > MAX_TEXT) return err(422, `text must be at most ${MAX_TEXT} characters`);
        const out = await eng.verify(body.text);
        meter(env, ctx, who, "verify", 200, out.tokens.length, Date.now() - t0);
        return json(out);
      }
      if (path === "/v1/normalize") {
        if (req.method !== "POST") return err(405, "POST {\"typings\": [...]}");
        const [body, e] = await readJson(req); if (e) return e;
        if (!Array.isArray(body.typings) || !body.typings.every((s) => typeof s === "string"))
          return err(422, "typings must be a list of strings");
        if (body.typings.length > MAX_TYPINGS) return err(422, `typings must have at most ${MAX_TYPINGS} items`);
        const out = await eng.normalizeBatch(body.typings);
        meter(env, ctx, who, "normalize", 200, body.typings.length, Date.now() - t0);
        return json(out);
      }
      if (path.startsWith("/v1/allele/")) {
        if (req.method !== "GET") return err(405, "GET /v1/allele/{name}");
        let name;
        try { name = decodeURIComponent(url.pathname.slice("/v1/allele/".length)); } catch (_) { return err(400, "bad name encoding"); }
        if (name.length > 64) return err(422, "name too long");
        const { status, body } = await eng.allele(name);
        meter(env, ctx, who, "allele", status, 1, Date.now() - t0);
        return json(body, status);
      }
      if (path === "/v1/match") {
        if (req.method !== "POST") return err(405, "POST {\"framework\": \"8/8\", \"recipient\": {...}, \"donor\": {...}}");
        const [body, e] = await readJson(req); if (e) return e;
        const fw = body.framework ?? "8/8";
        if (!Object.prototype.hasOwnProperty.call(FRAMEWORKS, fw)) return err(422, `framework must be one of ${Object.keys(FRAMEWORKS).sort().join(", ")}`);
        const v = validateTyping(body.recipient, "recipient") || validateTyping(body.donor, "donor");
        if (v) return err(422, v);
        const out = await eng.match(fw, body.recipient, body.donor);
        meter(env, ctx, who, "match", 200, FRAMEWORKS[fw].length, Date.now() - t0);
        return json(out);
      }
      return err(404, "Not Found");
    } catch (ex) {
      meter(env, ctx, who, path.slice(4), 500, 0, Date.now() - t0);
      return err(500, "internal error computing the verdict; nothing was stored");
    }
  },
};
