// Shared request-shape validation and engine dispatch used by BOTH the REST
// routes (index.js) and the MCP tool calls (mcp.js), so the two transports can
// never drift: same limits, same error text, same engine functions.
// Each function returns { ok:true, body, units } or { ok:false, status, detail }
// — the caller decides how to render that as HTTP or as an MCP tool result.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS, countGlTokens, MAX_GL_CHARS, MAX_GL_ALLELES } from "./engine.js";
import { batchDetail, spendIssuance, KEYS_PER_IP_PER_DAY } from "./quota.js";
import { TIER_LIMITS } from "./keys.js";

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

// `unmet` ({code, value?}) names the kind of request a refusal turned away, for
// the unmet-request counters (unmet.js rejectionUnmet). Only the two refusals
// that are a product signal carry one: a batch over the tier's cap, and a match
// framework this service does not offer. Malformed input is not a signal.
const bad = (status, detail, unmet = null) => (unmet ? { ok: false, status, detail, unmet } : { ok: false, status, detail });
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
  if (typings.length > limit) return bad(422, batchDetail(tier, limit, typings.length), { code: "batch_over_cap" });
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
    return bad(422, `framework must be one of ${Object.keys(FRAMEWORKS).sort().join(", ")}`,
      { code: "framework_unsupported", value: fw });
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
  `Verdicts are production-quality and pinned to IPD-IMGT/HLA ${release}. HLA-Verify is free during early access: ` +
  `get a free API key instantly (${TIER_LIMITS.free_key.calls.toLocaleString("en-US")} calls a day) at ${"https://hlaverify.com/research"}. We will email you when anything about early access changes.`;

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

// ------------------------------------------------- free keys and lab applications
// HLA-Verify is free for anyone (owner decision, 2026-11-01). POST
// /v1/research-access (alias /v1/keys) and the research_access MCP tool do two
// things, chosen by the body:
//
//  1. INSTANT FREE KEY (the default). Anyone who gives an email address gets a
//     key at once, in the response, at the free_key tier (keys.js TIER_LIMITS:
//     1,000 calls/day). The key is minted exactly as scripts/founding_lab.py and
//     stripe.js generateApiKey mint keys ("hlv_" + 32 random bytes, base64url),
//     written to KV AT the key as {label, tier, status, email, created, provider:
//     "self-serve"}, and shown ONCE: it is never stored anywhere else and never
//     shown again. The application record research/<email> gets status
//     "issued" and key_ref (the first 8 characters), which is how support finds
//     the key later: list KV keys with that prefix and match the email.
//
//  2. LAB APPLICATION ({"tier": "lab", institution, use_case}). The reviewed
//     path, for verified labs that need the Lab tier (10,000/day): a
//     research/<email> record with status "pending", which the tower-ops
//     lab-access job (jobs/lab_access.py) verifies and keys. That job selects
//     ONLY status "pending" records, so an "issued" record is never mistaken
//     for an application.
//
// ONE FREE KEY PER ADDRESS. A second request for an address that already has a
// key answers "already_issued" with the key_ref and the date, never the key,
// and points at hello@hlaverify.com for a lost key. There is deliberately no
// "re-issue and revoke the old one": nothing here proves the requester owns the
// mailbox, so self-serve re-issue would let anyone switch off someone else's
// key by typing their address. A person handles lost keys.
//
// ABUSE LIMITS. A basic disposable-address blocklist (below); at most
// KEYS_PER_IP_PER_DAY new keys per IP per UTC day (quota.js spendIssuance,
// salted daily digest, the IP is never stored); the anonymous 60/min limiter
// covers the route; keys are revocable (status "revoked" on the key record is
// refused by index.js authorizeKey).
//
// CONTAINMENT. authorize() (index.js) treats ANY KV value that parses as truthy
// JSON as a key, so a prefixed record must never be reachable from a key lookup.
// authorizeKey() refuses a presented key starting with any RESERVED_PREFIXES
// entry outright, and issued keys ("hlv_" + base64url) contain no "/". Both
// halves are tested in test/research.test.mjs. Do not drop either one.
export const RESEARCH_PREFIX = "research/";

// Every prefix under which the KEYS namespace holds something that is NOT an
// API key but does parse as truthy JSON. Adding a prefix to this list is what
// keeps it out of authorizeKey(); adding one without it is the bug that made
// a beta/ record presentable as a paid key.
// "founding/" holds the Founding Lab trial records scripts/founding_lab.py writes.
// (Support reports live in their own REPORTS namespace, not in KEYS.)
export const RESERVED_PREFIXES = [BETA_PREFIX, RESEARCH_PREFIX, "founding/"];

// use_case carries the reason the owner will approve or refuse on, so it gets
// more room than the beta list's; institution is a name, expected_volume a
// phrase like "about 20,000 typings a month".
export const MAX_INSTITUTION = 200, MAX_RESEARCH_USE_CASE = 1000, MAX_EXPECTED_VOLUME = 120;

export const FREE_KEY_TIER = "free_key";
export const KEY_PROVIDER = "self-serve";

// Throwaway-inbox services. Not exhaustive and not meant to be: it turns away
// the obvious key farming, and the per-IP cap does the rest. Privacy relays
// (duck.com, Firefox Relay, Hide My Email) forward to a real person and are
// allowed. Matched on the domain or any parent domain, plus a few tell-tale words.
export const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com",
  "sharklasers.com", "grr.la", "pokemail.net", "spam4.me", "10minutemail.com", "10minutemail.net",
  "temp-mail.org", "temp-mail.io", "tempmail.com", "tempmail.net", "tempmailo.com", "tempr.email",
  "yopmail.com", "yopmail.fr", "yopmail.net", "trashmail.com", "trashmail.de", "getnada.com", "nada.email",
  "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "mohmal.com",
  "emailondeck.com", "burnermail.io", "mailnesia.com", "spamgourmet.com", "mailpoof.com", "moakt.com",
  "tmail.ws", "tmpmail.org", "tmpmail.net", "inboxkitten.com", "getairmail.com", "mytemp.email",
  "discard.email", "mailcatch.com", "harakirimail.com", "1secmail.com", "1secmail.net", "1secmail.org",
  "emailfake.com", "fakemail.net", "dropmail.me", "linshiyouxiang.net", "mail.tm", "mail.gw",
  "mailsac.com", "tempinbox.com", "emailtemporanea.net", "minuteinbox.com", "trash-mail.com",
  "mvrht.com", "spambox.us", "wegwerfmail.de", "einrot.com", "mailexpire.com", "tempmailaddress.com",
]);
const DISPOSABLE_WORDS = ["tempmail", "temp-mail", "throwaway", "disposable", "mailinator", "10minute",
  "trashmail", "guerrilla", "fakemail", "fakeinbox", "burnermail", "yopmail", "spambox"];

export function isDisposable(email) {
  const domain = String(email).split("@").pop().toLowerCase();
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return DISPOSABLE_WORDS.some((w) => domain.includes(w));
}

// Same shape as stripe.js generateApiKey and scripts/founding_lab.py new_key:
// "hlv_" + 32 random bytes, base64url without padding.
export function newApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "hlv_" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Required free-text field. Returns [value, null] or [null, detail].
function requiredText(v, name, max) {
  if (typeof v !== "string") return [null, `${name} must be a string`];
  const s = v.trim();
  if (!s) return [null, `${name} must not be empty`];
  if (s.length > max) return [null, `${name} must be at most ${max} characters`];
  return [s, null];
}

const fmt = (x) => x.toLocaleString("en-US");
const labMore = () => `Verified labs that need more can have the Lab tier (${fmt(TIER_LIMITS.lab.calls)} calls a day, ` +
  `${fmt(TIER_LIMITS.lab.typings)} typings per call): email hello@hlaverify.com, or apply with ` +
  `{"tier": "lab", "institution": ..., "use_case": ...} on this endpoint.`;

export const KEY_USAGE = {
  header: "X-API-Key",
  curl: "curl -s https://api.hlaverify.com/v1/verify -H 'X-API-Key: YOUR_KEY' -H 'content-type: application/json' " +
    "-d '{\"text\": \"HLA-A*02:01, B*07:02\"}'",
  docs: "https://api.hlaverify.com/docs",
  mcp: "https://hlaverify.com/product#mcp",
  mcp_config: "{\"mcpServers\": {\"hla-verify\": {\"url\": \"https://api.hlaverify.com/mcp\", " +
    "\"headers\": {\"Authorization\": \"Bearer YOUR_KEY\"}}}}",
  usage: "POST https://api.hlaverify.com/v1/usage with the key shows what it has used",
};

const issuedMessage = () =>
  "Your free HLA-Verify API key is below. It is shown once and only here, so copy it now. " +
  `It allows ${fmt(TIER_LIMITS.free_key.calls)} calls a day (resets at 00:00 UTC), ` +
  `${fmt(TIER_LIMITS.free_key.typings)} typings per call and ${TIER_LIMITS.free_key.burst}. ` +
  "Send it in the X-API-Key header on every request. " + labMore() +
  " Lost keys: hello@hlaverify.com.";

const alreadyIssuedMessage = (rec) =>
  `A free key was already issued to this address${rec.issued ? ` on ${String(rec.issued).slice(0, 10)}` : ""}` +
  `${rec.key_ref ? ` (it starts ${rec.key_ref}…)` : ""}. Keys are shown only once, so it cannot be shown again. ` +
  "Lost your key? Email hello@hlaverify.com from this address and we will replace it.";

const labMessage = (already) =>
  `${already ? "Your Lab-tier application is already on file" : "Your Lab-tier application is recorded"}. ` +
  "Status: pending. We verify the institution and, if it is approved, email you a Lab-tier key " +
  `(${fmt(TIER_LIMITS.lab.calls)} calls a day, ${fmt(TIER_LIMITS.lab.typings)} typings per call). ` +
  "Applications from personal email addresses take longer, because they are reviewed by hand. " +
  `You do not need to wait to start: a free key (${fmt(TIER_LIMITS.free_key.calls)} calls a day) is issued instantly ` +
  "by this same endpoint without \"tier\". Questions: hello@hlaverify.com.";

async function readRecord(env, kvKey) {
  let raw;
  try { raw = await env.KEYS.get(kvKey); } catch (_) { return null; /* read failure: put() is the real test */ }
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
}

// body: {email, tier?, institution?, use_case?, expected_volume?, source?};
// country: cf-ipcountry or null; ip: cf-connecting-ip (counted, never stored).
export async function doResearchAccess(env, manifest, body, country, ip = null, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, "body must be a JSON object");
  if (typeof body.email !== "string") return bad(422, "email must be a string");
  const email = body.email.trim();
  if (email.length > MAX_EMAIL) return bad(422, `email must be at most ${MAX_EMAIL} characters`);
  if (!EMAIL_RE.test(email)) return bad(422, "email must look like an address, e.g. name@lab.example");

  const tier = body.tier === undefined || body.tier === null || body.tier === "" ? FREE_KEY_TIER : body.tier;
  if (tier !== FREE_KEY_TIER && tier !== "free" && tier !== "lab")
    return bad(422, "tier must be omitted (a free key, issued now) or \"lab\" (an application for the Lab tier)");
  const lab = tier === "lab";

  const field = lab ? requiredText : optional;
  const [institution, instErr] = field(body.institution, "institution", MAX_INSTITUTION);
  if (instErr) return bad(422, instErr);
  const [useCase, useCaseErr] = field(body.use_case, "use_case", MAX_RESEARCH_USE_CASE);
  if (useCaseErr) return bad(422, useCaseErr);
  const [volume, volumeErr] = optional(body.expected_volume, "expected_volume", MAX_EXPECTED_VOLUME);
  if (volumeErr) return bad(422, volumeErr);
  const [source, sourceErr] = optional(body.source, "source", MAX_SOURCE);
  if (sourceErr) return bad(422, sourceErr);

  if (isDisposable(email))
    return bad(422, "email: disposable or temporary inbox addresses are not accepted; use an address you will keep " +
      "(it is used for service notices only). Questions: hello@hlaverify.com");

  if (!env || !env.KEYS)
    return bad(503, "keys cannot be issued on this deployment; email hello@hlaverify.com");

  const kvKey = RESEARCH_PREFIX + email.toLowerCase();
  const rec = await readRecord(env, kvKey);
  const ts = new Date(now).toISOString();

  if (lab) {
    // The FIRST application wins and a decided record is never overwritten. An
    // address that only holds a free key becomes a pending application; its free
    // key's reference moves to free_key_ref so the job's approval (which writes
    // key_ref for the Lab key) cannot overwrite it.
    if (rec && rec.status !== "issued") {
      return good({ ok: true, status: "already_recorded", message: labMessage(true), release: manifest.release }, 1);
    }
    const carried = rec ? { free_key_ref: rec.key_ref || null, free_key_issued: rec.issued || null } : {};
    await env.KEYS.put(kvKey, JSON.stringify({
      email, institution, use_case: useCase, expected_volume: volume, source,
      ts, country: country || null, status: "pending", ...carried,
    }));
    return good({ ok: true, status: "recorded", message: labMessage(false), release: manifest.release }, 1);
  }

  // Free key. One per address; see ONE FREE KEY PER ADDRESS above.
  if (rec && (rec.status === "issued" || rec.free_key_ref || rec.status === "approved")) {
    const shown = rec.status === "issued" ? rec : { key_ref: rec.free_key_ref || null, issued: rec.free_key_issued || null };
    const message = rec.status === "approved" && !rec.free_key_ref
      ? "A Lab-tier key was already emailed to this address when its application was approved. Keys are shown only " +
        "once; lost it? Email hello@hlaverify.com from this address."
      : alreadyIssuedMessage(shown);
    return good({ ok: true, status: "already_issued", key_ref: shown.key_ref || null,
      issued: shown.issued || null, message, release: manifest.release }, 1);
  }
  if (rec && rec.status === "revoked") {
    return bad(403, "access for this address was withdrawn; email hello@hlaverify.com if you think that is a mistake");
  }

  const cap = await spendIssuance(env, ip, { now });
  if (!cap.ok) {
    return bad(429, `at most ${KEYS_PER_IP_PER_DAY} new keys a day from one connection; try again after ${cap.reset} ` +
      "or email hello@hlaverify.com");
  }

  const key = newApiKey();
  const keyRef = key.slice(0, 8);
  await env.KEYS.put(key, JSON.stringify({
    label: `${KEY_PROVIDER}:${keyRef}`, tier: FREE_KEY_TIER, status: "active", email, created: ts, provider: KEY_PROVIDER,
  }));
  if (rec) {
    // An application already in the lab-access queue (pending, needs_review)
    // keeps its status and its place there; the free key is noted beside it.
    await env.KEYS.put(kvKey, JSON.stringify({ ...rec, free_key_ref: keyRef, free_key_issued: ts }));
  } else {
    await env.KEYS.put(kvKey, JSON.stringify({
      email, institution, use_case: useCase, expected_volume: volume, source,
      ts, country: country || null, status: "issued", key_ref: keyRef, issued: ts, provider: KEY_PROVIDER,
    }));
  }
  const lim = TIER_LIMITS.free_key;
  return good({
    ok: true, status: "issued", key, key_ref: keyRef, tier: FREE_KEY_TIER,
    limits: { calls_per_day: lim.calls, typings_per_call: lim.typings, burst: lim.burst },
    usage: KEY_USAGE, message: issuedMessage(), release: manifest.release,
  }, 1);
}

// ------------------------------------------------------------ support reports
// "This answer looks wrong": the support portal's intake. Anyone can report a
// verdict, normalization or lookup they believe is incorrect, a docs page that
// disagrees with the API, or an outdated release, from hlaverify.com/support,
// from POST /v1/report or from the report_result MCP tool. Free, never billable.
//
// One record per report in the REPORTS namespace (its own binding, never KEYS:
// nothing a stranger writes shares a namespace with API keys), keyed by a random
// id the reporter gets back. It holds what they typed plus a timestamp,
// cf-ipcountry and the release that was live, never the IP or headers. Each IP
// may file REPORTS_PER_DAY reports a UTC day, counted under a salted digest of
// the day and the address (the quota's scheme), so the IP is not stored either.
//
// WHAT HAPPENS NEXT is outside the Worker. The private site repo's support
// intake reads new records, opens one private issue per report, and an agent
// reruns the input against the live API and the reference data. The issue's
// status label is written back here as `status`, `note` and `fixed_in`, which
// is all GET /v1/report/{id} shows: never the input, never the email.
//
// PATIENT DATA: an HLA typing on its own is not an identifier, but a report is
// free text. Obvious identifiers (record-number and DOB labels, SSNs, US-format
// dates) are refused before anything is stored, and the refusal says why. No
// filter can recognise a name, so the form and the docs say plainly not to
// include any, and promise only that obvious identifiers are refused.
export const REPORT_PREFIX = "report/";
export const REPORT_KINDS = ["wrong_result", "docs_mismatch", "outdated_release", "question", "other"];
export const REPORT_STATUSES = ["received", "investigating", "confirmed", "fixed", "expected_behavior",
  "duplicate", "needs_info"];
export const MAX_REPORT_ENDPOINT = 60, MAX_REPORT_INPUT = 2000, MAX_REPORT_RECEIVED = 4000,
  MAX_REPORT_EXPECTED = 1000, MAX_REPORT_DETAILS = 2000, MAX_REPORT_REQUEST_ID = 100;
export const REPORT_ID_RE = /^r[0-9a-f]{16}$/;
export const REPORTS_PER_DAY = 20;

const PATIENT_DATA = [
  [/\b\d{3}-\d{2}-\d{4}\b/, "something shaped like a Social Security number"],
  [/\b(?:MRN|DOB|medical record|date of birth|patient name|birth ?date)\b/i, "a patient identifier label (MRN, DOB, patient name)"],
  [/\b(?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01])[/.-](?:19|20)\d{2}\b/, "a date that could be a date of birth"],
];

// Every free-text field is checked, so the refusal names the field.
function patientData(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const [re, what] of PATIENT_DATA) {
      if (re.test(value)) return `${name} contains ${what}. Reports must not include patient identifiers: ` +
        `send only the HLA names or the request, and remove names, record numbers and dates.`;
    }
  }
  return null;
}

const reportMessage = (id) =>
  `Thanks — report ${id} is recorded. It will be rerun against the reference data, and a person ` +
  `confirms any error before it is published. Follow it at https://hlaverify.com/support?id=${id}. ` +
  `If you left an email address we will reply there.`;

// Reports a caller has filed today, under a digest of the salt, the UTC day and
// the address, so the address itself is never written. Expires after two days.
async function reportCounter(env, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const salt = env.QUOTA_IP_SALT || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|report|${day}|${ip || "unknown"}`));
  const key = "rl/" + day + "/" + [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  let n = 0;
  try { n = parseInt((await env.REPORTS.get(key)) || "0", 10) || 0; } catch (_) { n = 0; }
  return { key, n };
}

function newReportId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "r" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// body: {kind, input, expected, endpoint?, received?, details?, email?, request_id?, source?}
export async function doReport(env, manifest, body, country, ip = null) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, "body must be a JSON object");
  const kind = body.kind === undefined ? "wrong_result" : body.kind;
  if (!REPORT_KINDS.includes(kind)) return bad(422, `kind must be one of ${REPORT_KINDS.join(", ")}`);
  if (typeof body.input !== "string" || !body.input.trim()) return bad(422, "input must be a non-empty string: the HLA names or request you sent");
  const input = body.input.trim();
  if (input.length > MAX_REPORT_INPUT) return bad(422, `input must be at most ${MAX_REPORT_INPUT} characters`);
  if (typeof body.expected !== "string" || !body.expected.trim()) return bad(422, "expected must be a non-empty string: what you expected instead");
  const expected = body.expected.trim();
  if (expected.length > MAX_REPORT_EXPECTED) return bad(422, `expected must be at most ${MAX_REPORT_EXPECTED} characters`);

  const fields = { input, expected };
  for (const [name, max] of [["endpoint", MAX_REPORT_ENDPOINT], ["received", MAX_REPORT_RECEIVED],
    ["details", MAX_REPORT_DETAILS], ["request_id", MAX_REPORT_REQUEST_ID], ["source", MAX_SOURCE]]) {
    const [v, e] = optional(body[name], name, max);
    if (e) return bad(422, e);
    fields[name] = v;
  }
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    if (typeof body.email !== "string") return bad(422, "email must be a string");
    email = body.email.trim();
    if (email.length > MAX_EMAIL) return bad(422, `email must be at most ${MAX_EMAIL} characters`);
    if (!EMAIL_RE.test(email)) return bad(422, "email must look like an address, e.g. name@lab.example");
  }
  const phi = patientData({ input, expected, received: fields.received, details: fields.details });
  if (phi) return bad(422, phi);

  if (!env || !env.REPORTS) return bad(503, "reports are not available on this deployment — email hello@hlaverify.com");
  const rl = await reportCounter(env, ip);
  if (rl.n >= REPORTS_PER_DAY) {
    return bad(429, `at most ${REPORTS_PER_DAY} reports a day from one connection; email hello@hlaverify.com with the rest`);
  }
  const id = newReportId();
  const ts = new Date().toISOString();
  await env.REPORTS.put(rl.key, String(rl.n + 1), { expirationTtl: 172800 });
  await env.REPORTS.put(REPORT_PREFIX + id, JSON.stringify({
    id, kind, ...fields, email,
    release: manifest.release, ts, updated: ts, country: country || null,
    status: "received", note: null, fixed_in: null,
  }));
  return good({ ok: true, id, status: "received", status_url: `https://hlaverify.com/support?id=${id}`,
    message: reportMessage(id), release: manifest.release }, 1);
}

// GET /v1/report/{id}: the public half of a report. Only what the reporter
// needs to follow it; the input and the email address never leave the record.
export async function doReportStatus(env, id) {
  if (!REPORT_ID_RE.test(id || "")) return bad(404, "no report with that id");
  if (!env || !env.REPORTS) return bad(503, "reports are not available on this deployment");
  let rec = null;
  try { rec = JSON.parse((await env.REPORTS.get(REPORT_PREFIX + id)) || "null"); } catch (_) { rec = null; }
  if (!rec) return bad(404, "no report with that id");
  const status = REPORT_STATUSES.includes(rec.status) ? rec.status : "received";
  return good({ id, kind: rec.kind, status, created: rec.ts, updated: rec.updated || rec.ts,
    note: rec.note || null, fixed_in: rec.fixed_in || null, release_at_report: rec.release || null });
}
