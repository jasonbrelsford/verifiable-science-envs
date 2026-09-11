// Shared request-shape validation and engine dispatch used by BOTH the REST
// routes (index.js) and the MCP tool calls (mcp.js), so the two transports can
// never drift: same limits, same error text, same engine functions.
// Each function returns { ok:true, body, units } or { ok:false, status, detail }
// — the caller decides how to render that as HTTP or as an MCP tool result.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS } from "./engine.js";

export const MAX_TEXT = 200_000, MAX_TYPINGS = 5_000, MAX_LOCI = 24, MAX_PER_LOCUS = 4, MAX_NAME = 64;

export function validateTyping(obj, side) {
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

const bad = (status, detail) => ({ ok: false, status, detail });
const good = (body, units = 0) => ({ ok: true, body, units });

export async function doVerify(eng, manifest, text) {
  if (typeof text !== "string") return bad(422, "text must be a string");
  if (text.length > MAX_TEXT) return bad(422, `text must be at most ${MAX_TEXT} characters`);
  const body = await eng.verify(text);
  return good(body, body.tokens.length);
}

export async function doNormalize(eng, manifest, typings) {
  if (!Array.isArray(typings) || !typings.every((s) => typeof s === "string"))
    return bad(422, "typings must be a list of strings");
  if (typings.length > MAX_TYPINGS) return bad(422, `typings must have at most ${MAX_TYPINGS} items`);
  const body = await eng.normalizeBatch(typings);
  return good(body, typings.length);
}

export async function doAllele(eng, manifest, rawName) {
  if (typeof rawName !== "string" || !rawName) return bad(422, "name must be a non-empty string");
  if (rawName.length > MAX_NAME) return bad(422, "name too long");
  const { status, body } = await eng.allele(rawName);
  return { ok: true, status, body, units: 1 };
}

export async function doMatch(eng, manifest, framework, recipient, donor) {
  const fw = framework ?? "8/8";
  if (typeof fw !== "string" || !Object.prototype.hasOwnProperty.call(FRAMEWORKS, fw))
    return bad(422, `framework must be one of ${Object.keys(FRAMEWORKS).sort().join(", ")}`);
  const v = validateTyping(recipient, "recipient") || validateTyping(donor, "donor");
  if (v) return bad(422, v);
  const body = await eng.match(fw, recipient, donor);
  return good(body, FRAMEWORKS[fw].length);
}
