// Stripe as the source of truth for pricing: the cached price reader, the
// fallback chain behind it, the Checkout Session payload, and the two pages
// that render from it.
//
// What must hold:
// 1. Only active, recurring prices carrying a known metadata.tier are published.
//    An untagged price, an archived one, a one-off and a price tagged with a
//    tier that does not exist are all ignored rather than shown.
// 2. The cache serves a second view without a second Stripe call, and stops
//    serving once CACHE_TTL_MS has passed.
// 3. The fallback chain is live -> cache -> TIER_LIMITS, in that order, and the
//    page renders at every step.
// 4. The Checkout Session is subscription mode, carries metadata.tier from the
//    price's own metadata, and points success_url at the existing
//    /checkout/success?session_id={CHECKOUT_SESSION_ID} flow.
// 5. A bad tier, a dead price and an absent STRIPE_SECRET_KEY all degrade to
//    the email path, never to a 500 and never to an invented price.
// 6. POST /v1/checkout consumes no daily quota.
// 7. resolveTier still prefers session metadata over the price-id map.
//
// Stripe is never called: every test drives a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker, { DailyQuota } from "../src/index.js";
import { getPricing, createCheckoutSession, checkoutParams, priceLabel, formatAmount, formatInterval,
  CACHE_TTL_MS, SELLABLE_TIERS, _resetPriceCache } from "../src/pricing.js";
import { PRICING_HTML, DOCS_HTML, openapi } from "../src/docs.js";
import { handleStripeWebhook, hmacHex } from "../src/stripe.js";
import { TIER_LIMITS } from "../src/keys.js";
import { isBillablePath } from "../src/quota.js";

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

// The three live prices, in the shape Stripe's list endpoint returns them with
// expand[]=data.product.
const STARTER = { id: "price_starter", object: "price", active: true, currency: "usd", unit_amount: 4900,
  recurring: { interval: "month", interval_count: 1 }, metadata: { tier: "starter" },
  product: { id: "prod_s", name: "HLA-Verify Starter" } };
const LAB = { id: "price_lab", object: "price", active: true, currency: "usd", unit_amount: 29900,
  recurring: { interval: "month", interval_count: 1 }, metadata: { tier: "lab" },
  product: { id: "prod_l", name: "HLA-Verify Lab" } };
const SCALE = { id: "price_scale", object: "price", active: true, currency: "usd", unit_amount: 199900,
  recurring: { interval: "month", interval_count: 1 }, metadata: { tier: "scale" },
  product: { id: "prod_x", name: "HLA-Verify Scale" } };
const LIVE_PRICES = [STARTER, LAB, SCALE];

// A Cache API stand-in with the two methods pricing.js uses.
function fakeCaches() {
  const store = new Map();
  return {
    _store: store,
    default: {
      async match(req) {
        const hit = store.get(req.url);
        return hit === undefined ? undefined : new Response(hit, { headers: { "content-type": "application/json" } });
      },
      async put(req, resp) { store.set(req.url, await resp.text()); },
    },
  };
}

// A fetch that answers Stripe's price list and checkout endpoints, records every
// call, and can be told to fail.
function stripeFetch({ prices = LIVE_PRICES, listStatus = 200, sessionStatus = 200, throwOnList = false,
  promotionCodes = null, session = { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" } } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body || null, headers: init.headers || {} });
    if (String(url).includes("/v1/prices")) {
      if (throwOnList) throw new Error("stripe unreachable");
      if (listStatus !== 200) return new Response("{}", { status: listStatus });
      return new Response(JSON.stringify({ object: "list", data: prices }), { status: 200 });
    }
    if (String(url).includes("/v1/promotion_codes")) {
      if (promotionCodes === null) return new Response(JSON.stringify({ error: { message: "not permitted" } }), { status: 403 });
      return new Response(JSON.stringify({ object: "list", data: promotionCodes }), { status: 200 });
    }
    if (String(url).includes("/v1/checkout/sessions")) {
      if (sessionStatus !== 200) return new Response(JSON.stringify({ error: { message: "No such price" } }), { status: sessionStatus });
      return new Response(JSON.stringify(session), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  fn.listCalls = () => calls.filter((c) => c.url.includes("/v1/prices"));
  return fn;
}

const priceEnv = (extra = {}) => ({ STRIPE_SECRET_KEY: "rk_live_test", __CACHES: fakeCaches(), ...extra });

// --------------------------------------------------------- tier filtering

test("only active, recurring, tier-tagged prices are published", async () => {
  _resetPriceCache();
  const f = stripeFetch({ prices: [
    STARTER,
    { ...LAB, id: "price_untagged", metadata: {} },
    { ...LAB, id: "price_archived", active: false },
    { ...LAB, id: "price_oneoff", recurring: null },
    { ...LAB, id: "price_bogus_tier", metadata: { tier: "platinum" } },
    { ...LAB, id: "price_free_tier", metadata: { tier: "free" } },
    { ...LAB, id: "price_enterprise", metadata: { tier: "enterprise" } },
    LAB,
  ] });
  const p = await getPricing(priceEnv(), { fetchImpl: f });
  assert.equal(p.source, "stripe");
  assert.deepEqual(Object.keys(p.prices).sort(), ["lab", "starter"]);
  assert.equal(p.prices.lab.id, "price_lab");
  assert.equal(p.prices.starter.amount, 4900);
  assert.equal(p.prices.starter.currency, "usd");
  assert.equal(p.prices.starter.interval, "month");
  assert.equal(p.prices.starter.name, "HLA-Verify Starter");
});

test("a price tagged with the legacy tier `pro` fills the lab slot", async () => {
  _resetPriceCache();
  const f = stripeFetch({ prices: [{ ...LAB, id: "price_pro_legacy", metadata: { tier: "pro" } }] });
  const p = await getPricing(priceEnv(), { fetchImpl: f });
  assert.equal(p.prices.lab.id, "price_pro_legacy");
  assert.equal(p.prices.lab.limitsTier, "lab");
});

test("two active prices for one tier: the cheaper real one is published", async () => {
  _resetPriceCache();
  const f = stripeFetch({ prices: [{ ...LAB, id: "price_lab_old", unit_amount: 39900 }, LAB] });
  const p = await getPricing(priceEnv(), { fetchImpl: f });
  assert.equal(p.prices.lab.id, "price_lab");
  assert.equal(p.prices.lab.amount, 29900);
});

// ---------------------------------------------------------------- caching

test("cache hit: a second read in the TTL does not call Stripe again", async () => {
  _resetPriceCache();
  const env = priceEnv();
  const f = stripeFetch();
  const first = await getPricing(env, { now: 1_000_000, fetchImpl: f });
  assert.equal(first.source, "stripe");
  assert.equal(f.listCalls().length, 1);

  const second = await getPricing(env, { now: 1_000_000 + CACHE_TTL_MS - 1, fetchImpl: f });
  assert.equal(second.source, "cache");
  assert.equal(second.fresh, true);
  assert.equal(second.prices.lab.amount, 29900);
  assert.equal(f.listCalls().length, 1, "a cache hit must not call Stripe");
});

test("cache expiry: past the TTL Stripe is asked again and the new price is published", async () => {
  _resetPriceCache();
  const env = priceEnv();
  const f = stripeFetch();
  await getPricing(env, { now: 1_000_000, fetchImpl: f });

  const raised = stripeFetch({ prices: [STARTER, { ...LAB, unit_amount: 34900 }, SCALE] });
  const after = await getPricing(env, { now: 1_000_000 + CACHE_TTL_MS + 1, fetchImpl: raised });
  assert.equal(after.source, "stripe");
  assert.equal(after.prices.lab.amount, 34900);
  assert.equal(raised.listCalls().length, 1);
  assert.equal(priceLabel("lab", after), "$349/mo");
});

test("fallback: a Stripe error past the TTL serves the last good answer", async () => {
  _resetPriceCache();
  const env = priceEnv();
  await getPricing(env, { now: 1_000_000, fetchImpl: stripeFetch() });

  const broken = stripeFetch({ throwOnList: true });
  const stale = await getPricing(env, { now: 1_000_000 + CACHE_TTL_MS + 1, fetchImpl: broken });
  assert.equal(stale.source, "cache");
  assert.equal(stale.fresh, false);
  assert.equal(stale.prices.lab.amount, 29900);
  assert.equal(stale.live, true, "a cached price is still buyable while Stripe is briefly down");
  assert.equal(broken.listCalls().length, 1, "Stripe was tried before the cache was used");
});

test("fallback: a 500 from Stripe with a cold cache falls through to the TIER_LIMITS table", async () => {
  _resetPriceCache();
  const p = await getPricing(priceEnv(), { fetchImpl: stripeFetch({ listStatus: 500 }) });
  assert.equal(p.source, "table");
  assert.deepEqual(p.prices, {});
  assert.equal(p.live, false);
  assert.equal(priceLabel("lab", p), TIER_LIMITS.lab.price);
  assert.equal(priceLabel("starter", p), TIER_LIMITS.starter.price);
});

test("fallback: an empty but successful Stripe answer never overwrites a good cache", async () => {
  _resetPriceCache();
  const env = priceEnv();
  await getPricing(env, { now: 1_000_000, fetchImpl: stripeFetch() });
  const emptied = await getPricing(env, { now: 1_000_000 + CACHE_TTL_MS + 1, fetchImpl: stripeFetch({ prices: [] }) });
  assert.equal(emptied.source, "cache");
  assert.equal(emptied.prices.starter.amount, 4900);
});

test("no STRIPE_SECRET_KEY: Stripe is never called and the table is served", async () => {
  _resetPriceCache();
  const f = stripeFetch();
  const p = await getPricing({ __CACHES: fakeCaches() }, { fetchImpl: f });
  assert.equal(p.source, "table");
  assert.equal(p.live, false);
  assert.equal(f.calls.length, 0);
});

test("getPricing never throws, even with no env at all", async () => {
  _resetPriceCache();
  const p = await getPricing(undefined, { fetchImpl: stripeFetch() });
  assert.equal(p.source, "table");
});

// ------------------------------------------------------------- formatting

test("amounts and intervals render from Stripe's own units", () => {
  assert.equal(formatAmount(4900, "usd"), "$49");
  assert.equal(formatAmount(199900, "usd"), "$1,999");
  assert.equal(formatAmount(4950, "usd"), "$49.50");
  assert.equal(formatInterval("month", 1), "mo");
  assert.equal(formatInterval("year", 1), "yr");
  assert.equal(formatInterval("month", 3), "3 mo");
});

// ------------------------------------------------------- checkout payload

test("checkoutParams is exactly what Stripe expects for a subscription", () => {
  const params = checkoutParams({
    price: "price_lab", tier: "lab",
    successUrl: "https://api.hlaverify.com/checkout/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://api.hlaverify.com/pricing",
  });
  assert.equal(params.get("mode"), "subscription");
  assert.equal(params.get("line_items[0][price]"), "price_lab");
  assert.equal(params.get("line_items[0][quantity]"), "1");
  assert.equal(params.get("success_url"), "https://api.hlaverify.com/checkout/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.get("cancel_url"), "https://api.hlaverify.com/pricing");
  assert.equal(params.get("metadata[tier]"), "lab");
  assert.equal(params.get("subscription_data[metadata][tier]"), "lab");
  assert.equal(params.get("allow_promotion_codes"), "true");
  assert.equal(params.get("automatic_tax[enabled]"), "true");
  assert.equal(params.get("discounts[0][promotion_code]"), null);
});

test("checkoutParams: a resolved promotion code replaces allow_promotion_codes", () => {
  const params = checkoutParams({ price: "price_lab", tier: "lab", successUrl: "s", cancelUrl: "c", promotionCodeId: "promo_123" });
  assert.equal(params.get("discounts[0][promotion_code]"), "promo_123");
  assert.equal(params.get("allow_promotion_codes"), null, "Stripe rejects both together");
});

test("createCheckoutSession posts the right form body and returns the hosted url", async () => {
  _resetPriceCache();
  const f = stripeFetch();
  const r = await createCheckoutSession(priceEnv(), { tier: "lab" }, { origin: "https://api.hlaverify.com", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://checkout.stripe.com/c/pay/cs_test_123");
  assert.equal(r.id, "cs_test_123");
  assert.equal(r.tier, "lab");
  assert.equal(r.price, "price_lab");
  assert.equal(r.amount, 29900);
  assert.equal(r.currency, "usd");
  assert.equal(r.interval, "month");

  const post = f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions"));
  assert.ok(post, "no POST to /v1/checkout/sessions");
  assert.equal(post.method, "POST");
  assert.equal(post.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(post.headers.authorization, "Bearer rk_live_test");
  const sent = new URLSearchParams(post.body);
  assert.equal(sent.get("mode"), "subscription");
  assert.equal(sent.get("line_items[0][price]"), "price_lab");
  assert.equal(sent.get("metadata[tier]"), "lab");
  assert.equal(sent.get("success_url"), "https://api.hlaverify.com/checkout/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(sent.get("cancel_url"), "https://api.hlaverify.com/pricing");
});

test("createCheckoutSession: metadata.tier comes from the PRICE's metadata, not the request", async () => {
  _resetPriceCache();
  // A price whose tier metadata says scale, asked for by its price id.
  const f = stripeFetch();
  const r = await createCheckoutSession(priceEnv(), { price: "price_scale" }, { origin: "https://api.hlaverify.com", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "scale");
  const sent = new URLSearchParams(f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body);
  assert.equal(sent.get("metadata[tier]"), "scale");
});

test("createCheckoutSession: a promotion code Stripe lets us read is pre-applied", async () => {
  _resetPriceCache();
  const f = stripeFetch({ promotionCodes: [{ id: "promo_first5", code: "MSNPIYHU" }] });
  const r = await createCheckoutSession(priceEnv(), { tier: "lab", promotion_code: "MSNPIYHU" },
    { origin: "https://api.hlaverify.com", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.promotion_code_applied, true);
  const sent = new URLSearchParams(f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body);
  assert.equal(sent.get("discounts[0][promotion_code]"), "promo_first5");
});

test("createCheckoutSession: a promotion code a restricted key cannot read falls back to Stripe's own field", async () => {
  _resetPriceCache();
  const f = stripeFetch(); // promotion_codes answers 403
  const r = await createCheckoutSession(priceEnv(), { tier: "lab", promotion_code: "MSNPIYHU" },
    { origin: "https://api.hlaverify.com", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.promotion_code_applied, false);
  const sent = new URLSearchParams(f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body);
  assert.equal(sent.get("allow_promotion_codes"), "true");
});

test("createCheckoutSession: bad tier, dead price and missing key all degrade cleanly", async () => {
  _resetPriceCache();
  const bad = await createCheckoutSession(priceEnv(), { tier: "platinum" }, { origin: "https://x", fetchImpl: stripeFetch() });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 422);
  assert.match(bad.detail, /unknown tier/);

  _resetPriceCache();
  const empty = await createCheckoutSession(priceEnv(), {}, { origin: "https://x", fetchImpl: stripeFetch() });
  assert.equal(empty.status, 422);
  assert.match(empty.detail, /starter, lab, scale/);

  _resetPriceCache();
  // Scale archived in Stripe: the tier is real but not on sale.
  const gone = await createCheckoutSession(priceEnv(), { tier: "scale" },
    { origin: "https://x", fetchImpl: stripeFetch({ prices: [STARTER, LAB] }) });
  assert.equal(gone.ok, false);
  assert.equal(gone.status, 503);
  assert.match(gone.detail, /hello@hlaverify\.com/);

  _resetPriceCache();
  const unknownPrice = await createCheckoutSession(priceEnv(), { price: "price_nope" }, { origin: "https://x", fetchImpl: stripeFetch() });
  assert.equal(unknownPrice.status, 422);
  assert.match(unknownPrice.detail, /not an active HLA-Verify plan/);

  _resetPriceCache();
  const mismatched = await createCheckoutSession(priceEnv(), { price: "price_lab", tier: "starter" }, { origin: "https://x", fetchImpl: stripeFetch() });
  assert.equal(mismatched.status, 422);
  assert.match(mismatched.detail, /is the lab plan, not starter/);

  _resetPriceCache();
  const f = stripeFetch();
  const noKey = await createCheckoutSession({ __CACHES: fakeCaches() }, { tier: "lab" }, { origin: "https://x", fetchImpl: f });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.status, 503);
  assert.match(noKey.detail, /hello@hlaverify\.com/);
  assert.equal(f.calls.length, 0, "no Stripe call without a key");
});

test("createCheckoutSession: a Stripe rejection becomes a 502 naming the email path, not a 500", async () => {
  _resetPriceCache();
  const r = await createCheckoutSession(priceEnv(), { tier: "lab" },
    { origin: "https://x", fetchImpl: stripeFetch({ sessionStatus: 400 }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.detail, /No such price/);
  assert.match(r.detail, /hello@hlaverify\.com/);
});

// --------------------------------------------------------------- the page

test("/pricing renders the Stripe amounts with buy buttons", async () => {
  _resetPriceCache();
  const p = await getPricing(priceEnv(), { fetchImpl: stripeFetch({ prices: [STARTER, { ...LAB, unit_amount: 34900 }, SCALE] }) });
  const html = PRICING_HTML(manifest, p);
  assert.match(html, /\$49\/mo/);
  assert.match(html, /\$349\/mo/, "the page shows what Stripe holds, not the hardcoded table");
  assert.match(html, /\$1,999\/mo/);
  assert.doesNotMatch(html, /\$299\/mo/);
  for (const t of SELLABLE_TIERS) assert.match(html, new RegExp(`data-tier="${t}"`), `no buy button for ${t}`);
  assert.match(html, /\/v1\/checkout/);
  assert.match(html, /mailto:hello@hlaverify\.com/, "the email path stays visible");
  assert.match(html, /Join the beta list/, "the free tier keeps its beta framing");
  assert.doesNotMatch(html, /Self-serve checkout is not open yet/);
  assert.doesNotMatch(html, /issued on request/);
  assert.match(html, /price you sign at is the price you keep/i, "the grandfathering rule must be on the page");
  assert.match(html, /deliberately migrated/);
});

test("/pricing with no live price for a tier shows contact us, never an invented price", async () => {
  _resetPriceCache();
  const p = await getPricing(priceEnv(), { fetchImpl: stripeFetch({ prices: [STARTER, LAB] }) });
  const html = PRICING_HTML(manifest, p);
  assert.match(html, /<td>contact us<\/td>/);
  assert.doesNotMatch(html, /\$1,999/, "scale is archived in Stripe; do not quote its old price");
  assert.doesNotMatch(html, /data-tier="scale"/);
  assert.match(html, /data-tier="lab"/);
});

test("/pricing with no Stripe at all falls back to the table, hides the buttons, keeps the beta wording", async () => {
  _resetPriceCache();
  const p = await getPricing({ __CACHES: fakeCaches() }, { fetchImpl: stripeFetch() });
  const html = PRICING_HTML(manifest, p);
  assert.equal(p.source, "table");
  assert.doesNotMatch(html, /data-tier=/, "no buy button without a key to spend");
  assert.doesNotMatch(html, /fetch\('\/v1\/checkout'/, "no checkout script without a key to spend");
  assert.match(html, /Self-serve checkout is not open yet/);
  assert.match(html, /mailto:hello@hlaverify\.com/);
  assert.match(html, new RegExp(TIER_LIMITS.lab.price.replace(/[$]/g, "\\$")));
  assert.match(html, /price you sign at is the price you keep/i);
});

test("/docs and openapi.json only claim self-serve checkout when it works", async () => {
  _resetPriceCache();
  const live = await getPricing(priceEnv(), { fetchImpl: stripeFetch() });
  const off = await getPricing({ __CACHES: fakeCaches() }, { fetchImpl: stripeFetch() });

  const docsLive = DOCS_HTML(manifest, live);
  assert.match(docsLive, /self-serve/i);
  assert.doesNotMatch(docsLive, /Self-serve checkout is not open yet/);
  assert.doesNotMatch(docsLive, /are issued on request today/);
  assert.match(docsLive, /deliberately migrated/, "the grandfathering rule is stated on /docs too");

  const docsOff = DOCS_HTML(manifest, off);
  assert.match(docsOff, /Self-serve checkout is not open yet/);
  assert.match(docsOff, /are issued on request today/);

  assert.match(openapi(manifest, live).info.description, /POST \/v1\/checkout/);
  assert.match(openapi(manifest, off).info.description, /issued on request/);
  assert.equal(typeof openapi(manifest, live).paths["/v1/checkout"].post, "object");
});

// ------------------------------------------------------- through the worker

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, _store: store };
}
const fakeRL = () => ({ calls: [], async limit({ key }) { this.calls.push(key); return { success: true }; } });

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

function countingQuota() {
  const objects = new Map();
  const names = [];
  return {
    _names: names,
    idFromName(name) { names.push(name); return { name }; },
    get(id) {
      if (!objects.has(id.name)) objects.set(id.name, new DailyQuota({ storage: memStorage() }));
      const obj = objects.get(id.name);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
}

function workerEnv(extra = {}) {
  return {
    PUBLIC_ACCESS: "1",
    HLA_VERIFY_API_KEYS: "",
    KEYS: fakeKV(),
    RL: fakeRL(), RL_STARTER: fakeRL(), RL_LAB: fakeRL(), RL_SCALE: fakeRL(),
    QUOTA: countingQuota(),
    QUOTA_IP_SALT: "test-salt-0123456789abcdef",
    ASSETS,
    __CACHES: fakeCaches(),
    ...extra,
  };
}

function withFetch(mockFn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = orig; });
}

const call = async (env, method, p, init = {}) => {
  const resp = await worker.fetch(new Request("https://api.hlaverify.com" + p, {
    method, headers: { "cf-connecting-ip": "203.0.113.9", ...(init.headers || {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  }), env, {});
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* HTML */ }
  return { resp, text, json };
};

test("POST /v1/checkout through the worker returns the session url", async () => {
  _resetPriceCache();
  const env = workerEnv({ STRIPE_SECRET_KEY: "rk_live_test" });
  const f = stripeFetch();
  await withFetch(f, async () => {
    const { resp, json } = await call(env, "POST", "/v1/checkout", {
      headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "starter" }) });
    assert.equal(resp.status, 200);
    assert.equal(json.url, "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(json.tier, "starter");
    assert.equal(json.price, "price_starter");
    assert.equal(json.amount, 4900);
  });
  const sent = new URLSearchParams(f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body);
  assert.equal(sent.get("success_url"), "https://api.hlaverify.com/checkout/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(sent.get("cancel_url"), "https://api.hlaverify.com/pricing");
});

test("POST /v1/checkout consumes no daily quota", async () => {
  _resetPriceCache();
  assert.equal(isBillablePath("/v1/checkout"), false);
  const env = workerEnv({ STRIPE_SECRET_KEY: "rk_live_test" });
  await withFetch(stripeFetch(), async () => {
    for (let i = 0; i < 3; i++) {
      const { resp } = await call(env, "POST", "/v1/checkout", {
        headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "lab" }) });
      assert.equal(resp.status, 200);
    }
  });
  assert.equal(env.QUOTA._names.length, 0, "the daily counter must never be addressed by /v1/checkout");

  // A billable call right after still has its full allowance.
  const { resp } = await call(env, "GET", "/v1/allele/A*01:01");
  assert.equal(resp.headers.get("x-hla-verify-daily-remaining"), String(TIER_LIMITS.free.calls - 1));
});

test("POST /v1/checkout with no STRIPE_SECRET_KEY is a 503 pointing at email, not a 500", async () => {
  _resetPriceCache();
  const env = workerEnv();
  const { resp, json } = await call(env, "POST", "/v1/checkout", {
    headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "lab" }) });
  assert.equal(resp.status, 503);
  assert.match(json.detail, /hello@hlaverify\.com/);
});

test("GET /v1/checkout is a 405 naming the body it wants", async () => {
  _resetPriceCache();
  const { resp, json } = await call(workerEnv(), "GET", "/v1/checkout");
  assert.equal(resp.status, 405);
  assert.match(json.detail, /POST/);
});

test("GET /pricing through the worker renders live amounts and buy buttons", async () => {
  _resetPriceCache();
  const env = workerEnv({ STRIPE_SECRET_KEY: "rk_live_test" });
  await withFetch(stripeFetch(), async () => {
    const { resp, text } = await call(env, "GET", "/pricing");
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type"), /text\/html/);
    assert.match(text, /\$299\/mo/);
    assert.match(text, /data-tier="lab"/);
  });
});

test("GET /pricing with no STRIPE_SECRET_KEY still renders, with the email path", async () => {
  _resetPriceCache();
  const { resp, text } = await call(workerEnv(), "GET", "/pricing");
  assert.equal(resp.status, 200);
  assert.match(text, /mailto:hello@hlaverify\.com/);
  assert.doesNotMatch(text, /data-tier=/);
  assert.match(text, new RegExp(TIER_LIMITS.starter.price.replace(/[$]/g, "\\$")));
});

// -------------------------------------------------------- key issuance path

test("resolveTier still prefers session metadata over the price-id map", async () => {
  const secret = "whsec_test";
  const KEYS = fakeKV();
  // The map would say starter; the session metadata says scale. Metadata wins,
  // and no Stripe line-items call is made at all.
  const env = { KEYS, STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "rk_live_test",
    STRIPE_TIER_MAP: JSON.stringify({ price_scale: "starter" }) };
  const raw = JSON.stringify({ type: "checkout.session.completed",
    data: { object: { id: "cs_1", subscription: "sub_1", metadata: { tier: "scale" },
      customer_details: { email: "buyer@lab.example" } } } });
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, `${t}.${raw}`);
  const req = new Request("https://api.hlaverify.com/webhooks/stripe", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: raw });

  let lineItemCalls = 0;
  await withFetch(async (url) => { if (String(url).includes("line_items")) lineItemCalls++; return new Response("{}", { status: 200 }); },
    () => handleStripeWebhook(req, env));

  const apiKey = await KEYS.get("stripe_sub/sub_1");
  assert.ok(apiKey);
  assert.equal(JSON.parse(await KEYS.get(apiKey)).tier, "scale");
  assert.equal(lineItemCalls, 0, "session metadata must resolve the tier without an API call");
});

test("the tier /v1/checkout stamps on the session is the tier the webhook then issues", async () => {
  _resetPriceCache();
  const f = stripeFetch();
  const r = await createCheckoutSession(priceEnv(), { tier: "scale" }, { origin: "https://api.hlaverify.com", fetchImpl: f });
  const stamped = new URLSearchParams(f.calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body).get("metadata[tier]");
  assert.equal(stamped, "scale");

  const secret = "whsec_test";
  const KEYS = fakeKV();
  const raw = JSON.stringify({ type: "checkout.session.completed",
    data: { object: { id: r.id, subscription: "sub_2", metadata: { tier: stamped }, customer_details: { email: "b@lab.example" } } } });
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, `${t}.${raw}`);
  await handleStripeWebhook(new Request("https://api.hlaverify.com/webhooks/stripe", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: raw }),
    { KEYS, STRIPE_WEBHOOK_SECRET: secret });

  const apiKey = await KEYS.get("stripe_sub/sub_2");
  assert.equal(JSON.parse(await KEYS.get(apiKey)).tier, "scale");
});

// ---------------------------------------------------- the local test seam

test("STRIPE_API_BASE only redirects to loopback, never anywhere else", async () => {
  _resetPriceCache();
  const local = stripeFetch();
  await getPricing(priceEnv({ STRIPE_API_BASE: "http://127.0.0.1:8808" }), { fetchImpl: local });
  assert.match(local.listCalls()[0].url, /^http:\/\/127\.0\.0\.1:8808\/v1\/prices/);

  for (const hostile of ["https://evil.example", "http://stripe.com.evil.example", "not a url", ""]) {
    _resetPriceCache();
    const f = stripeFetch();
    await getPricing(priceEnv({ STRIPE_API_BASE: hostile }), { fetchImpl: f });
    assert.match(f.listCalls()[0].url, /^https:\/\/api\.stripe\.com\//, `STRIPE_API_BASE=${hostile} must be ignored`);
  }
});
