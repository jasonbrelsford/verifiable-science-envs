// NOT ROUTED; kept in the repo as a documented option for a merchant-of-record
// provider (Lemon Squeezy handles VAT/sales-tax remittance itself, which Stripe
// does not do on its own). Jason has decided to use Stripe only for now — see
// stripe.js, wired up at POST /webhooks/stripe in index.js. This file's tests
// still run and still pass; it is simply not reachable from index.js anymore.
//
// Self-serve key issuance webhook. Provider-agnostic by design: the KV record
// format below does not mention Lemon Squeezy, so a different billing provider
// can write the same shape and everything downstream (authorize() in index.js)
// keeps working unchanged.
//
// KV record shapes (namespace binding KEYS):
//   KEYS["<api-key>"]        = { label, tier, status: "active"|"revoked", email?,
//                                 provider?, provider_ref? }
//   KEYS["lskeys/<id>"]      = "<api-key>"   (secondary index: provider's
//                                 license/subscription id -> issued key, used
//                                 only to resolve revocation events back to a
//                                 key; "lskeys" is just this provider's index,
//                                 a different provider would use its own prefix)
//
// Lemon Squeezy field paths this file relies on, and what could and could not
// be confirmed in this session:
//   - Signature: header "X-Signature", hex HMAC-SHA256 of the raw request body
//     using the webhook's signing secret. Documented at
//     https://docs.lemonsqueezy.com/help/webhooks (fetch of that page returned
//     HTTP 403 in this session, so this is per the task instructions, NOT
//     independently re-verified against the live docs).
//   - Event name at payload.meta.event_name; resource at payload.data (type,
//     id, attributes). Also NOT independently re-verified (403 above) — this
//     is the standard Lemon Squeezy webhook envelope per the task instructions.
//   - License key string at payload.data.attributes.key, per
//     https://docs.lemonsqueezy.com/help/licensing/license-api (also 403'd;
//     not independently re-verified). The product/variant name field used to
//     pick a tier is guessed as attributes.variant_name / attributes.product_name
//     — NOT VERIFIED; if the real payload uses different keys, TIER_MAP lookups
//     will silently fall back to "starter" (see tierFor below) rather than error,
//     so check attrs on a real event and adjust the two field reads in
//     handleWebhook if needed.
//   - The field carrying the license key's id on subscription/order events
//     (subscription_expired, subscription_cancelled, order_refunded) is NOT
//     VERIFIED either; this file tries a couple of plausible shapes and is a
//     safe no-op (200 OK, nothing revoked) if none match, rather than guessing
//     and silently mis-revoking. Confirm against a real payload before relying
//     on that path.
//
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

const encoder = new TextEncoder();

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare over equal-length hex strings (falls back to false,
// not a throw, on length mismatch — still constant relative to the shorter
// input is not required here since a length mismatch already reveals nothing
// useful to an attacker beyond "wrong length").
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(secret, rawBody, headerSig) {
  if (!secret || !headerSig) return false;
  const expected = await hmacHex(secret, rawBody);
  return timingSafeEqualHex(expected, String(headerSig).trim().toLowerCase());
}

function tierFor(env, name) {
  let map = {};
  try {
    map = typeof env.TIER_MAP === "string" ? JSON.parse(env.TIER_MAP) : env.TIER_MAP || {};
  } catch (_) {
    map = {};
  }
  return (name && map[name]) || "starter";
}

function j(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function revokeByLicenseId(env, licenseId) {
  if (licenseId == null) return;
  const key = await env.KEYS.get(`lskeys/${licenseId}`);
  if (!key) return;
  const recRaw = await env.KEYS.get(key);
  if (!recRaw) return;
  let rec;
  try {
    rec = JSON.parse(recRaw);
  } catch (_) {
    return;
  }
  rec.status = "revoked";
  await env.KEYS.put(key, JSON.stringify(rec));
}

export async function handleWebhook(request, env) {
  const raw = await request.text();
  const sig = request.headers.get("x-signature") || "";
  const ok = await verifySignature(env.LEMONSQUEEZY_WEBHOOK_SECRET, raw, sig);
  if (!ok) return j({ detail: "missing or invalid X-Signature" }, 401);

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return j({ detail: "malformed JSON body" }, 400);
  }

  const event = (payload && payload.meta && payload.meta.event_name) || "unknown";
  const data = (payload && payload.data) || {};
  const attrs = data.attributes || {};

  if (!env.KEYS) return j({ ok: true, handled: event, note: "no KEYS namespace bound; ignored" });

  if (event === "license_key_created") {
    const key = attrs.key;
    const licenseId = data.id ?? null;
    const productName = attrs.variant_name || attrs.product_name || "";
    const tier = tierFor(env, productName);
    if (key) {
      await env.KEYS.put(
        key,
        JSON.stringify({
          label: attrs.user_email || productName || "self-serve",
          tier,
          status: "active",
          email: attrs.user_email,
          provider: "lemonsqueezy",
          provider_ref: licenseId,
        })
      );
      if (licenseId != null) await env.KEYS.put(`lskeys/${licenseId}`, key);
    }
    return j({ ok: true, handled: event });
  }

  if (event === "license_key_updated") {
    const licenseId = data.id ?? null;
    if (attrs.status === "disabled") await revokeByLicenseId(env, licenseId);
    return j({ ok: true, handled: event });
  }

  if (event === "subscription_expired" || event === "subscription_cancelled" || event === "order_refunded") {
    const licenseId =
      attrs.license_key_id ??
      (data.relationships && data.relationships["license-keys"] && data.relationships["license-keys"].data && data.relationships["license-keys"].data[0] && data.relationships["license-keys"].data[0].id) ??
      null;
    await revokeByLicenseId(env, licenseId);
    return j({ ok: true, handled: event });
  }

  return j({ ok: true, handled: event });
}
