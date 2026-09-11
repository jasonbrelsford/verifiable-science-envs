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
