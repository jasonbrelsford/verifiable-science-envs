// Parses the HLA_VERIFY_API_KEYS secret and (optionally) a KV-stored key record
// into one shape: { label, tier }, and owns the per-tier limit table every other
// module reads. Grammar for the secret, comma-separated:
//   key=label:tier   (preferred)
//   key=label         (legacy; tier defaults to "enterprise" so keys minted
//                      before tiers existed keep their old uncapped behavior)
//   key               (bare; label defaults to "key", tier "enterprise")
// Tiers: free (anonymous only, never presented as a key), starter, lab, scale,
// enterprise (uncapped), academic (hand-issued, never sold through Stripe —
// see TIER_LIMITS below), plus "pro" — the legacy name for what is now "lab".
// An unrecognized trailing ":word" is treated as part of the label rather than a
// tier, so labels may contain colons.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

// "pro" stays in the list: keys were minted with it and must keep working.
export const TIERS = ["free", "starter", "lab", "scale", "enterprise", "pro", "academic"];

// Legacy tier name -> the tier whose limits it gets. "pro" was the $299 tier's
// name before it was renamed "lab"; existing pro keys are Lab keys in all but
// name, and x-hla-verify-tier still reports them as "pro" so nothing a customer
// already parses changes.
export const TIER_ALIASES = { pro: "lab" };

// The published limit table (https://api.hlaverify.com/pricing).
//   calls:   billable API calls per UTC day; null = uncapped (quota.js)
//   typings: items per POST /v1/normalize call (MAX_TEXT is 200,000 for every
//            tier — that one is a published contract and does not vary)
//   burst:   per-minute rate limit, enforced by the `ratelimits` bindings in
//            wrangler.jsonc (index.js limiterFor); repeated here for the docs
//            and the `about` MCP tool so one table drives every surface.
export const TIER_LIMITS = {
  free: { calls: 100, typings: 250, burst: "60 requests/minute per IP", price: "free, no key" },
  starter: { calls: 500, typings: 250, burst: "60 requests/minute", price: "$49/mo" },
  lab: { calls: 10_000, typings: 5_000, burst: "600 requests/minute", price: "$299/mo" },
  scale: { calls: 1_000_000, typings: 5_000, burst: "6,000 requests/minute", price: "$1,999/mo" },
  enterprise: { calls: null, typings: 5_000, burst: "uncapped", price: "custom" },
  // Same limits as lab. Never sold through Stripe (pricing.js/stripe.js both
  // exclude it from their sellable-tier lists) and left out of NEXT_TIER below,
  // so no over-quota or over-batch message ever upsells into it — it is issued,
  // not bought. Keys are minted by hand in HLA_VERIFY_API_KEYS or a KV record
  // (key=label:academic) after an email to hello@hlaverify.com from an
  // institutional address.
  academic: { calls: 10_000, typings: 5_000, burst: "600 requests/minute",
    price: "free for accredited universities, hospitals' research units, registries and non-profits; issued on request" },
};

// The upgrade path, used by the over-quota and over-batch messages so a caller
// (or an agent reading them) is told which tier lifts the limit it just hit.
// "academic" is deliberately absent on both sides: it is not sold, so nothing
// upgrades into it, and it already has Lab's limits, so it has nowhere to
// upgrade to.
export const NEXT_TIER = { free: "starter", starter: "lab", lab: "scale", scale: "enterprise" };

// Canonical tier name for limit lookups: resolves the legacy alias, and falls
// back to "starter" for anything unrecognized (a malformed KV record must not
// silently hand someone enterprise limits, nor break a paying caller).
export function canonicalTier(tier) {
  const t = TIER_ALIASES[tier] || tier;
  return Object.prototype.hasOwnProperty.call(TIER_LIMITS, t) ? t : "starter";
}

export function limitsFor(tier) {
  return TIER_LIMITS[canonicalTier(tier)];
}

export function parseKeys(s) {
  const out = new Map();
  for (const part of (s || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) {
      out.set(p, { label: "key", tier: "enterprise" });
      continue;
    }
    const key = p.slice(0, eq).trim();
    if (!key) continue;
    const rest = p.slice(eq + 1).trim() || "key";
    const colon = rest.lastIndexOf(":");
    if (colon > 0) {
      const maybeTier = rest.slice(colon + 1).trim();
      if (TIERS.includes(maybeTier)) {
        out.set(key, { label: rest.slice(0, colon).trim() || "key", tier: maybeTier });
        continue;
      }
    }
    out.set(key, { label: rest, tier: "enterprise" });
  }
  return out;
}
