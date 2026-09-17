// Live pricing from Stripe, cached at the edge, plus Checkout Session creation.
//
// WHY. Stripe is the source of truth for what a tier costs. Changing a price in
// the Stripe dashboard changes what /pricing publishes, with no deploy. The
// enforced limits stay where they have always been — TIER_LIMITS in keys.js —
// so one table still drives quotas and one Stripe account still drives money.
//
// GRANDFATHERING. A Stripe subscription stays on the price it was created with
// until someone deliberately migrates it. Creating a new price, or archiving an
// old one, does not touch an existing subscription. So a price change here
// applies to new subscribers only, and an early customer keeps the rate they
// signed at. Nothing in this file migrates a subscription, and nothing should.
//
// FALLBACK CHAIN, in order:
//   1. live   — a fresh fetch of active prices from Stripe (< CACHE_TTL_MS old)
//   2. cache  — the last good answer, however old, when Stripe is unreachable
//              or STRIPE_SECRET_KEY is momentarily unset
//   3. table  — the published prices in keys.js TIER_LIMITS, with buy buttons
//              hidden and the email path shown instead
// The page always renders, and never shows a price that was not read from
// Stripe or published in the table.
//
// CACHING. The cache is the Workers Cache API (caches.default) keyed by a
// synthetic https://pricing.hlaverify.internal/prices URL. Freshness is decided
// by a fetchedAt stamp inside the cached body rather than by Cache-Control, so
// a stale entry is still readable as the outage fallback instead of being
// evicted at the TTL. No KV: this needs no cross-colo consistency (a price read
// a few minutes late in one colo is the same class of staleness the TTL already
// allows), and KV would add a write on every refresh for no benefit.
//
// Facts checked against https://docs.stripe.com (2026-09-17 reading of the task
// brief; no live call was made from this session):
//   - GET /v1/prices?active=true&expand[]=data.product returns {data:[Price]},
//     each Price carrying id, active, currency, unit_amount, recurring.interval,
//     recurring.interval_count, metadata and (expanded) product.
//     https://docs.stripe.com/api/prices/list
//   - POST /v1/checkout/sessions is form-encoded; mode=subscription,
//     line_items[0][price], line_items[0][quantity], success_url, cancel_url,
//     metadata[...], subscription_data[metadata][...], allow_promotion_codes,
//     automatic_tax[enabled]. The response carries id and url.
//     https://docs.stripe.com/api/checkout/sessions/create
//   - allow_promotion_codes and discounts are mutually exclusive, and
//     discounts[0][promotion_code] wants the promotion code OBJECT id
//     (promo_...), not the customer-facing string. Hence the lookup below, and
//     the fall back to allow_promotion_codes when the lookup is not permitted.
//     https://docs.stripe.com/api/promotion_codes/list
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { TIERS, TIER_ALIASES, TIER_LIMITS, canonicalTier } from "./keys.js";

const STRIPE_API = "https://api.stripe.com";

// Local-testing seam. `wrangler dev` talks to the real network, so the only way
// to exercise checkout end to end without touching the live Stripe account is
// to point this module at a stub. STRIPE_API_BASE does that — but ONLY when it
// addresses the loopback interface, so a mis-set or hostile value can never
// send a live secret key somewhere else. Unset in production.
function stripeBase(env) {
  const override = env && env.STRIPE_API_BASE;
  if (typeof override !== "string" || !override) return STRIPE_API;
  try {
    const u = new URL(override);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
    if (!local) return STRIPE_API;
    return override.replace(/\/+$/, "");
  } catch (_) {
    return STRIPE_API;
  }
}

// How long a fetched price list is served without asking Stripe again.
//
// TEN MINUTES. The thing being cached changes by hand, roughly monthly, and the
// cost of being late is that a new subscriber sees the old price for a few more
// minutes — the old price is still a real price, so nobody is quoted a number
// that never existed. Ten minutes bounds that window tightly enough for a
// deliberate dashboard edit ("change it and reload") while holding Stripe calls
// to at most six an hour per colo, so a burst of pricing-page traffic is not a
// burst of Stripe traffic. Shorter would spend calls on a page that changes
// monthly; longer would make a price change feel broken to the person making it.
export const CACHE_TTL_MS = 10 * 60 * 1000;

// How long the Cache API is asked to keep the entry at all. Much longer than
// the TTL on purpose: past CACHE_TTL_MS the entry stops being served as fresh
// but stays readable as the outage fallback.
const CACHE_RETAIN_S = 24 * 3600;

const CACHE_URL = "https://pricing.hlaverify.internal/prices";

// Tiers that can be bought. "free" is not sold; "enterprise" is quoted, not
// listed; "pro" is the legacy alias for "lab" and is accepted in price metadata
// so a price tagged with the old name still resolves.
export const SELLABLE_TIERS = ["starter", "lab", "scale"];
const KNOWN_TIER = (t) => typeof t === "string" && TIERS.includes(t) && t !== "free" && t !== "enterprise";

// An in-isolate fallback for `caches`, which exists in Workers but not under
// plain `node --test`. Module state lives as long as the isolate, so this is a
// real (if smaller) cache in production too, and a deterministic one in tests.
let memoryEntry = null;

function cacheStore(env) {
  const api = (env && env.__CACHES) || (typeof caches !== "undefined" ? caches : null);
  if (!api || !api.default) {
    return {
      async read() { return memoryEntry; },
      async write(payload) { memoryEntry = payload; },
    };
  }
  return {
    async read() {
      try {
        const hit = await api.default.match(new Request(CACHE_URL));
        return hit ? await hit.json() : null;
      } catch (_) {
        return memoryEntry;
      }
    },
    async write(payload) {
      memoryEntry = payload;
      try {
        await api.default.put(new Request(CACHE_URL), new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_RETAIN_S}` },
        }));
      } catch (_) { /* cache unavailable: the memory copy still serves */ }
    },
  };
}

// Test seam only: forget the in-isolate copy.
export function _resetPriceCache() {
  memoryEntry = null;
}

// Stripe Price -> the shape /pricing and /v1/checkout use. Returns null for
// anything not a live, recurring, tier-tagged price, so a one-off price or an
// untagged experiment in the same account is ignored rather than published.
function shapePrice(p) {
  if (!p || p.active === false) return null;
  const tier = p.metadata && p.metadata.tier;
  if (!KNOWN_TIER(tier)) return null;
  if (!p.recurring || typeof p.unit_amount !== "number") return null;
  const product = p.product && typeof p.product === "object" ? p.product : null;
  return {
    tier,
    limitsTier: canonicalTier(tier),
    id: p.id,
    amount: p.unit_amount,
    currency: String(p.currency || "usd").toLowerCase(),
    interval: p.recurring.interval,
    intervalCount: p.recurring.interval_count || 1,
    name: (product && product.name) || p.nickname || null,
  };
}

async function fetchActivePrices(secretKey, fetchImpl, base = STRIPE_API) {
  const url = `${base}/v1/prices?active=true&limit=100&expand[]=data.product`;
  const resp = await fetchImpl(url, { headers: { authorization: `Bearer ${secretKey}` } });
  if (!resp.ok) throw new Error(`stripe prices ${resp.status}`);
  const body = await resp.json();
  const rows = body && Array.isArray(body.data) ? body.data : [];
  const byTier = {};
  for (const raw of rows) {
    const p = shapePrice(raw);
    if (!p) continue;
    // Two active prices tagged with the same tier is a dashboard mistake, not a
    // choice to make at request time. Keep the cheaper one: publishing the lower
    // of two real prices is the failure that does not overcharge anyone.
    if (!byTier[p.tier] || p.amount < byTier[p.tier].amount) byTier[p.tier] = p;
  }
  // "pro" is the legacy name for "lab": a price tagged pro fills the lab slot
  // when no lab-tagged price exists, so renaming metadata is not a cliff.
  for (const [legacy, canonical] of Object.entries(TIER_ALIASES)) {
    if (byTier[legacy] && !byTier[canonical]) byTier[canonical] = { ...byTier[legacy], limitsTier: canonical };
  }
  return byTier;
}

// The whole fallback chain. Never throws, never returns null.
//   { source: "stripe"|"cache"|"table", prices: {tier: shape}, fetchedAt, live }
// `live` is true when a buy button can work: we hold a real Stripe price id and
// a secret key to spend it with.
export async function getPricing(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  // A buy button can only work when we can spend a secret key. Without one the
  // page still renders cached or published prices, with the email path instead.
  const sellable = Boolean(env && env.STRIPE_SECRET_KEY);
  const store = cacheStore(env);
  const cached = await store.read();
  const hasCache = Boolean(cached && cached.prices && Object.keys(cached.prices).length > 0);

  if (hasCache && typeof cached.fetchedAt === "number" && now - cached.fetchedAt < CACHE_TTL_MS)
    return { source: "cache", prices: cached.prices, fetchedAt: cached.fetchedAt, live: sellable, fresh: true };

  if (sellable) {
    try {
      const prices = await fetchActivePrices(env.STRIPE_SECRET_KEY, fetchImpl, stripeBase(env));
      if (Object.keys(prices).length > 0) {
        await store.write({ fetchedAt: now, prices });
        return { source: "stripe", prices, fetchedAt: now, live: true, fresh: true };
      }
      // An empty answer is a real answer from Stripe (every price archived, or
      // none tagged). Do not cache it over a good one: serve the stale copy if
      // there is one, otherwise the table.
    } catch (_) {
      // Stripe unreachable or erroring: fall through to the stale copy.
    }
  }

  if (hasCache) return { source: "cache", prices: cached.prices, fetchedAt: cached.fetchedAt || 0, live: sellable, fresh: false };

  return { source: "table", prices: {}, fetchedAt: 0, live: false, fresh: false };
}

// ------------------------------------------------------------- formatting

// Stripe amounts are in the currency's minor unit for every currency this
// account sells in. Zero-decimal currencies (JPY and friends) are not used
// here; if one ever is, this is the line to revisit.
export function formatAmount(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: String(currency || "usd").toUpperCase(),
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch (_) {
    return `${(amount / 100).toFixed(2)} ${String(currency || "usd").toUpperCase()}`;
  }
}

export function formatInterval(interval, intervalCount = 1) {
  const unit = { day: "day", week: "week", month: "mo", year: "yr" }[interval] || interval || "mo";
  return intervalCount > 1 ? `${intervalCount} ${unit}` : unit;
}

// "$49/mo" — what a tier costs, from Stripe when we have it and from the
// published table when we do not.
export function priceLabel(tier, pricing) {
  const p = pricing && pricing.prices ? pricing.prices[tier] : null;
  if (p) return `${formatAmount(p.amount, p.currency)}/${formatInterval(p.interval, p.intervalCount)}`;
  const row = TIER_LIMITS[canonicalTier(tier)];
  return row ? row.price : "contact us";
}

// ------------------------------------------------------- checkout sessions

const CHECKOUT_UNCONFIGURED = "self-serve checkout is not configured on this deployment; email hello@hlaverify.com for a key";

// Resolves a customer-facing promotion code ("MSNPIYHU") to its object id
// (promo_...). Returns null when the key cannot read promotion codes, which is
// the normal case for a restricted key scoped to prices and checkout — the
// caller then falls back to allow_promotion_codes and the customer types the
// code on Stripe's own page.
async function resolvePromotionCode(code, secretKey, fetchImpl, base = STRIPE_API) {
  try {
    const url = `${base}/v1/promotion_codes?active=true&limit=1&code=${encodeURIComponent(code)}`;
    const resp = await fetchImpl(url, { headers: { authorization: `Bearer ${secretKey}` } });
    if (!resp.ok) return null;
    const body = await resp.json();
    const row = body && Array.isArray(body.data) ? body.data[0] : null;
    return row && row.id ? row.id : null;
  } catch (_) {
    return null;
  }
}

// The exact form body sent to POST /v1/checkout/sessions. Separated from the
// request so a test can assert the payload without a network call.
export function checkoutParams({ price, tier, successUrl, cancelUrl, promotionCodeId = null }) {
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  // The one field key issuance depends on: resolveTier() in stripe.js reads
  // session.metadata.tier first and only falls back to the price-id map.
  params.set("metadata[tier]", tier);
  // Repeated on the subscription so a later customer.subscription.* event
  // carries the tier too, without a line-items lookup.
  params.set("subscription_data[metadata][tier]", tier);
  if (promotionCodeId) params.set("discounts[0][promotion_code]", promotionCodeId);
  else params.set("allow_promotion_codes", "true");
  // Stripe Tax is configured on this account; Checkout collects the address it
  // needs to compute tax.
  params.set("automatic_tax[enabled]", "true");
  params.set("billing_address_collection", "auto");
  return params;
}

export const successUrlFor = (origin) => `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
export const cancelUrlFor = (origin) => `${origin}/pricing`;

// Creates a Checkout Session for one tier. Returns
//   { ok: true, url, id, tier, price, amount, currency, interval }
// or { ok: false, status, detail } — every failure names the email path rather
// than leaving a caller with nothing to do.
export async function createCheckoutSession(env, body, { origin, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!env || !env.STRIPE_SECRET_KEY) return { ok: false, status: 503, detail: CHECKOUT_UNCONFIGURED };

  const wantedTier = typeof body.tier === "string" ? body.tier.trim().toLowerCase() : "";
  const wantedPrice = typeof body.price === "string" ? body.price.trim() : "";
  if (!wantedTier && !wantedPrice) return { ok: false, status: 422, detail: `send {"tier": "…"} — one of ${SELLABLE_TIERS.join(", ")}` };
  if (wantedTier && !KNOWN_TIER(wantedTier))
    return { ok: false, status: 422, detail: `unknown tier ${JSON.stringify(wantedTier)}; sellable tiers are ${SELLABLE_TIERS.join(", ")}. Enterprise is quoted: hello@hlaverify.com` };

  const pricing = await getPricing(env, { now, fetchImpl });
  let chosen = null;
  if (wantedPrice) {
    chosen = Object.values(pricing.prices).find((p) => p.id === wantedPrice) || null;
    if (!chosen) return { ok: false, status: 422, detail: `price ${JSON.stringify(wantedPrice)} is not an active HLA-Verify plan; send a tier instead` };
    if (wantedTier && chosen.tier !== wantedTier)
      return { ok: false, status: 422, detail: `price ${JSON.stringify(wantedPrice)} is the ${chosen.tier} plan, not ${wantedTier}` };
  } else {
    chosen = pricing.prices[wantedTier] || null;
    if (!chosen) return { ok: false, status: 503, detail: `the ${wantedTier} plan is not on sale right now; email hello@hlaverify.com` };
  }

  const code = typeof body.promotion_code === "string" ? body.promotion_code.trim() : "";
  const promotionCodeId = code ? await resolvePromotionCode(code, env.STRIPE_SECRET_KEY, fetchImpl, stripeBase(env)) : null;

  const params = checkoutParams({
    price: chosen.id,
    tier: chosen.tier,
    successUrl: successUrlFor(origin),
    cancelUrl: cancelUrlFor(origin),
    promotionCodeId,
  });

  let session;
  try {
    const resp = await fetchImpl(`${stripeBase(env)}/v1/checkout/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    session = await resp.json();
    if (!resp.ok) {
      const msg = (session && session.error && session.error.message) || `Stripe returned ${resp.status}`;
      return { ok: false, status: 502, detail: `Stripe could not start checkout: ${msg}. Email hello@hlaverify.com and we will issue the key by hand.` };
    }
  } catch (_) {
    return { ok: false, status: 502, detail: "Stripe was unreachable; email hello@hlaverify.com and we will issue the key by hand." };
  }
  if (!session || !session.url) return { ok: false, status: 502, detail: "Stripe returned no checkout url; email hello@hlaverify.com." };

  return {
    ok: true,
    url: session.url,
    id: session.id || null,
    tier: chosen.tier,
    price: chosen.id,
    amount: chosen.amount,
    currency: chosen.currency,
    interval: chosen.interval,
    promotion_code_applied: Boolean(promotionCodeId),
  };
}

export { CHECKOUT_UNCONFIGURED };
