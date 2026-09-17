// Per-tier daily call quotas, counted in a Durable Object.
//
// WHY A DURABLE OBJECT. The Workers rate-limit binding (`ratelimits` in
// wrangler.jsonc) only supports 10-second and 60-second windows, so it can cap
// the burst but cannot count a day. A Durable Object gives one strongly
// consistent counter per counting subject; each instance stores a single
// {day, count} record and rolls it over at UTC midnight.
//
// COST PER BILLABLE REQUEST: one DO request, one storage read and (unless the
// caller is already over) one storage write, plus well under a millisecond of
// DO wall time. Non-billable routes, enterprise keys and deployments with no
// QUOTA binding never touch the object at all.
//
// COUNTING SUBJECT. A keyed caller is counted per API key, so two keys never
// share a counter and an OAuth token counts against the key behind it. An
// anonymous caller is counted per IP per day, and the IP is never stored: the
// object's name is a SHA-256 digest of the UTC day and the address, so the
// digest changes at midnight and yesterday's object is never addressed again.
// The privacy policy says IP addresses are not retained; this keeps that true.
//
// FAIL OPEN. Every failure path here serves the request, exactly as
// limiterFor() already fails open when the rate limiter is unavailable: a
// counter outage must not take the API down. An uncounted request reports
// `unknown` remaining rather than a number it cannot stand behind.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { limitsFor, canonicalTier, NEXT_TIER, TIER_LIMITS } from "./keys.js";

export const PRICING_URL = "https://api.hlaverify.com/pricing";
const DAY_MS = 86_400_000;
// How long after a day ends an untouched counter deletes itself, so the
// per-IP-per-day objects do not accumulate storage forever.
const SWEEP_AFTER_MS = 36 * 3600 * 1000;

// Billable REST routes: everything that runs the engine. /healthz, /docs,
// /openapi.json, /pricing, /checkout/success, the OAuth and .well-known routes,
// /v1/beta-signup and the Stripe webhook are not billable and consume nothing.
const BILLABLE_PATHS = new Set(["/v1/verify", "/v1/normalize", "/v1/match", "/v1/typing/check", "/v1/compat", "/v1/glstring"]);
export function isBillablePath(path) {
  return BILLABLE_PATHS.has(path) || path.startsWith("/v1/allele/");
}

// Billable MCP tools: the same set, tool for tool. `about` is metadata (the
// /docs of the MCP surface) and `beta_signup` mirrors /v1/beta-signup, so
// neither consumes quota — nor does initialize, tools/list or server/discover,
// which never reach a tool at all.
export const BILLABLE_TOOLS = new Set(["verify_text", "normalize_allele", "allele_info", "match_score",
  "check_typing", "donor_compat", "validate_gl_string"]);

// ------------------------------------------------------------- the UTC day
// Day boundary is UTC midnight, everywhere, for every tier: the quota key is
// the ISO date of the request in UTC, and the reset time is the next midnight.
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const nextUtcMidnight = (now = Date.now()) => new Date(Math.floor(now / DAY_MS + 1) * DAY_MS);
const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`);

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Durable Object name for a caller. Keyed: a digest of the key, stable across
// days (one object per key, rolled over in place). Anonymous: a digest of the
// day and the client IP, so a fresh object each UTC day and no stored value
// outlives the day it was counted in. Raw keys and raw IPs go no further than
// this function.
export async function subjectName(who, req, day) {
  if (who.keyed) {
    // Deliberately fatal rather than falling back to the label: a keyed caller
    // with no keyRef is a bug, and any fallback would silently bill every such
    // key to one shared counter. Throwing here fails the request OPEN instead.
    if (typeof who.keyRef !== "string" || !who.keyRef) throw new Error("keyed caller without a key reference");
    return `k:${(await sha256Hex(`hlv-quota-key:${who.keyRef}`)).slice(0, 32)}`;
  }
  const ip = (req && req.headers.get("cf-connecting-ip")) || "unknown";
  return `a:${(await sha256Hex(`hlv-quota-ip:${day}:${ip}`)).slice(0, 32)}`;
}

// Charges one billable call to the caller's daily quota. Returns the quota
// state either way; `ok:false` means the call must be refused with 429.
// Never throws: a broken or missing counter yields ok:true, remaining:null.
export async function spendQuota(env, who, req, { now = Date.now() } = {}) {
  const lim = limitsFor(who.tier);
  const day = utcDay(now);
  const state = { tier: who.tier, limit: lim.calls, maxTypings: lim.typings,
    reset: nextUtcMidnight(now).toISOString(), remaining: null, ok: true };
  if (lim.calls === null || !env || !env.QUOTA) return state;
  try {
    const stub = env.QUOTA.get(env.QUOTA.idFromName(await subjectName(who, req, day)));
    const resp = await stub.fetch("https://quota.hlaverify.internal/spend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day, limit: lim.calls }),
    });
    const { count, over } = await resp.json();
    // A counter that answered with something other than a count is a counter
    // that did not count: treated as an outage, not as a zero.
    if (typeof count !== "number" || !Number.isFinite(count)) throw new Error("bad counter response");
    state.ok = !over;
    state.remaining = Math.max(0, lim.calls - count);
  } catch (_) {
    // Counter unreachable or erroring: serve the request and record it as
    // uncounted. The burst limiter is still in front of us.
    state.remaining = null;
  }
  return state;
}

// Headers carried by every billable response, over and under quota alike.
// `unlimited` for enterprise, `unknown` when the counter could not be reached.
export function quotaHeaders(q) {
  const unlimited = q.limit === null;
  return {
    "x-hla-verify-tier": q.tier,
    "x-hla-verify-daily-limit": unlimited ? "unlimited" : String(q.limit),
    "x-hla-verify-daily-remaining": unlimited ? "unlimited" : q.remaining === null ? "unknown" : String(q.remaining),
    "x-hla-verify-daily-reset": q.reset,
    "x-hla-verify-max-typings": String(q.maxTypings),
  };
}

// Seconds until the quota resets, for Retry-After on a 429.
export const retryAfterSeconds = (q, now = Date.now()) => Math.max(1, Math.ceil((Date.parse(q.reset) - now) / 1000));

const plural = (n) => n.toLocaleString("en-US");

// Written to be acted on, not just read: what ran out, when it comes back, and
// the two things that fix it now.
export function quotaDetail(q) {
  const next = NEXT_TIER[canonicalTier(q.tier)];
  const upgrade = next && TIER_LIMITS[next]
    ? `The ${next} tier (${TIER_LIMITS[next].price}) allows ${TIER_LIMITS[next].calls === null ? "uncapped" : plural(TIER_LIMITS[next].calls)} calls/day: ${PRICING_URL}. `
    : `Upgrade at ${PRICING_URL}. `;
  return `daily quota exhausted: the ${q.tier} tier allows ${plural(q.limit)} API calls per UTC day. ` +
    `Retry after ${q.reset} (the quota resets at UTC midnight). ${upgrade}` +
    "Batching more work into each call also helps — /v1/normalize takes many typings per call.";
}

// 422 for a batch over the caller's per-call cap, naming the cap and the tier
// that lifts it.
export function batchDetail(tier, cap, n) {
  const canonical = canonicalTier(tier);
  const lift = Object.keys(TIER_LIMITS).find((t) => TIER_LIMITS[t].typings > cap);
  return `typings must have at most ${plural(cap)} items on the ${tier} tier (you sent ${plural(n)})` +
    (lift ? `; the ${lift} tier (${TIER_LIMITS[lift].price}) allows ${plural(TIER_LIMITS[lift].typings)} per call: ${PRICING_URL}` : "") +
    (!lift ? ". Split it across calls." : canonical === "free" ? ". Split the batch, or get a key." : ". Split the batch across calls, or upgrade.");
}

// ------------------------------------------------------------ the counter
// One instance per counting subject. Storage is a single record, {day, count}.
// Written in the "classic" Durable Object style (no cloudflare:workers import)
// so the module still loads under plain `node --test`.
export class DailyQuota {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let day, limit;
    try {
      ({ day, limit } = await request.json());
    } catch (_) {
      // A body we could not read is an outage, not a caller over their quota:
      // answer with an error so spendQuota() fails OPEN rather than refusing a
      // request on a count that was never made.
      return new Response(null, { status: 500 });
    }

    const rec = (await this.state.storage.get("q")) || { day: "", count: 0 };
    const rolled = rec.day !== day;
    if (rolled) {
      rec.day = day;
      rec.count = 0;
    }
    const over = rec.count >= limit;
    if (!over) {
      rec.count += 1;
      await this.state.storage.put("q", rec);
    }
    // A per-IP-per-day object is addressed only on its own day, so it would
    // otherwise keep one row forever. Sweep it well after the day has ended.
    if (rolled) {
      try {
        await this.state.storage.setAlarm(dayStartMs(day) + SWEEP_AFTER_MS);
      } catch (_) { /* alarms unavailable: the row is tiny, leave it */ }
    }
    return new Response(JSON.stringify({ count: rec.count, limit, day: rec.day, over }),
      { headers: { "content-type": "application/json" } });
  }

  // Deletes a counter whose day is over. Never deletes a live one: if this
  // fires early (clock skew), it reschedules instead, so no caller is handed
  // back a quota it has already spent.
  async alarm() {
    const rec = await this.state.storage.get("q");
    if (rec && rec.day === utcDay()) {
      await this.state.storage.setAlarm(Date.now() + SWEEP_AFTER_MS);
      return;
    }
    await this.state.storage.deleteAll();
  }
}
