// HLA-Verify edge engine — tokenize, convert legacy strings, look rows up.
// Every fact comes from shards precomputed by sci_envs/service/edge_export.py
// with the same Python engine that grades HLA-Bench; this file only mirrors the
// decision *order* of that engine (documented inline against the Python source).
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

export const ALLELE_RE = /^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,3})([NLSCAQ]?)$/;
export const LEGACY_RE = /^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{4,})([NLSCAQ]?)$/;
// Python \w is Unicode-aware; mirror it with \p{L}\p{N}_ under the u flag.
export const ALLELE_TOKEN_RE = /(?:HLA-)?[A-Z]+[0-9]*\*\d{2,}(?::\d{2,}){0,3}[NLSCAQGP]?(?![\p{L}\p{N}_:])/gu;
export const GROUP_RE = /^([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,2})([GP])$/;
const SHARD_RE = /^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{2})/;

export const STATUS_HELP = {
  valid: "assigned in this release (or a valid lower-resolution prefix)",
  group: "a G/P group name in this release",
  deleted: "was assigned once, no longer current — see successor",
  fabricated_group: "shaped like a G/P group but no such group exists",
  hallucinated: "no such name in any release back to 1.05.0 — fabricated",
};
const CLS = { v: "valid", g: "group", d: "deleted" };

export const FRAMEWORKS = {
  "6/6": [["A", "antigen"], ["B", "antigen"], ["DRB1", "allele"]],
  "8/8": [["A", "allele"], ["B", "allele"], ["C", "allele"], ["DRB1", "allele"]],
  "10/10": [["A", "allele"], ["B", "allele"], ["C", "allele"], ["DRB1", "allele"], ["DQB1", "allele"]],
  "12/12": [["A", "allele"], ["B", "allele"], ["C", "allele"], ["DRB1", "allele"], ["DQB1", "allele"], ["DPB1", "allele"]],
  antigen: [["A", "antigen"], ["B", "antigen"], ["C", "antigen"], ["DRB1", "antigen"], ["DQB1", "antigen"]],
};
const NULL = "∅", UNCERTAIN = "?";

export function shardOf(name) {
  const m = SHARD_RE.exec(name);
  return m ? `${m[1]}/${m[2]}` : null;
}
export function isLegacy(name) {
  const n = name.trim();
  return !n.includes(":") && LEGACY_RE.test(n);
}
export function legacyToColon(s) {
  const m = LEGACY_RE.exec(s.trim());
  if (!m) return null;
  const loc = m[1] === "Cw" ? "C" : m[1];
  const digits = m[2];
  if (digits.length % 2) return null;
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  return `${loc}*${parts.join(":")}${m[3]}`;
}
function suffixOf(name) {
  if (name == null || isLegacy(name)) return null;
  const m = ALLELE_RE.exec(name.trim());
  return m ? m[3] : null;
}
const sortedUnique = (arr) => Array.from(new Set(arr)).sort();
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function createEngine({ loadShard, manifest }) {
  const cache = new Map();
  async function lookup(name) {
    const sh = shardOf(name);
    if (!sh) return null;
    let rows = cache.get(sh);
    if (rows === undefined) {
      rows = (await loadShard(sh)) ?? {};
      cache.set(sh, rows);
    }
    return hasOwn(rows, name) ? rows[name] : null;
  }

  // normalize.resolve_name(): is_deleted -> legacy -> exists/prefix -> nonexistent.
  // A row's rn/rf were computed by resolve_name() on that exact key, so any hit is final.
  async function resolveName(reported) {
    const s = reported.trim();
    const row = await lookup(s);
    if (row) return [row.rn ?? null, row.rf ?? [], row];
    if (isLegacy(s)) {
      const cand = legacyToColon(s);
      const crow = cand ? await lookup(cand) : null;
      if (crow && crow.s === "v") return [cand, ["deprecated_name"], crow];
      return [null, ["deprecated_name", "nonexistent_allele"], null];
    }
    return [null, ["nonexistent_allele"], null];
  }

  // normalize.normalize(): {allele_2field, g_group, flags[]}
  async function normalizeOne(reported) {
    const s = reported.trim();
    const row = await lookup(s);
    if (row) return { allele_2field: row.n2, g_group: row.ng, flags: row.nf ?? [] };
    if (isLegacy(s)) {
      const cand = legacyToColon(s);
      const crow = cand ? await lookup(cand) : null;
      if (crow && crow.s === "v")
        return { allele_2field: crow.n2, g_group: crow.ng, flags: sortedUnique(["deprecated_name", ...(crow.nf ?? [])]) };
      return { allele_2field: "UNRESOLVABLE", g_group: "UNRESOLVABLE", flags: ["deprecated_name", "nonexistent_allele"] };
    }
    return { allele_2field: "UNRESOLVABLE", g_group: "UNRESOLVABLE", flags: ["nonexistent_allele"] };
  }

  // rules.antigen_of()
  async function antigenOf(reported) {
    const [, , row] = await resolveName(reported);
    return row ? row.ag : UNCERTAIN;
  }

  // ---------------------------------------------------------------- /v1/verify
  async function verify(text) {
    const toks = new Set(text.match(ALLELE_TOKEN_RE) ?? []);
    const seen = { valid: [], deleted: [], group: [], fabricated_group: [], hallucinated: [] };
    const rowsByTok = new Map();
    for (const tok of toks) {
      const t = tok.startsWith("HLA-") ? tok.slice(4) : tok;
      const row = await lookup(t);
      const status = row ? CLS[row.s] : (GROUP_RE.test(t) ? "fabricated_group" : "hallucinated");
      seen[status].push(t);
      rowsByTok.set(t, row);
    }
    for (const k in seen) seen[k].sort();
    const tokens = [];
    for (const status of Object.keys(seen)) {
      for (const t of seen[status]) {
        const out = { token: t, status, note: STATUS_HELP[status] };
        const row = rowsByTok.get(t);
        if (status === "deleted" && row?.succ) out.successor = row.succ;
        if ((status === "valid" || status === "deleted") && row.n2 !== "UNRESOLVABLE") {
          out.current_2field = row.n2;
          out.g_group = row.ng;
          if (row.nf?.length) out.flags = row.nf;
        }
        tokens.push(out);
      }
    }
    tokens.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    const counts = {};
    for (const k in seen) counts[k] = seen[k].length;
    return {
      release: manifest.release, tokens, counts,
      clean: counts.hallucinated === 0 && counts.fabricated_group === 0 && counts.deleted === 0,
      attribution: manifest.attribution,
    };
  }

  // ------------------------------------------------------------- /v1/normalize
  async function normalizeBatch(typings) {
    const rows = [];
    for (const s of typings) {
      const [name] = await resolveName(s);
      const n = await normalizeOne(s);
      rows.push({ reported: s, current_name: name ?? "UNRESOLVABLE", allele_2field: n.allele_2field,
        g_group: n.g_group, flags: n.flags });
    }
    return { release: manifest.release, rows, attribution: manifest.attribution };
  }

  // --------------------------------------------------------- /v1/allele/{name}
  async function allele(rawName) {
    const name = rawName.trim();
    const row = await lookup(name);
    const base = { release: manifest.release, name };
    if (row?.dl)
      return { status: 200, body: { ...base, status: "deleted", successor: row.succ ?? null, attribution: manifest.attribution } };
    if (row?.ex) {
      const out = { ...base, status: "assigned", attribution: manifest.attribution,
        g_group: row.g ?? null, p_group: row.p ?? null, first_release: row.fr ?? null, confirmed: !!row.c };
      if (row.se !== undefined) out.serology = row.se;
      if (suffixOf(name) === "N") out.null_allele = true;
      return { status: 200, body: out };
    }
    if (row?.s === "v")
      return { status: 200, body: { ...base, status: "valid_prefix", attribution: manifest.attribution,
        members_count: row.mc ?? 0, members_sample: row.ms ?? [] } };
    return { status: 404, body: { detail: `'${name}' is not assigned in release ${manifest.release}` } };
  }

  // ---------------------------------------------------------------- /v1/match
  async function pairTokens(pair, level) {
    const out = [];
    for (const reported of pair) {
      if (level === "allele") {
        const n = await normalizeOne(reported);
        if (n.allele_2field === "UNRESOLVABLE") return null;
        out.push(n.allele_2field);
      } else {
        const t = await antigenOf(reported);
        if (t === UNCERTAIN) return null;
        if (t === NULL) continue;
        out.push(t);
      }
    }
    return out;
  }
  async function locusVerdict(locus, level, recipient, donor) {
    const flags = [];
    for (const reported of [...recipient, ...donor]) {
      const [name] = await resolveName(reported);
      if (name && suffixOf(name) === "N") flags.push("null_allele");
    }
    const r = await pairTokens(recipient, level);
    const d = await pairTokens(donor, level);
    if (r === null || d === null)
      return { locus, level, verdict: "potential", mismatches: 0, hvg: 0, gvh: 0,
        flags: sortedUnique([...flags, "resolution_insufficient"]) };
    const rr = [...r].sort(), dd = [...d].sort();
    let matched = 0;
    const pool = [...dd];
    for (const t of rr) {
      const i = pool.indexOf(t);
      if (i >= 0) { pool.splice(i, 1); matched += 1; }
    }
    const slots = Math.max(rr.length, dd.length, 1);
    const mism = slots - matched;
    const hvg = dd.filter((t) => !rr.includes(t)).length;
    const gvh = rr.filter((t) => !dd.includes(t)).length;
    if (level === "antigen" && flags.includes("null_allele") && mism === 0) flags.push("null_allele_mismatch");
    return { locus, level, verdict: mism === 0 ? "match" : "mismatch", mismatches: mism, hvg, gvh,
      flags: sortedUnique(flags) };
  }
  async function match(framework, recipient, donor) {
    const verdicts = {};
    let total = 0, matched = 0;
    const flags = new Set();
    for (const [locus, level] of FRAMEWORKS[framework]) {
      if (!hasOwn(recipient, locus) || !hasOwn(donor, locus)) {
        verdicts[locus] = { locus, level, verdict: "potential", mismatches: 0, hvg: 0, gvh: 0, flags: ["resolution_insufficient"] };
        flags.add("resolution_insufficient");
        continue;
      }
      const lv = await locusVerdict(locus, level, recipient[locus], donor[locus]);
      verdicts[locus] = lv;
      for (const f of lv.flags) flags.add(f);
      if (lv.verdict === "potential") continue;
      total += 2;
      matched += 2 - lv.mismatches;
    }
    const live = Object.values(verdicts).filter((v) => v.verdict !== "potential");
    const out = { release: manifest.release, framework, count: total ? `${matched}/${total}` : "UNRESOLVABLE",
      verdicts: {}, hvg_mismatches: live.reduce((a, v) => a + v.hvg, 0),
      gvh_mismatches: live.reduce((a, v) => a + v.gvh, 0), flags: Array.from(flags).sort(),
      attribution: manifest.attribution };
    for (const [k, v] of Object.entries(verdicts)) out.verdicts[k] = v.verdict;
    return out;
  }

  return { lookup, resolveName, normalizeOne, antigenOf, verify, normalizeBatch, allele, match };
}
