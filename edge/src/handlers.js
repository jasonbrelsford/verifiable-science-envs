// Shared request-shape validation and engine dispatch used by BOTH the REST
// routes (index.js) and the MCP tool calls (mcp.js), so the two transports can
// never drift: same limits, same error text, same engine functions.
// Each function returns { ok:true, body, units } or { ok:false, status, detail }
// — the caller decides how to render that as HTTP or as an MCP tool result.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS, countGlTokens, MAX_GL_CHARS, MAX_GL_ALLELES } from "./engine.js";
import { batchDetail } from "./quota.js";

// MAX_TYPINGS is the ceiling — the most any tier may send in one
// /v1/normalize call, and what the OpenAPI document advertises. The cap that
// actually applies to a request is the caller's tier's (keys.js TIER_LIMITS),
// passed into doNormalize; it is never larger than this. MAX_TEXT does NOT vary
// by tier: 200,000 characters is a published contract for every caller.
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

// `tier` is the caller's tier and `cap` its per-call typings limit; both default
// to the ceiling so this module still works standalone (tests, the stdio path).
export async function doNormalize(eng, manifest, typings, { tier = "enterprise", cap = MAX_TYPINGS } = {}) {
  if (!Array.isArray(typings) || !typings.every((s) => typeof s === "string"))
    return bad(422, "typings must be a list of strings");
  const limit = Math.min(cap, MAX_TYPINGS);
  if (typings.length > limit) return bad(422, batchDetail(tier, limit, typings.length));
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
  `limits are issued on request today: email hello@hlaverify.com. We will email you when self-serve checkout opens.`;

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

// --------------------------------------------------- research access applications
// The research and education programme: free access for academic and nonprofit
// labs, approved one application at a time by a person. An application is not an
// account and not a key. It is one record per address in the KEYS namespace
// behind RESEARCH_PREFIX, holding what the applicant typed plus cf-ipcountry, a
// timestamp and a status. Never the IP, never a header dump.
//
// WHAT HAPPENS NEXT is deliberately outside the Worker. scripts/research_access.py
// (run by the owner on his own machine) lists the pending records, mints a
// single-use Stripe promotion code on the research coupon, and writes the code
// and `status: "approved"` back onto the record. Nothing here talks to Stripe:
// the Worker's Stripe key is restricted to prices and Checkout Sessions, and
// issuing a discount is an owner decision, not a request handler's.
//
// The containment rule is the same one BETA_PREFIX has, for the same reason:
// authorize() (index.js) treats ANY KV value that parses as truthy JSON as a
// starter key, so a prefixed record must never be reachable from a key lookup.
// authorizeKey() refuses a presented key starting with any RESERVED_PREFIXES
// entry outright, and issued keys ("hlv_" + base64url) contain no "/". Both
// halves are tested in test/research.test.mjs. Do not drop either one.
export const RESEARCH_PREFIX = "research/";

// Every prefix under which the KEYS namespace holds something that is NOT an
// API key but does parse as truthy JSON. Adding a prefix to this list is what
// keeps it out of authorizeKey(); adding one without it is the bug that made
// a beta/ record presentable as a paid key.
export const RESERVED_PREFIXES = [BETA_PREFIX, RESEARCH_PREFIX];

// use_case carries the reason the owner will approve or refuse on, so it gets
// more room than the beta list's; institution is a name, expected_volume a
// phrase like "about 20,000 typings a month".
export const MAX_INSTITUTION = 200, MAX_RESEARCH_USE_CASE = 1000, MAX_EXPECTED_VOLUME = 120;

// Required free-text field. Returns [value, null] or [null, detail].
function requiredText(v, name, max) {
  if (typeof v !== "string") return [null, `${name} must be a string`];
  const s = v.trim();
  if (!s) return [null, `${name} must not be empty`];
  if (s.length > max) return [null, `${name} must be at most ${max} characters`];
  return [s, null];
}

// Says plainly that a person reads this. Nothing here promises approval, and
// nothing promises a date: the queue is one owner's inbox.
const researchMessage = (already) =>
  `${already ? "Your research access application is already on file" : "Your research access application is recorded"}. ` +
  "Status: pending. A person reviews each one by hand, so this is not instant. If it is approved you will be emailed a " +
  "single-use code that takes 100% off a subscription for 12 months at self-serve checkout: no card, no contract. " +
  "Questions, or an application you need decided sooner: hello@hlaverify.com.";

// body: {email, institution, use_case, expected_volume?, source?}; country: cf-ipcountry or null.
export async function doResearchAccess(env, manifest, body, country) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, "body must be a JSON object");
  if (typeof body.email !== "string") return bad(422, "email must be a string");
  const email = body.email.trim();
  if (email.length > MAX_EMAIL) return bad(422, `email must be at most ${MAX_EMAIL} characters`);
  if (!EMAIL_RE.test(email)) return bad(422, "email must look like an address, e.g. name@lab.example");

  const [institution, instErr] = requiredText(body.institution, "institution", MAX_INSTITUTION);
  if (instErr) return bad(422, instErr);
  const [useCase, useCaseErr] = requiredText(body.use_case, "use_case", MAX_RESEARCH_USE_CASE);
  if (useCaseErr) return bad(422, useCaseErr);
  const [volume, volumeErr] = optional(body.expected_volume, "expected_volume", MAX_EXPECTED_VOLUME);
  if (volumeErr) return bad(422, volumeErr);
  const [source, sourceErr] = optional(body.source, "source", MAX_SOURCE);
  if (sourceErr) return bad(422, sourceErr);

  if (!env || !env.KEYS)
    return bad(503, "research applications are not available on this deployment; email hello@hlaverify.com");

  const kvKey = RESEARCH_PREFIX + email.toLowerCase();
  let already = false;
  try {
    already = (await env.KEYS.get(kvKey)) !== null;
  } catch (_) { /* read failure: fall through and write, put() is the real test */ }
  // Idempotent per address, and the FIRST application wins: a record that has
  // already been approved carries a promotion code, and re-applying must never
  // overwrite it with a fresh pending record.
  if (!already) {
    await env.KEYS.put(kvKey, JSON.stringify({
      email, institution, use_case: useCase, expected_volume: volume, source,
      ts: new Date().toISOString(),
      country: country || null,
      status: "pending",
    }));
  }
  return good({ ok: true, status: already ? "already_recorded" : "recorded",
    message: researchMessage(already), release: manifest.release }, 1);
}
