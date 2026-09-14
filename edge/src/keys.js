// Parses the HLA_VERIFY_API_KEYS secret and (optionally) a KV-stored key record
// into one shape: { label, tier }. Grammar for the secret, comma-separated:
//   key=label:tier   (preferred)
//   key=label         (legacy; tier defaults to "enterprise" so keys minted
//                      before tiers existed keep their old uncapped behavior)
//   key               (bare; label defaults to "key", tier "enterprise")
// Tiers: free (anonymous only, never presented as a key), starter, pro,
// enterprise (uncapped). An unrecognized trailing ":word" is treated as part
// of the label rather than a tier, so labels may contain colons.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

export const TIERS = ["free", "starter", "pro", "enterprise"];

// Shared API-key lookup used by both index.js's authorize() (REST/MCP requests) and
// oauth.js's consent handler ("Use my HLA-Verify API key"): resolves a presented key
// against HLA_VERIFY_API_KEYS (secret) first, then env.KEYS (KV, self-serve/Stripe
// keys), exactly the precedence authorize() has always used. Does NOT touch rate
// limiters (callers that need per-request limiting do that themselves) and never
// logs the key. Returns:
//   { label, tier }       — valid, usable key
//   { revoked: true }     — a KV-backed key that exists but was revoked
//   null                  — not found in either source
export async function lookupApiKey(presented, env) {
  if (!presented) return null;
  const keys = parseKeys(env.HLA_VERIFY_API_KEYS);
  if (keys.has(presented)) return keys.get(presented);
  if (env.KEYS) {
    let rec = null;
    try {
      const raw = await env.KEYS.get(presented);
      rec = raw ? JSON.parse(raw) : null;
    } catch (_) { /* malformed record: treat as absent */ }
    if (rec) {
      if (rec.status === "revoked") return { revoked: true };
      return { label: rec.label || "self-serve", tier: rec.tier || "starter" };
    }
  }
  return null;
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
