// Unmet-request classification: what callers send that the service cannot (yet)
// fully serve, counted by SHAPE so the operator can see which gaps real callers
// hit and rank them by who is hitting them. Written alongside every metering
// point (index.js meter()) and read back by the operator dashboard (usage.js).
//
// WHAT IS RECORDED. Per request: one small integer per class below (how many
// tokens or conditions of that class the request contained), a caller bucket,
// and at most one short categorical value. Never the request content: no allele
// strings, no typing, no report text, no GL string. A value is recorded only
// when it comes from a closed or gene-symbol-shaped set — a locus prefix cut
// from an allele-shaped token, a framework spec, an MCP tool name, the kind of
// cleanup that would have made a token resolve — and is sanitised to a short
// lowercase/uppercase alphanumeric before it is written. The privacy promise
// "usage metering records counts, never content" (index.js, the website's
// privacy page) is unchanged by this module and was the design constraint.
//
// CALLER BUCKET. A keyed caller is its label (already in blob1). An anonymous
// caller is, BY DEFAULT, the constant "a:anon": every anonymous request counts as
// one caller, so the metering row stays exactly what the published privacy page
// says it is (label, endpoint, release, status, keyed/anon, tier, units, ms —
// plus these counts). With UNMET_ANON_BUCKETS=1 (wrangler.jsonc) an anonymous
// caller becomes a per-UTC-day SHA-256 digest of the day, the QUOTA_IP_SALT
// secret and the client address, truncated to 16 hex characters: the same
// construction, and the same privacy argument, as the anonymous daily-quota
// counter in quota.js (the salt keeps the digest from being a lookup table over
// IPv4, and the day in the hash means yesterday's bucket can never be joined to
// today's). That makes "how many different anonymous callers hit this gap" a
// number instead of a guess, at the cost of one sentence on the privacy page,
// which is why it is a switch the owner flips rather than the default. Even
// then, distinct anonymous "callers" are really caller-DAYS, an anonymous caller
// can never be a repeat caller across days, and without a usable salt the bucket
// falls back to the constant; the raw address is never written anywhere.
//
// WHY CLASSES AND NOT A LOG. A log of failed inputs would answer the same
// question and would also be a store of request content, which this service
// promises not to keep. Thirteen fixed classes, chosen so that each one maps to
// exactly one product decision (load the MAC table; accept serology; add a
// framework; ...), answer "what would be valuable to build" without keeping what
// anyone sent.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS, MAC_RE, XX_RE, canonicalLocus, stripPrefix } from "./engine.js";
import { utcDay } from "./quota.js";

// Analytics Engine columns: doubles are 1-based; double1 = units, double2 = ms,
// and class i (0-based below) is written at double(DOUBLE_OFFSET + i). Blobs:
// blob7 = caller bucket, blob8 = "class=value". usage.js reads these back.
export const DOUBLE_OFFSET = 3;
export const BUCKET_BLOB = 7;
export const VALUE_BLOB = 8;

// kind: "feature" is a capability the service lacks; "pricing" is a limit the
// caller hit (a plan signal, not a product gap). feasibility: a static 0-1 weight
// for how buildable the fix is under this project's constraints (no licensed
// data, deterministic, pinned release), used by scoreUnmet(). It is the one
// subjective input to the ranking and is deliberately in a table the owner can
// edit, not inferred from traffic.
export const UNMET_CLASSES = [
  { id: "mac_code", kind: "feature", feasibility: 0.4,
    title: "NMDP multiple allele codes",
    seen: "A*02:AB-style MAC codes, recognised but not expanded",
    would_take: "loading the NMDP MAC table (a licensing and dependency decision)" },
  { id: "format_variant", kind: "feature", feasibility: 1.0,
    title: "Formatting variants that would resolve after cleanup",
    seen: "lower-case names, internal spaces, Cw*07:01, a space instead of *",
    would_take: "lenient parsing with a flag, same as the HLA- prefix today" },
  { id: "allele_list", kind: "feature", feasibility: 1.0,
    title: "Ambiguity strings in a typing slot",
    seen: "A*02:01/A*02:05 or A*02:01/05 sent as one allele",
    would_take: "accepting slash-lists in typing inputs, as GL strings already do" },
  { id: "serology", kind: "feature", feasibility: 0.9,
    title: "Serologic antigens as input",
    seen: "A2, B44, DR4, Cw6, Bw4 or bare 2-digit antigens in an allele slot",
    would_take: "serology-level input via rel_dna_ser / rel_ser_ser (already shipped for output)" },
  { id: "low_resolution", kind: "feature", feasibility: 0.5,
    title: "Low-resolution typing at an allele-level locus",
    seen: "A*02 or A*02:XX where the framework needs 2-field resolution (verdict: potential)",
    would_take: "a documented low-resolution matching rule, or imputation (frequency data)" },
  { id: "extra_loci", kind: "feature", feasibility: 0.8,
    title: "Loci sent but not scored by the framework",
    seen: "DQA1, DPA1, DRB3/4/5 or DPB1 typings the chosen framework ignores",
    would_take: "extended frameworks (DQA1/DPA1, DPB1 TCE permissiveness)" },
  { id: "framework_unsupported", kind: "feature", feasibility: 0.8,
    title: "Match frameworks this service does not offer",
    seen: "a framework value other than 6/6, 8/8, 10/10, 12/12 or antigen",
    would_take: "adding the framework's published counting rule" },
  { id: "unknown_locus", kind: "feature", feasibility: 0.3,
    title: "Genes outside IPD-IMGT/HLA",
    seen: "KIR, or any allele-shaped name whose locus is not in the release",
    would_take: "a second reference database (IPD-KIR), the same build pipeline" },
  { id: "unknown_allele", kind: "feature", feasibility: 0.6,
    title: "Allele-shaped names not in this release",
    seen: "a known locus, a well-formed name, no such allele: newer than the pin, or a typo",
    would_take: "tracking releases faster, and/or nearest-name suggestions" },
  { id: "unresolvable_other", kind: "feature", feasibility: 0.2,
    title: "Unresolvable, none of the above",
    seen: "strings in an allele slot that fit no recognised shape",
    would_take: "unknown: look at by_endpoint and ask callers" },
  { id: "mcp_unknown_tool", kind: "feature", feasibility: 0.5,
    title: "MCP tools agents expect that do not exist",
    seen: "tools/call for a tool name not in the catalogue",
    would_take: "a new tool, if the name describes something deterministic" },
  { id: "batch_over_cap", kind: "pricing", feasibility: 1.0,
    title: "Batches over the tier's per-call cap",
    seen: "/v1/normalize batches larger than the caller's tier allows (422)",
    would_take: "a plan or cap change, not a feature" },
  { id: "quota_exceeded", kind: "pricing", feasibility: 1.0,
    title: "Daily quota exhausted",
    seen: "requests refused with 429 after the tier's daily calls ran out",
    would_take: "a plan or quota change, not a feature" },
];
export const CLASS_INDEX = Object.fromEntries(UNMET_CLASSES.map((c, i) => [c.id, i]));
export const classColumn = (i) => `double${DOUBLE_OFFSET + i}`;

// Analytics Engine allows 20 doubles per data point; two are taken already.
if (UNMET_CLASSES.length + DOUBLE_OFFSET - 1 > 20) throw new Error("too many unmet classes for Analytics Engine doubles");

export const emptyCounts = () => UNMET_CLASSES.map(() => 0);
export const EMPTY = Object.freeze({ counts: Object.freeze(emptyCounts()), value: "" });

// Which class's value wins blob8 when several fire in one request: the most
// specific product question first.
const VALUE_PRIORITY = ["mcp_unknown_tool", "framework_unsupported", "unknown_locus", "extra_loci", "format_variant"];

// -------------------------------------------------------------- value hygiene
// Every value written to blob8 passes through one of these. They allow only a
// short alphanumeric token and replace anything else with "other", so blob8 can
// hold a gene symbol, a framework spec or a tool name and nothing else.
export const sanitizeLocus = (v) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return s || "other";
};
export const sanitizeFramework = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9/_.-]{0,15}$/.test(s) ? s : "other";
};
export const sanitizeTool = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,40}$/.test(s) ? s : "other";
};

// ------------------------------------------------------------- shape tests
// KIR gene names, with or without the KIR prefix, with or without an allele part.
// The second alternative has no leading digit because the free-text tokenizer
// (engine.js ALLELE_TOKEN_RE) cannot start a token inside "KIR2DL1*001" and hands
// back "DL1*001"; with an allele part that shape is still a KIR name and nothing
// else (without one, "DP1" is the serologic antigen and must stay that).
const KIR_RE = /^(?:HLA-)?(?:(?:KIR)?[23]D[LSP]\d[A-Z]?(?:\*\d+)?|D[LSP]\d[A-Z]?\*\d+)$/i;
// Serologic antigen names: A2, B44, Cw6, DR4, DQ2, DP1, Bw4, DR53, and the 3-4
// digit splits (A203, B2708). A leading zero is allele digits with the '*'
// dropped (A0201), which is a formatting variant, not serology. No '*'.
const SEROLOGY_RE = /^(?:HLA-)?(A|B|Cw?|DRw?|DQw?|DPw?|Bw)(\d{1,2}|[1-9]\d{2,3})$/i;
const SEROLOGY_DIGITS_RE = /^(\d{1,2}|[1-9]\d{2,3})$/;
// Keys under which a bare antigen number is read as a serologic antigen.
const SEROLOGY_KEYS = new Set(["A", "B", "C", "DR", "DQ", "DP", "DRB1", "DQB1", "DPB1"]);
// Allele digits without a locus ("02:01", "0201", "02:01:01:01N"), as spreadsheets list them.
const FIELDS_ONLY_RE = /^\d{2,}(?::\d{2,}){0,3}[NLSCAQnlscaq]?$/;
// A legacy name with the '*' dropped: A0201, DRB10401, B4402N.
const STAR_DROPPED_RE = /^(?:HLA-)?([A-Za-z]+[0-9]?)(\d{4,})([NLSCAQnlscaq]?)$/;
// An allele-shaped token with its locus prefix captured.
const LOCUS_OF_RE = /^(?:HLA-)?([A-Za-z]+[0-9]*)\s*\*/;
// Slash-list pieces: allele-shaped, or fields-only once the locus is known.
const LIST_ALLELE_RE = /^(?:HLA-)?[A-Za-z]+[0-9]*\*\d{2,}(?::\d{2,}){0,3}[A-Za-z]?$/;

export function isKirShaped(s) { return KIR_RE.test(String(s).trim()); }
export function isSerologyShaped(s, locusKey = null) {
  const t = String(s).trim();
  if (SEROLOGY_RE.test(t)) return true;
  return SEROLOGY_DIGITS_RE.test(t) && locusKey != null && SEROLOGY_KEYS.has(canonicalLocus(locusKey));
}
export function isAlleleList(s, locusKey = null) {
  const pieces = String(s).trim().split("/").map((p) => p.trim());
  if (pieces.length < 2) return false;
  const piece = (p) => LIST_ALLELE_RE.test(p) || (locusKey != null && FIELDS_ONLY_RE.test(p));
  if (!piece(pieces[0])) return false;
  return pieces.slice(1).every((p) => LIST_ALLELE_RE.test(p) || FIELDS_ONLY_RE.test(p));
}

// The cleanups a lenient parser would apply, each named: case, space (internal
// whitespace), cw (Cw*07:01), star (the '*' dropped or replaced by a space),
// locus (fields only, under a typing key that names the locus). Returns the
// candidate strings to try (most conservative first) and the sorted fix names,
// or null when nothing would change. A trailing lower-case g is the lg notation
// and is kept as written in the first candidate; the second candidate upper-cases
// it too, which is how an all-lower-case G group name (a*02:01:01g) comes back.
export function cleanupCandidates(s, locusKey = null) {
  const fixes = new Set();
  let t = String(s).trim();
  if (/^hla-/i.test(t) && !t.startsWith("HLA-")) { t = t.slice(4); fixes.add("case"); }
  else if (t.startsWith("HLA-")) t = t.slice(4);
  if (/\s/.test(t)) {
    // "DRB1 04:01": whitespace standing in for the '*'
    if (!t.includes("*") && /^[A-Za-z]+[0-9]*\s+\d/.test(t)) { t = t.replace(/^([A-Za-z]+[0-9]*)\s+/, "$1*"); fixes.add("star"); }
    if (/\s/.test(t)) { t = t.replace(/\s+/g, ""); fixes.add("space"); }
  }
  if (!t.includes("*")) {
    const m = STAR_DROPPED_RE.exec(t);
    if (m) { t = `${m[1]}*${m[2]}${m[3]}`; fixes.add("star"); }
    else if (locusKey != null && FIELDS_ONLY_RE.test(t)) { t = `${canonicalLocus(locusKey)}*${t}`; fixes.add("locus"); }
  }
  if (/^cw\*/i.test(t)) { t = "C" + t.slice(2); fixes.add("cw"); }
  const lg = t.endsWith("g");
  const body = lg ? t.slice(0, -1) : t;
  const upper = body.toUpperCase();
  if (upper !== body) fixes.add("case");
  if (!fixes.size) return null;
  const first = upper + (lg ? "g" : "");
  const candidates = lg ? [first, upper + "G"] : [first];
  return { candidates, fixes: Array.from(fixes).sort() };
}

// ------------------------------------------------------------ the accumulator
class Acc {
  constructor() { this.counts = emptyCounts(); this.values = {}; this.budget = 200; }
  add(id, value = null) {
    this.counts[CLASS_INDEX[id]] += 1;
    if (value != null && !(id in this.values)) this.values[id] = value;
  }
  result() {
    let value = "";
    for (const id of VALUE_PRIORITY) {
      if (id in this.values) { value = `${id}=${this.values[id]}`; break; }
    }
    return { counts: this.counts, value };
  }
}

// A string that sat in an allele slot and did not resolve. `locusKey` is the
// typing key it was listed under (typing-shaped inputs only). `flags` are the
// engine's flags for it when the caller already has them.
async function classifyUnresolved(eng, manifest, acc, s, { locusKey = null, flags = null, tryCleanup = true } = {}) {
  if (acc.budget-- <= 0) return;                       // bound the re-work on a huge bad batch
  const t = String(s).trim();
  if ((flags && flags.includes("mac_code")) || (MAC_RE.test(stripPrefix(t)) && !XX_RE.test(stripPrefix(t)))) return acc.add("mac_code");
  if (isKirShaped(t)) return acc.add("unknown_locus", "KIR");
  if (isSerologyShaped(t, locusKey)) return acc.add("serology");
  if (isAlleleList(t, locusKey)) return acc.add("allele_list");
  if (tryCleanup) {
    const c = cleanupCandidates(t, locusKey);
    if (c) {
      for (const cand of c.candidates) {
        const n = await eng.normalizeOne(cand);
        if (n.allele_2field !== "UNRESOLVABLE") return acc.add("format_variant", c.fixes.join("+"));
      }
    }
  }
  const m = LOCUS_OF_RE.exec(t);
  if (m) {
    const locus = canonicalLocus(m[1]);
    const known = Array.isArray(manifest.loci) ? manifest.loci : null;
    if (known && !known.includes(locus)) return acc.add("unknown_locus", sanitizeLocus(locus));
    return acc.add("unknown_allele");
  }
  return acc.add("unresolvable_other");
}

// A typing key (locus). Returns true when the key itself is the story — a gene
// outside the release — so the caller skips its tokens rather than counting the
// same gap once per allele. With `scored` (a framework's locus -> level map), a
// known HLA locus the framework does not score is `extra_loci`. A typing key is
// caller-typed text, so the only value ever recorded from one is "KIR", "other",
// or a locus that is in the release's own list.
function classifyLocusKey(manifest, acc, key, { scored = null } = {}) {
  const canon = canonicalLocus(key);
  const known = Array.isArray(manifest.loci) ? manifest.loci : null;
  if (isKirShaped(canon) || /^KIR/i.test(canon)) { acc.add("unknown_locus", "KIR"); return true; }
  if (known && !known.includes(canon)) { acc.add("unknown_locus", "other"); return true; }
  if (scored && !scored.has(canon)) acc.add("extra_loci", known ? sanitizeLocus(canon) : "other");
  return false;
}

// ------------------------------------------------------- per-endpoint summaries
// Each reads the engine's own result where it can (flags, statuses) and goes back
// to the input only for the strings that did not resolve.
async function fromTypingRows(eng, manifest, acc, rows) {
  for (const key of Object.keys(rows || {})) {
    if (classifyLocusKey(manifest, acc, key)) continue;
    for (const row of rows[key]) {
      if (row.flags && row.flags.includes("mac_code")) { acc.add("mac_code"); continue; }
      if (row.status === "unresolvable") await classifyUnresolved(eng, manifest, acc, row.reported, { locusKey: key, flags: row.flags });
    }
  }
}

async function fromTyping(eng, manifest, acc, typing) {
  if (!typing || typeof typing !== "object") return;
  for (const key of Object.keys(typing)) {
    if (classifyLocusKey(manifest, acc, key)) continue;
    for (const s of typing[key]) {
      const n = await eng.normalizeOne(s);
      if (n.flags.includes("mac_code")) acc.add("mac_code");
      else if (n.allele_2field === "UNRESOLVABLE") await classifyUnresolved(eng, manifest, acc, s, { locusKey: key, flags: n.flags });
    }
  }
}

async function fromMatch(eng, manifest, acc, input) {
  const fw = input.framework ?? "8/8";
  const scored = new Map(FRAMEWORKS[fw] || []);
  for (const side of [input.recipient, input.donor]) {
    if (!side || typeof side !== "object") continue;
    for (const key of Object.keys(side)) {
      const canon = canonicalLocus(key);
      if (classifyLocusKey(manifest, acc, key, { scored })) continue;
      const level = scored.get(canon);
      if (!level) continue;                                // not scored: counted above, nothing to resolve
      for (const s of side[key]) {
        const n = await eng.normalizeOne(s);
        if (n.flags.includes("mac_code")) { acc.add("mac_code"); continue; }
        if (n.allele_2field === "UNRESOLVABLE") { await classifyUnresolved(eng, manifest, acc, s, { locusKey: key, flags: n.flags }); continue; }
        if (level === "allele" && !n.allele_2field.split("*", 2)[1].includes(":")) {
          // rules.two_field(): a first-field name is only comparable when it is itself
          // an assigned allele (MICA*008); otherwise the locus verdict was `potential`.
          const row = await eng.lookup(n.allele_2field);
          if (!row || !row.ex) acc.add("low_resolution");
        }
      }
    }
  }
}

// summarizeUnmet(engine, manifest, endpoint, input, result) -> {counts, value}
// endpoint is the metering label without any "mcp:" prefix (verify, normalize,
// allele, match, typing/check, compat, glstring). Never throws: a classifier
// failure yields an empty summary, never a failed verdict.
export async function summarizeUnmet(eng, manifest, endpoint, input, result) {
  const acc = new Acc();
  try {
    switch (endpoint) {
      case "verify":
        for (const t of (result && result.tokens) || []) {
          if (t.status === "mac_code") acc.add("mac_code");
          else if (t.status === "hallucinated" || t.status === "fabricated_group")
            await classifyUnresolved(eng, manifest, acc, t.token, { tryCleanup: false });
        }
        break;
      case "normalize":
        for (const row of (result && result.rows) || []) {
          if (row.flags && row.flags.includes("mac_code")) acc.add("mac_code");
          else if (row.current_name === "UNRESOLVABLE") await classifyUnresolved(eng, manifest, acc, row.reported, { flags: row.flags });
        }
        break;
      case "allele":
        if (result && result.detail && input && typeof input.name === "string")
          await classifyUnresolved(eng, manifest, acc, input.name);
        break;
      case "match":
        await fromMatch(eng, manifest, acc, input || {});
        break;
      case "typing/check":
        await fromTypingRows(eng, manifest, acc, result && result.loci);
        break;
      case "compat":
        // compat returns issues, not rows: re-resolve each side's strings (cached shard reads)
        await fromTyping(eng, manifest, acc, input && input.recipient);
        await fromTyping(eng, manifest, acc, input && input.donor);
        break;
      case "glstring":
        for (const a of (result && result.alleles) || []) {
          if (a.status !== "unresolvable") continue;
          const [, flags] = await eng.resolveName(a.token);
          await classifyUnresolved(eng, manifest, acc, a.token, { flags });
        }
        break;
      default:
        break;
    }
  } catch (_) {
    return { counts: emptyCounts(), value: "" };
  }
  return acc.result();
}

// A request the handler refused (handlers.js bad(status, detail, unmet)) or a
// quota refusal: one class, optional value, no engine work.
export function rejectionUnmet(code, value = null) {
  const acc = new Acc();
  if (code === "framework_unsupported") acc.add(code, sanitizeFramework(value));
  else if (code === "mcp_unknown_tool") acc.add(code, sanitizeTool(value));
  else if (code in CLASS_INDEX) acc.add(code);
  return acc.result();
}

// -------------------------------------------------------------- caller bucket
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// See the file comment. Keyed: "k:" + label. Anonymous: the constant "a:anon"
// unless UNMET_ANON_BUCKETS=1, then "a:" + 16 hex of a per-day salted digest, or
// the constant again when QUOTA_IP_SALT is unusable. The raw address goes no
// further than this function.
export const ANON_BUCKET = "a:anon";
export async function callerBucket(who, req, env, now = Date.now()) {
  if (!who) return "";
  if (who.keyed) return `k:${who.label}`;
  if (!env || env.UNMET_ANON_BUCKETS !== "1") return ANON_BUCKET;
  const salt = env.QUOTA_IP_SALT;
  if (typeof salt !== "string" || salt.length < 16) return ANON_BUCKET;
  const ip = (req && req.headers.get("cf-connecting-ip")) || "unknown";
  try {
    return `a:${(await sha256Hex(`hlv-unmet-ip:${utcDay(now)}:${salt}:${ip}`)).slice(0, 16)}`;
  } catch (_) {
    return ANON_BUCKET;
  }
}

// ------------------------------------------------------------------ scoring
// Tiers whose callers pay (keys.js TIER_LIMITS): academic is keyed but free.
export const PAID_TIERS = new Set(["starter", "lab", "pro", "scale", "enterprise"]);

// The value estimate, in product terms. Each factor is one question:
//   demand      log2(1 + requests)      how often — with diminishing returns, so one
//                                       script in a loop cannot outvote ten labs
//   breadth     1 + callers             how many distinct callers hit it
//   money       1 + 2 * paid_callers    a paying caller hitting a wall counts three times
//   persistence 1 + repeat_callers      keyed callers who hit it on more than one day
//                                       have not routed around it
//   feasibility the class's static weight (UNMET_CLASSES)
// The product is a ranking aid, not a forecast: compare classes against each
// other, read the components, then decide.
export function scoreUnmet(stats, cls) {
  const requests = Number(stats.requests) || 0;
  if (!requests) return 0;
  const demand = Math.log2(1 + requests);
  const breadth = 1 + (Number(stats.callers) || 0);
  const money = 1 + 2 * (Number(stats.paid_callers) || 0);
  const persistence = 1 + (Number(stats.repeat_callers) || 0);
  return Math.round(demand * breadth * money * persistence * cls.feasibility * 10) / 10;
}

// A one-word reading of the numbers, for the dashboard. The thresholds are
// deliberately simple and stated here rather than tuned.
export function verdictUnmet(stats, cls) {
  if (!stats.requests) return "none";
  if (cls.kind === "pricing") return "pricing";
  if (stats.paid_callers >= 1 || stats.callers >= 3) return cls.feasibility >= 0.5 ? "build" : "investigate";
  return "watch";
}

// aggregateUnmet(callerDayRows, endpointRows, valueRows) -> report.
// callerDayRows: one row per (caller, keyed, tier, day) with c<i> = requests in
//   which class i fired (usage.js buildAdminUnmetCallersSQL). Bounded by LIMIT,
//   so caller counts are exact up to that bound and request totals come from
//   endpointRows instead.
// endpointRows: one row per endpoint with c<i> (requests) and o<i> (occurrences)
//   per class (buildAdminUnmetEndpointsSQL).
// valueRows: {value: "class=value", requests, callers} (buildAdminUnmetValuesSQL).
export function aggregateUnmet(callerDayRows, endpointRows, valueRows, { anonBuckets = false } = {}) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const per = UNMET_CLASSES.map(() => ({
    callers: new Set(), keyed: new Set(), paid: new Set(), days: new Map(),
  }));
  for (const row of callerDayRows || []) {
    const caller = row.caller;
    if (!caller) continue;
    for (let i = 0; i < UNMET_CLASSES.length; i++) {
      if (!(n(row[`c${i}`]) > 0)) continue;
      const p = per[i];
      p.callers.add(caller);
      if (row.keyed === "keyed") p.keyed.add(caller);
      if (PAID_TIERS.has(row.tier)) p.paid.add(caller);
      if (!p.days.has(caller)) p.days.set(caller, new Set());
      p.days.get(caller).add(String(row.caller_day).slice(0, 10));
    }
  }
  const classes = UNMET_CLASSES.map((cls, i) => {
    let requests = 0, occurrences = 0;
    const by_endpoint = {};
    for (const row of endpointRows || []) {
      const r = Math.round(n(row[`c${i}`]));
      if (!r) continue;
      requests += r;
      occurrences += Math.round(n(row[`o${i}`]));
      const ep = row.unmet_endpoint || row.endpoint || "unknown";
      by_endpoint[ep] = (by_endpoint[ep] || 0) + r;
    }
    const p = per[i];
    let repeat = 0;
    for (const days of p.days.values()) if (days.size >= 2) repeat++;
    const prefix = `${cls.id}=`;
    const values = (valueRows || []).filter((v) => typeof v.value === "string" && v.value.startsWith(prefix))
      .map((v) => ({ value: v.value.slice(prefix.length), requests: Math.round(n(v.requests)), callers: Math.round(n(v.callers)) }))
      .sort((a, b) => b.requests - a.requests);
    const stats = { requests, occurrences, callers: p.callers.size, keyed_callers: p.keyed.size,
      paid_callers: p.paid.size, repeat_callers: repeat };
    return {
      id: cls.id, kind: cls.kind, title: cls.title, seen: cls.seen, would_take: cls.would_take,
      feasibility: cls.feasibility, ...stats, by_endpoint, values,
      score: scoreUnmet(stats, cls), verdict: verdictUnmet(stats, cls),
    };
  });
  classes.sort((a, b) => b.score - a.score || b.requests - a.requests);
  const anonNote = anonBuckets
    ? "Anonymous callers are counted per UTC day (an address seen on three days is three callers) and can never be repeat callers; "
    : "All anonymous traffic counts as ONE caller (UNMET_ANON_BUCKETS is off), so callers here are keyed callers plus one; ";
  return {
    window: "30d",
    anon_buckets: anonBuckets,
    note: "Counts of request shapes the service could not fully serve; never request content. " + anonNote +
      "keyed callers are counted once. score = log2(1+requests) x (1+callers) x (1+2*paid_callers) x " +
      "(1+repeat_callers) x feasibility; a ranking aid, not a forecast.",
    classes,
  };
}
