// Stripe billing integration: webhook handler that issues/revokes self-serve
// API keys, plus the lookup used by the /checkout/success page. Provider field
// in the KV record is "stripe" but the record shape is the SAME provider-agnostic
// shape webhook.js (Lemon Squeezy) uses, so authorize() in index.js needs no
// changes to read either.
//
// KV record shapes (namespace binding KEYS):
//   KEYS["<api-key>"]              = { label, tier, status: "active"|"revoked", email,
//                                       created, provider: "stripe", ref }
//   KEYS["stripe_sub/<sub_id>"]    = "<api-key>"   (secondary index: subscription id -> key,
//                                       used by subscription.updated/deleted and by
//                                       /checkout/success to find a subscription-mode key)
//   KEYS["stripe_pi/<pi_id>"]      = "<api-key>"   (secondary index: payment_intent id -> key,
//                                       used by charge.refunded and by /checkout/success
//                                       to find a one-time-payment-mode key)
//
// Facts below were checked against https://docs.stripe.com in this session (2026-09-11).
// Anything not listed here as verified is a best-effort reading of the task spec, flagged
// inline rather than guessed silently.
//
// VERIFIED:
//   - Stripe-Signature header format is "t=<ts>,v1=<sig>[,v1=<sig>...][,v0=<sig>]" (comma
//     separated key=value pairs; multiple v1 values can be present during secret rotation).
//     Signed payload is "{timestamp}.{raw request body}", HMAC-SHA256 keyed by the webhook's
//     signing secret (whsec_...), compared with a constant-time string comparison. Default
//     replay tolerance in Stripe's own libraries is 5 minutes.
//     https://docs.stripe.com/webhooks/signatures (see "Verify manually")
//   - GET /v1/checkout/sessions/{id}/line_items returns {data:[{price:{id, ...}, ...}], ...}.
//     https://docs.stripe.com/api/checkout/sessions/line_items
//   - POST /v1/customers/{id} accepts form-encoded metadata[key]=value and merges it into
//     the customer's existing metadata.
//     https://docs.stripe.com/api/customers/update
//   - checkout.session object fields used here: mode ("payment"|"setup"|"subscription"),
//     customer_details.{email,name}, client_reference_id, metadata, subscription (sub id or
//     null), payment_intent (pi id or null), payment_status ("paid"|"unpaid"|"no_payment_required"),
//     customer (customer id or null).
//     https://docs.stripe.com/api/checkout/sessions/object
//   - Subscription.status enum: incomplete, incomplete_expired, trialing, active, past_due,
//     canceled, unpaid, paused.
//     https://docs.stripe.com/api/subscriptions/object
//   - Charge.refunded is a boolean (true only once the charge is FULLY refunded; a partial
//     refund leaves it false) and Charge.payment_intent is the linked PaymentIntent id.
//     https://docs.stripe.com/api/charges/object
//
// NOT independently verified (no docs.stripe.com page fetched for these in this session):
//   - The exact event envelope for invoice.payment_failed (this file only reads
//     event.data.object.customer/subscription for a metering log; a missing field there is
//     harmless, it just logs blanks).
//   - Whether GET /v1/checkout/sessions/{id} alone (without ?expand[]=...) always returns
//     "subscription" and "payment_intent" as plain id strings rather than expanded objects;
//     assumed yes (that's the default, unexpanded, per the Session object page above) — if a
//     future Stripe API version changes this, resolveCheckoutSuccess's `session.subscription`/
//     `session.payment_intent` reads would need `.id` added.
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { TIERS } from "./keys.js";

const encoder = new TextEncoder();

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseStripeSignatureHeader(header) {
  let timestamp = null;
  const v1 = [];
  for (const part of String(header || "").split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") v1.push(v);
  }
  return { timestamp, v1 };
}

// Verifies a Stripe-Signature header per docs.stripe.com/webhooks/signatures.
// `rawBody` MUST be the exact bytes Stripe sent (no re-serialization). Rejects
// a missing secret, a missing/malformed header, every v1 signature mismatching,
// or a timestamp older than `toleranceSeconds` (default 300 = 5 minutes, matching
// Stripe's own library default).
export async function verifyStripeSignature(secret, rawBody, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const { timestamp, v1 } = parseStripeSignatureHeader(header);
  if (!timestamp || !/^\d+$/.test(timestamp) || v1.length === 0) return false;
  const ageSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return v1.some((sig) => timingSafeEqualHex(expected, String(sig).trim().toLowerCase()));
}

function base64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateApiKey() {
  return "hlv_" + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function parseTierMap(s) {
  try {
    const m = typeof s === "string" ? JSON.parse(s) : s || {};
    return m && typeof m === "object" ? m : {};
  } catch (_) {
    return {};
  }
}

const SELLABLE_TIERS = TIERS.filter((t) => t !== "free");
const validTier = (t) => typeof t === "string" && SELLABLE_TIERS.includes(t);

function j(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const subIndexKey = (id) => `stripe_sub/${id}`;
const piIndexKey = (id) => `stripe_pi/${id}`;

async function fetchLineItemPriceId(sessionId, secretKey) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`, {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  const item = body && Array.isArray(body.data) ? body.data[0] : null;
  return (item && item.price && item.price.id) || null;
}

async function setCustomerMetadataKey(customerId, secretKey, apiKey) {
  const params = new URLSearchParams();
  params.set("metadata[hla_verify_key]", apiKey);
  await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

// Resolution order: session.metadata.tier (no API call) first, then — only if
// that's absent/invalid and a secret key is configured — the purchased price id
// via the line_items endpoint mapped through STRIPE_TIER_MAP, then "starter".
async function resolveTier(session, env) {
  const metaTier = session.metadata && session.metadata.tier;
  if (validTier(metaTier)) return metaTier;
  if (env.STRIPE_SECRET_KEY) {
    try {
      const priceId = await fetchLineItemPriceId(session.id, env.STRIPE_SECRET_KEY);
      const mapped = priceId ? parseTierMap(env.STRIPE_TIER_MAP)[priceId] : null;
      if (validTier(mapped)) return mapped;
    } catch (_) {
      // Stripe API unreachable or erroring: fall through to the default tier
      // rather than failing key issuance outright.
    }
  }
  return "starter";
}

async function findRecordByIndex(env, indexKey) {
  const apiKey = await env.KEYS.get(indexKey);
  if (!apiKey) return null;
  const raw = await env.KEYS.get(apiKey);
  if (!raw) return null;
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  return { apiKey, rec };
}

async function setStatusByIndex(env, indexKey, status) {
  const found = await findRecordByIndex(env, indexKey);
  if (!found) return;
  found.rec.status = status;
  await env.KEYS.put(found.apiKey, JSON.stringify(found.rec));
}

async function onCheckoutCompleted(session, env) {
  const ref = session.subscription || session.payment_intent || null;
  if (!ref) return j({ ok: true, handled: "checkout.session.completed", note: "no subscription or payment_intent id; nothing to key" });

  const tier = await resolveTier(session, env);
  const details = session.customer_details || {};
  const label = details.email || details.name || "self-serve";
  const apiKey = generateApiKey();
  const record = {
    label,
    tier,
    status: "active",
    email: details.email || null,
    created: new Date().toISOString(),
    provider: "stripe",
    ref,
  };
  await env.KEYS.put(apiKey, JSON.stringify(record));
  const indexKey = session.subscription ? subIndexKey(session.subscription) : piIndexKey(session.payment_intent);
  await env.KEYS.put(indexKey, apiKey);

  if (env.STRIPE_SECRET_KEY && session.customer) {
    try {
      await setCustomerMetadataKey(session.customer, env.STRIPE_SECRET_KEY, apiKey);
    } catch (_) {
      // Best-effort delivery via the Stripe dashboard/receipts; the key still
      // works and the /checkout/success page can still find it via the index.
    }
  }

  return j({ ok: true, handled: "checkout.session.completed" });
}

async function onSubscriptionDeleted(sub, env) {
  await setStatusByIndex(env, subIndexKey(sub.id), "revoked");
  return j({ ok: true, handled: "customer.subscription.deleted" });
}

async function onSubscriptionUpdated(sub, env) {
  const status = sub.status;
  if (status === "past_due" || status === "unpaid" || status === "canceled") {
    await setStatusByIndex(env, subIndexKey(sub.id), "revoked");
  } else if (status === "active") {
    await setStatusByIndex(env, subIndexKey(sub.id), "active");
  }
  return j({ ok: true, handled: "customer.subscription.updated" });
}

async function onChargeRefunded(charge, env) {
  if (charge.refunded && charge.payment_intent) {
    await setStatusByIndex(env, piIndexKey(charge.payment_intent), "revoked");
  }
  return j({ ok: true, handled: "charge.refunded" });
}

function logInvoicePaymentFailed(env, invoice) {
  if (!env.USAGE) return;
  try {
    env.USAGE.writeDataPoint({
      indexes: [String(invoice.customer || "unknown")],
      blobs: ["stripe", "invoice.payment_failed", String(invoice.subscription || "")],
      doubles: [1, 0],
    });
  } catch (_) {
    // metering must never break webhook processing
  }
}

// Handles POST /webhooks/stripe. Verifies the signature itself (no upstream
// auth needed). Always returns 200 {ok:true, handled:<event.type>} for a
// verified, parseable event — including event types we don't act on — because
// Stripe retries non-2xx responses; 401 only for a signature/secret failure,
// 400 only for an unparseable body.
export async function handleStripeWebhook(request, env) {
  const raw = await request.text();
  const sigHeader = request.headers.get("stripe-signature") || "";
  const ok = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, raw, sigHeader);
  if (!ok) return j({ detail: "missing or invalid Stripe-Signature" }, 401);

  let event;
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return j({ detail: "malformed JSON body" }, 400);
  }

  const type = event.type || "unknown";
  const obj = (event.data && event.data.object) || {};

  if (!env.KEYS) return j({ ok: true, handled: type, note: "no KEYS namespace bound; ignored" });

  if (type === "checkout.session.completed") return onCheckoutCompleted(obj, env);
  if (type === "customer.subscription.deleted") return onSubscriptionDeleted(obj, env);
  if (type === "customer.subscription.updated") return onSubscriptionUpdated(obj, env);
  if (type === "charge.refunded") return onChargeRefunded(obj, env);
  if (type === "invoice.payment_failed") {
    logInvoicePaymentFailed(env, obj);
    return j({ ok: true, handled: type });
  }

  return j({ ok: true, handled: type });
}

// Used by GET /checkout/success in index.js. Fetches the live session from
// Stripe (never trusts a client-supplied session_id's contents beyond using it
// as a lookup key), confirms it was actually paid, and resolves the issued key
// via the same secondary index the webhook writes.
export async function resolveCheckoutSuccess(sessionId, env) {
  if (!env.STRIPE_SECRET_KEY) return { status: "no_secret" };
  if (!sessionId) return { status: "not_found" };

  let session;
  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!resp.ok) return { status: "not_found" };
    session = await resp.json();
  } catch (_) {
    return { status: "not_found" };
  }

  if (session.payment_status !== "paid") return { status: "not_found" };
  if (!env.KEYS) return { status: "pending" };

  const ref = session.subscription || session.payment_intent || null;
  if (!ref) return { status: "pending" };
  const indexKey = session.subscription ? subIndexKey(session.subscription) : piIndexKey(session.payment_intent);
  const found = await findRecordByIndex(env, indexKey);
  if (!found) return { status: "pending" };

  return { status: "ok", key: found.apiKey, tier: found.rec.tier, label: found.rec.label };
}

export { subIndexKey, piIndexKey, findRecordByIndex };
