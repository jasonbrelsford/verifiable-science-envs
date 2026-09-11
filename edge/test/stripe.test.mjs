// Stripe webhook tests: signature verification, key issuance/revocation via the
// KV mock pattern from mcp.test.mjs, price-id -> tier mapping with a stubbed
// fetch, and an end-to-end check that an issued key authorizes a real request
// through index.js's actual authorize() path (real engine, real shards, via an
// ASSETS stub reading from disk — same trick golden.test.mjs uses for loadShard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { hmacHex, verifyStripeSignature, handleStripeWebhook, resolveCheckoutSuccess, subIndexKey, piIndexKey } from "../src/stripe.js";
import worker from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

function fakeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

async function signedRequest(secret, raw, { timestamp, headers = {} } = {}) {
  const t = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret || "", `${t}.${raw}`);
  return new Request("https://assets.local/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}`, ...headers },
    body: raw,
  });
}

function withFetch(mockFn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = orig; });
}

// ------------------------------------------------------------ signature

test("verifyStripeSignature: valid signature", async () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ type: "ping" });
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, `${t}.${raw}`);
  assert.equal(await verifyStripeSignature(secret, raw, `t=${t},v1=${sig}`), true);
});

test("verifyStripeSignature: tampered body fails", async () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ type: "ping" });
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, `${t}.${raw}`);
  assert.equal(await verifyStripeSignature(secret, raw + "tampered", `t=${t},v1=${sig}`), false);
});

test("verifyStripeSignature: wrong secret fails", async () => {
  const raw = JSON.stringify({ type: "ping" });
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex("whsec_a", `${t}.${raw}`);
  assert.equal(await verifyStripeSignature("whsec_b", raw, `t=${t},v1=${sig}`), false);
});

test("verifyStripeSignature: stale timestamp (>5 min) fails", async () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ type: "ping" });
  const t = (Math.floor(Date.now() / 1000) - 400).toString();
  const sig = await hmacHex(secret, `${t}.${raw}`);
  assert.equal(await verifyStripeSignature(secret, raw, `t=${t},v1=${sig}`), false);
  // just inside tolerance should still pass
  const t2 = (Math.floor(Date.now() / 1000) - 200).toString();
  const sig2 = await hmacHex(secret, `${t2}.${raw}`);
  assert.equal(await verifyStripeSignature(secret, raw, `t=${t2},v1=${sig2}`), true);
});

test("verifyStripeSignature: missing header fails", async () => {
  assert.equal(await verifyStripeSignature("whsec_test", "{}", ""), false);
  assert.equal(await verifyStripeSignature("whsec_test", "{}", null), false);
});

test("verifyStripeSignature: unset secret fails even with a well-formed header", async () => {
  const raw = "{}";
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex("whatever", `${t}.${raw}`);
  assert.equal(await verifyStripeSignature(undefined, raw, `t=${t},v1=${sig}`), false);
  assert.equal(await verifyStripeSignature("", raw, `t=${t},v1=${sig}`), false);
});

test("handleStripeWebhook: 401 on missing/invalid/unset-secret, 400 on malformed JSON", async () => {
  const raw = JSON.stringify({ type: "ping" });

  // missing header
  const noHeaderReq = new Request("https://assets.local/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  assert.equal((await handleStripeWebhook(noHeaderReq, { STRIPE_WEBHOOK_SECRET: "whsec_test", KEYS: fakeKV() })).status, 401);

  // wrong secret
  const req = await signedRequest("whsec_test", raw);
  assert.equal((await handleStripeWebhook(req, { STRIPE_WEBHOOK_SECRET: "different", KEYS: fakeKV() })).status, 401);

  // unset secret on the worker side
  const req2 = await signedRequest("whsec_test", raw);
  assert.equal((await handleStripeWebhook(req2, { KEYS: fakeKV() })).status, 401);

  // malformed JSON body (still signed correctly over the malformed bytes)
  const badRaw = "{not json";
  const req3 = await signedRequest("whsec_test", badRaw);
  const resp3 = await handleStripeWebhook(req3, { STRIPE_WEBHOOK_SECRET: "whsec_test", KEYS: fakeKV() });
  assert.equal(resp3.status, 400);
});

// ------------------------------------------------------------- key issuance

test("checkout.session.completed (metadata.tier) creates an active key + subscription index", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const session = {
    id: "cs_meta_1",
    mode: "subscription",
    subscription: "sub_meta_1",
    metadata: { tier: "pro" },
    customer_details: { email: "buyer@example.com", name: "Acme Labs" },
  };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body, { ok: true, handled: "checkout.session.completed" });

  const apiKey = await env.KEYS.get(subIndexKey("sub_meta_1"));
  assert.ok(apiKey && apiKey.startsWith("hlv_"));
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.tier, "pro");
  assert.equal(rec.status, "active");
  assert.equal(rec.provider, "stripe");
  assert.equal(rec.label, "buyer@example.com");
  assert.equal(rec.ref, "sub_meta_1");
});

test("checkout.session.completed: price-id resolves tier via STRIPE_TIER_MAP when metadata.tier is absent", async () => {
  const secret = "whsec_test";
  const env = {
    STRIPE_WEBHOOK_SECRET: secret,
    KEYS: fakeKV(),
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_TIER_MAP: JSON.stringify({ price_pro_123: "pro" }),
  };
  const session = { id: "cs_price_1", mode: "subscription", subscription: "sub_price_1", customer_details: { email: "x@y.com" } };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });

  await withFetch(
    async (url, init) => {
      assert.match(String(url), /\/v1\/checkout\/sessions\/cs_price_1\/line_items$/);
      assert.match(init.headers.authorization, /^Bearer sk_test_123$/);
      return new Response(JSON.stringify({ data: [{ price: { id: "price_pro_123" } }] }), { status: 200 });
    },
    async () => {
      const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
      assert.equal(resp.status, 200);
    }
  );

  const apiKey = await env.KEYS.get(subIndexKey("sub_price_1"));
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.tier, "pro");
});

test("checkout.session.completed: unmapped/invalid tier falls back to starter", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const session = { id: "cs_fallback_1", mode: "payment", payment_intent: "pi_fallback_1", metadata: { tier: "not-a-real-tier" } };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });
  await handleStripeWebhook(await signedRequest(secret, raw), env);
  const apiKey = await env.KEYS.get(piIndexKey("pi_fallback_1"));
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.tier, "starter");
});

test("checkout.session.completed: writes the key into Stripe customer metadata when a customer and secret key are present", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV(), STRIPE_SECRET_KEY: "sk_test_456" };
  const session = {
    id: "cs_cust_1",
    mode: "subscription",
    subscription: "sub_cust_1",
    customer: "cus_123",
    metadata: { tier: "starter" },
    customer_details: { email: "a@b.com" },
  };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });

  let sawCustomerUpdate = false;
  await withFetch(async (url, init) => {
    if (String(url).endsWith("/v1/customers/cus_123")) {
      sawCustomerUpdate = true;
      assert.equal(init.method, "POST");
      assert.match(init.body, /metadata%5Bhla_verify_key%5D=hlv_/);
      return new Response(JSON.stringify({ id: "cus_123" }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }, async () => {
    await handleStripeWebhook(await signedRequest(secret, raw), env);
  });
  assert.equal(sawCustomerUpdate, true);
});

test("checkout.session.completed: no subscription/payment_intent id is a safe no-op", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_empty", mode: "setup" } } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  assert.equal(env.KEYS._store.size, 0);
});

// -------------------------------------------------------------- revocation

async function issueKey(env, secret, session) {
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });
  await handleStripeWebhook(await signedRequest(secret, raw), env);
  const indexKey = session.subscription ? subIndexKey(session.subscription) : piIndexKey(session.payment_intent);
  return env.KEYS.get(indexKey);
}

test("customer.subscription.deleted revokes the key found via the subscription index", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const apiKey = await issueKey(env, secret, { id: "cs_d1", mode: "subscription", subscription: "sub_d1", metadata: { tier: "starter" }, customer_details: {} });

  const raw = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_d1" } } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.status, "revoked");
});

test("customer.subscription.updated: past_due/unpaid/canceled revoke, active reactivates", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const apiKey = await issueKey(env, secret, { id: "cs_u1", mode: "subscription", subscription: "sub_u1", metadata: { tier: "pro" }, customer_details: {} });

  for (const status of ["past_due", "unpaid", "canceled"]) {
    const raw = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_u1", status } } });
    const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
    assert.equal(resp.status, 200);
    const rec = JSON.parse(await env.KEYS.get(apiKey));
    assert.equal(rec.status, "revoked", `expected revoked after status=${status}`);
  }

  const rawActive = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_u1", status: "active" } } });
  await handleStripeWebhook(await signedRequest(secret, rawActive), env);
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.status, "active");
});

test("charge.refunded (full refund) revokes the key found via the payment_intent index", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const apiKey = await issueKey(env, secret, { id: "cs_r1", mode: "payment", payment_intent: "pi_r1", metadata: { tier: "starter" }, customer_details: {} });

  const raw = JSON.stringify({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_r1", refunded: true } } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.status, "revoked");
});

test("charge.refunded: a partial refund (refunded:false) does not revoke", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const apiKey = await issueKey(env, secret, { id: "cs_r2", mode: "payment", payment_intent: "pi_r2", metadata: { tier: "starter" }, customer_details: {} });

  const raw = JSON.stringify({ type: "charge.refunded", data: { object: { id: "ch_2", payment_intent: "pi_r2", refunded: false } } });
  await handleStripeWebhook(await signedRequest(secret, raw), env);
  const rec = JSON.parse(await env.KEYS.get(apiKey));
  assert.equal(rec.status, "active");
});

test("invoice.payment_failed: no-op response, logs to USAGE if bound, never throws without it", async () => {
  const secret = "whsec_test";
  const points = [];
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV(), USAGE: { writeDataPoint: (p) => points.push(p) } };
  const raw = JSON.stringify({ type: "invoice.payment_failed", data: { object: { customer: "cus_1", subscription: "sub_1" } } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, handled: "invoice.payment_failed" });
  assert.equal(points.length, 1);

  const env2 = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const resp2 = await handleStripeWebhook(await signedRequest(secret, raw), env2);
  assert.equal(resp2.status, 200);
});

test("unknown event type returns 200 {ok:true, handled:<type>}", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV() };
  const raw = JSON.stringify({ type: "payment_intent.succeeded", data: { object: {} } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), env);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, handled: "payment_intent.succeeded" });
});

test("no KEYS namespace bound: ignored but still 200", async () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_x", subscription: "sub_x" } } });
  const resp = await handleStripeWebhook(await signedRequest(secret, raw), { STRIPE_WEBHOOK_SECRET: secret });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.equal(body.handled, "checkout.session.completed");
});

// --------------------------------------------------------- checkout success

test("resolveCheckoutSuccess: no_secret when STRIPE_SECRET_KEY is unset", async () => {
  const result = await resolveCheckoutSuccess("cs_anything", {});
  assert.deepEqual(result, { status: "no_secret" });
});

test("resolveCheckoutSuccess: not_found for a missing session id", async () => {
  const result = await resolveCheckoutSuccess("", { STRIPE_SECRET_KEY: "sk_test" });
  assert.deepEqual(result, { status: "not_found" });
});

test("resolveCheckoutSuccess: pending when paid but the webhook hasn't written the key yet", async () => {
  const env = { STRIPE_SECRET_KEY: "sk_test", KEYS: fakeKV() };
  await withFetch(async () => new Response(JSON.stringify({ payment_status: "paid", subscription: "sub_notyet" }), { status: 200 }), async () => {
    const result = await resolveCheckoutSuccess("cs_notyet", env);
    assert.equal(result.status, "pending");
  });
});

test("resolveCheckoutSuccess: ok once the webhook has written the key", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test", KEYS: fakeKV() };
  const apiKey = await issueKey(env, secret, { id: "cs_ok1", mode: "subscription", subscription: "sub_ok1", metadata: { tier: "pro" }, customer_details: { email: "z@z.com" } });

  await withFetch(async () => new Response(JSON.stringify({ payment_status: "paid", subscription: "sub_ok1" }), { status: 200 }), async () => {
    const result = await resolveCheckoutSuccess("cs_ok1", env);
    assert.deepEqual(result, { status: "ok", key: apiKey, tier: "pro", label: "z@z.com" });
  });
});

// ----------------------------------------------- end-to-end through index.js

// ASSETS binding stub: same disk-backed trick golden.test.mjs uses for loadShard,
// wired through the Workers ASSETS.fetch() interface index.js actually calls.
const ASSETS = {
  async fetch(url) {
    const u = new URL(url);
    const rel = u.pathname.replace(/^\/data\//, "");
    try {
      const text = await readFile(path.join(pub, "data", rel), "utf8");
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e.code === "ENOENT") return new Response(null, { status: 404 });
      throw e;
    }
  },
};

test("an issued Stripe key authorizes a /v1/allele request at the right tier through the real authorize() path", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV(), ASSETS };
  const apiKey = await issueKey(env, secret, {
    id: "cs_e2e_1",
    mode: "subscription",
    subscription: "sub_e2e_1",
    metadata: { tier: "pro" },
    customer_details: { email: "e2e@example.com" },
  });
  assert.ok(apiKey);

  const req = new Request("https://assets.local/v1/allele/A%2A01%3A01", { method: "GET", headers: { "x-api-key": apiKey } });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-hla-verify-tier"), "pro");
  const body = await resp.json();
  assert.ok(["assigned", "valid_prefix"].includes(body.status), `unexpected allele status ${body.status}`);
});

test("a revoked Stripe key is rejected with 401 through the real authorize() path", async () => {
  const secret = "whsec_test";
  const env = { STRIPE_WEBHOOK_SECRET: secret, KEYS: fakeKV(), ASSETS };
  const apiKey = await issueKey(env, secret, {
    id: "cs_e2e_2",
    mode: "subscription",
    subscription: "sub_e2e_2",
    metadata: { tier: "starter" },
    customer_details: { email: "e2e2@example.com" },
  });
  const rawRevoke = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_e2e_2" } } });
  await handleStripeWebhook(await signedRequest(secret, rawRevoke), env);

  const req = new Request("https://assets.local/v1/allele/A%2A01%3A01", { method: "GET", headers: { "x-api-key": apiKey } });
  const resp = await worker.fetch(req, env, {});
  assert.equal(resp.status, 401);
});
