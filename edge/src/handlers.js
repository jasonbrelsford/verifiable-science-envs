// Shared request-shape validation and engine dispatch used by BOTH the REST
// routes (index.js) and the MCP tool calls (mcp.js), so the two transports can
// never drift: same limits, same error text, same engine functions.
// Each function returns { ok:true, body, units } or { ok:false, status, detail }
// — the caller decides how to render that as HTTP or as an MCP tool result.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS, countGlTokens, MAX_GL_CHARS, MAX_GL_ALLELES } from "./engine.js";

export const MAX_TEXT = 200_000, MAX_TYPINGS = 5_000, MAX_LOCI = 24, MAX_PER_LOCUS = 4, MAX_NAME = 64;
export { MAX_GL_CHARS, MAX_GL_ALLELES };

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

function sumUnits(typing) {
  return Object.values(typing).reduce((a, v) => a + v.length, 0);
}

export async function doTypingCheck(eng, manifest, typing) {
  const v = validateTyping(typing, "typing");
  if (v) return bad(422, v);
  const body = await eng.checkTyping(typing);
  return good(body, sumUnits(typing));
}

export async function doCompat(eng, manifest, recipient, donor) {
  const v = validateTyping(recipient, "recipient") || validateTyping(donor, "donor");
  if (v) return bad(422, v);
  const body = await eng.compat(recipient, donor);
  return good(body, sumUnits(recipient) + sumUnits(donor));
}

export async function doGlString(eng, manifest, gl) {
  if (typeof gl !== "string" || gl.trim() === "") return bad(422, "gl must be a non-empty string");
  if (gl.length > MAX_GL_CHARS) return bad(422, `gl must be at most ${MAX_GL_CHARS} characters`);
  const s = gl.trim();
  if (countGlTokens(s) > MAX_GL_ALLELES) return bad(422, `gl must contain at most ${MAX_GL_ALLELES} alleles`);
  const body = await eng.glString(gl);
  return good(body, countGlTokens(s));
}

// ----------------------------------------------------------- beta signup
// The free public beta's notification list. Not an account and not a key: one
// record per address in the KEYS namespace behind the BETA_PREFIX, holding only
// what the signer typed plus cf-ipcountry — never the IP, never a header dump.
//
// authorize() (index.js) treats ANY KV value that parses as truthy JSON as a
// starter key, so these records must be unreachable from a key lookup. They are
// reachable only under a prefix containing "/", which no issued key contains
// (stripe.js generateApiKey is "hlv_" + base64url), and authorizeKey() refuses a
// presented key starting with BETA_PREFIX outright. Both halves are tested in
// test/beta.test.mjs — do not drop either one.
export const BETA_PREFIX = "beta/";
export const MAX_EMAIL = 254, MAX_ORG = 120, MAX_USE_CASE = 500, MAX_SOURCE = 120;

// Deliberately loose: one @, no whitespace or address-list punctuation, a dotted
// domain. Turning away a deliverable address costs a signup; accepting an odd
// one costs nothing — nothing is authenticated by it.
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[^\s@,;:<>"'\\]{2,}$/;

// Optional free-text field: absent/null is fine, anything else must be a string
// within its cap. Returns [value, null] or [null, detail].
function optional(v, name, max) {
  if (v === undefined || v === null) return [null, null];
  if (typeof v !== "string") return [null, `${name} must be a string`];
  const s = v.trim();
  if (s.length > max) return [null, `${name} must be at most ${max} characters`];
  return [s || null, null];
}

const betaMessage = (release, already) =>
  `${already ? "You are already on the beta list" : "You are on the beta list"} — free public beta. ` +
  `Verdicts are production-quality and pinned to IPD-IMGT/HLA ${release}. Paid keys with higher rate ` +
  `limits arrive within days; we will email you, or email hello@hlaverify.com for a beta key now.`;

// body: {email, org?, use_case?, source?}; country: cf-ipcountry or null.
export async function doBetaSignup(env, manifest, body, country) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, "body must be a JSON object");
  if (typeof body.email !== "string") return bad(422, "email must be a string");
  const email = body.email.trim();
  if (email.length > MAX_EMAIL) return bad(422, `email must be at most ${MAX_EMAIL} characters`);
  if (!EMAIL_RE.test(email)) return bad(422, "email must look like an address, e.g. name@lab.example");

  const [org, orgErr] = optional(body.org, "org", MAX_ORG);
  if (orgErr) return bad(422, orgErr);
  const [useCase, useCaseErr] = optional(body.use_case, "use_case", MAX_USE_CASE);
  if (useCaseErr) return bad(422, useCaseErr);
  const [source, sourceErr] = optional(body.source, "source", MAX_SOURCE);
  if (sourceErr) return bad(422, sourceErr);

  if (!env || !env.KEYS) return bad(503, "the beta list is not available on this deployment — email hello@hlaverify.com");

  const kvKey = BETA_PREFIX + email.toLowerCase();
  let already = false;
  try {
    already = (await env.KEYS.get(kvKey)) !== null;
  } catch (_) { /* read failure: fall through and write, put() is the real test */ }
  if (!already) {
    await env.KEYS.put(kvKey, JSON.stringify({
      email, org, use_case: useCase, source,
      ts: new Date().toISOString(),
      country: country || null,
    }));
  }
  return good({ ok: true, status: already ? "already_recorded" : "recorded",
    message: betaMessage(manifest.release, already), release: manifest.release }, 1);
}
