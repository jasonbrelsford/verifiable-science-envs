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

// -------------------------------------------------------------- lab toolkit
export const MAX_GL_CHARS = 100_000, MAX_GL_ALLELES = 5_000;
const LOCUS_PREFIX_RE = /^(?:HLA-)?([A-Za-z]+[0-9]*)\*/;

export const PETERSDORF_RULE =
  "Petersdorf 2020 (Blood): for a single HLA-B mismatch, leader-matched when the " +
  "mismatched recipient and donor HLA-B alleles share the -21 M/T leader residue. " +
  "Decision support only; not a medical device.";
export const KIR_RULE =
  "Ligand-ligand model: a KIR ligand class (C1, C2, Bw4) present in one party and " +
  "absent in the other. Requires complete A, B and C typing. Decision support only; " +
  "not a medical device.";

const DRB1_FAMILY = {
  "15": "DRB5", "16": "DRB5",
  "03": "DRB3", "11": "DRB3", "12": "DRB3", "13": "DRB3", "14": "DRB3",
  "04": "DRB4", "07": "DRB4", "09": "DRB4",
  "01": "none", "08": "none", "10": "none",
};

function canonicalLocus(key) {
  let k = key.trim();
  if (k.startsWith("HLA-")) k = k.slice(4);
  return k === "Cw" ? "C" : k;
}
function regexLocus(s) {
  const m = LOCUS_PREFIX_RE.exec(s);
  if (!m) return null;
  return m[1] === "Cw" ? "C" : m[1];
}
function localeOf(name) {
  const m = ALLELE_RE.exec(name);
  return m ? m[1] : null;
}
function issue(severity, locus, code, detail) {
  return { severity, locus, code, detail };
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// count_gl_tokens(): every split allele slot, including empty ones from a
// doubled separator (the 5000-allele 422 and glstring unit metering).
export function countGlTokens(s) {
  let n = 0;
  for (const block of s.split("^"))
    for (const alt of block.split("|"))
      for (const geno of alt.split("+"))
        for (const hap of geno.split("~")) n += hap.split("/").length;
  return n;
}

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
      if (row.lg !== undefined) out.ligands = row.lg;
      return { status: 200, body: out };
    }
    if (row?.s === "v") {
      const out = { ...base, status: "valid_prefix", attribution: manifest.attribution,
        members_count: row.mc ?? 0, members_sample: row.ms ?? [] };
      if (row.lg !== undefined) out.ligands = row.lg;
      return { status: 200, body: out };
    }
    return { status: 404, body: { detail: `'${name}' is not assigned in release ${manifest.release}` } };
  }

  // --------------------------------------------------------- lab toolkit §2
  async function antigenFor(reported) {
    const raw = await antigenOf(reported);
    return raw === NULL ? "null" : raw === UNCERTAIN ? "uncertain" : raw;
  }

  // ----------------------------------------------- /v1/typing/check (§3)
  async function checkOneString(s) {
    const [name, flags] = await resolveName(s);
    const n = await normalizeOne(s);
    const status = name == null ? "unresolvable" : flags.includes("deprecated_name") ? "renamed" : "ok";
    const current_name = name ?? "UNRESOLVABLE";
    const row = {
      reported: s, status, current_name,
      allele_2field: n.allele_2field, g_group: n.g_group, flags: n.flags,
      antigen: await antigenFor(s),
    };
    if (name != null) {
      const nrow = await lookup(name);
      if (nrow && nrow.lg !== undefined) row.ligands = nrow.lg;
    }
    return row;
  }

  function rowsForCanon(typing, rowLookup, canonicalLookup, canon) {
    const rows = [];
    for (const key of Object.keys(typing)) if (canonicalLookup[key] === canon) rows.push(...rowLookup[key]);
    return rows;
  }
  function leaderSlot(row) {
    const ligs = row.ligands;
    if (!ligs) return "?";
    const v = ligs.leader_21;
    return v === "M" || v === "T" ? v : "?";
  }
  function cSlot(row) {
    const ligs = row.ligands;
    if (!ligs) return "?";
    const kl = ligs.kir_ligand;
    if (kl === "C1" || kl === "C2") return kl;
    if (ligs.expressed === false) return "none";
    return "?";
  }
  function buildProfile(typing, rowLookup, canonicalLookup) {
    const keys = Object.keys(typing);
    const has = {};
    for (const c of ["A", "B", "C"]) has[c] = keys.some((k) => canonicalLookup[k] === c);
    const rowsByCanon = {};
    for (const c of ["A", "B", "C"]) rowsByCanon[c] = rowsForCanon(typing, rowLookup, canonicalLookup, c);

    let bLeaderGenotype = null;
    if (has.B) {
      const slots = rowsByCanon.B.slice(0, 2).map(leaderSlot);
      while (slots.length < 2) slots.push("?");
      const order = { M: 0, T: 1, "?": 2 };
      slots.sort((a, b) => order[a] - order[b]);
      bLeaderGenotype = slots.join("/");
    }
    let cKirGenotype = null;
    if (has.C) {
      const slots = rowsByCanon.C.slice(0, 2).map(cSlot);
      while (slots.length < 2) slots.push("?");
      const order = { C1: 0, C2: 1, none: 2, "?": 3 };
      slots.sort((a, b) => order[a] - order[b]);
      cKirGenotype = slots.join("/");
    }
    const kirSet = new Set(["C1", "C2", "Bw4", "Bw4-80I", "Bw4-80T"]);
    const present = new Set();
    for (const c of ["A", "B", "C"])
      for (const r of rowsByCanon[c]) {
        const ligs = r.ligands;
        if (ligs && kirSet.has(ligs.kir_ligand)) present.add(ligs.kir_ligand);
      }
    const kirLigandsPresent = Array.from(present).sort();

    let complete = has.A && has.B && has.C;
    outer: if (complete) {
      for (const c of ["A", "B", "C"]) {
        const rs = rowsByCanon[c];
        if (rs.length !== 2) { complete = false; break outer; }
        for (const r of rs) {
          const ligs = r.ligands;
          if (!ligs || ligs.kir_ligand === "unknown" || ligs.kir_ligand === "ambiguous") { complete = false; break outer; }
        }
      }
    }
    return {
      b_leader_genotype: bLeaderGenotype,
      c_kir_ligand_genotype: cKirGenotype,
      kir_ligands_present: kirLigandsPresent,
      kir_ligand_status: complete ? "complete" : "incomplete",
    };
  }

  function drb1Family(row) {
    if (row.current_name === "UNRESOLVABLE") return "unknown";
    const m = ALLELE_RE.exec(row.current_name);
    if (!m) return "unknown";
    const firstField = m[2].split(":")[0];
    return DRB1_FAMILY[firstField] ?? "unknown";
  }
  function buildDrb345(typing, rowLookup, canonicalLookup, issues) {
    const keys = Object.keys(typing);
    if (!keys.some((k) => canonicalLookup[k] === "DRB1")) return null;
    const drb1Rows = rowsForCanon(typing, rowLookup, canonicalLookup, "DRB1");
    const families = drb1Rows.map(drb1Family);
    const expectedSet = new Set(families.filter((f) => f === "DRB3" || f === "DRB4" || f === "DRB5"));
    const expected = Array.from(expectedSet).sort();
    const determinate = drb1Rows.length === 2 && families.every((f) => f !== "unknown");

    const reportedSet = new Set();
    for (const L of ["DRB3", "DRB4", "DRB5"]) {
      const rs = rowsForCanon(typing, rowLookup, canonicalLookup, L);
      if (rs.some((r) => r.status !== "unresolvable")) reportedSet.add(L);
    }
    const reported = Array.from(reportedSet).sort();

    const allLoci = Array.from(new Set([...expected, ...reportedSet])).sort();
    for (const L of allLoci) {
      if (determinate && reportedSet.has(L) && !expectedSet.has(L))
        issues.push(issue("warning", L, "drb345_unexpected", `${L} reported but neither DRB1 allele is normally carried with ${L}`));
      if (expectedSet.has(L) && !reportedSet.has(L)) {
        const names = drb1Rows.filter((r, i) => families[i] === L).map((r) => r.current_name).join(", ");
        issues.push(issue("info", L, "drb345_not_reported", `${L} is normally carried with ${names} but was not reported`));
      }
    }
    return { expected, reported, determinate };
  }

  async function check(typing) {
    const release = manifest.release;
    const lociOut = {};
    const rowLookup = {};
    const canonicalLookup = {};
    const issues = [];

    for (const key of Object.keys(typing)) {
      const canon = canonicalLocus(key);
      canonicalLookup[key] = canon;
      const rows = [];
      for (const s of typing[key]) {
        const row = await checkOneString(s);
        rows.push(row);

        const name = row.current_name === "UNRESOLVABLE" ? null : row.current_name;
        const stringLocus = name != null ? localeOf(name) : regexLocus(s.trim());

        if (row.status === "unresolvable")
          issues.push(issue("error", key, "unresolvable", `'${s}' is not a name in release ${release}`));
        if (row.status === "renamed")
          issues.push(issue("warning", key, "deprecated_name", `'${s}' is an outdated name; current name is ${row.current_name}`));
        if (stringLocus != null && stringLocus !== canon)
          issues.push(issue("error", key, "locus_mismatch", `${s} is a ${stringLocus} allele listed under ${key}`));
        if (row.flags.includes("null_allele"))
          issues.push(issue("warning", key, "null_allele", `${row.current_name} is a null allele (not expressed)`));
      }
      lociOut[key] = rows;
      rowLookup[key] = rows;

      if (rows.length > 2)
        issues.push(issue("warning", key, "too_many_alleles", `${rows.length} alleles listed; a genotype has at most 2 per locus`));
      if (rows.length === 1)
        issues.push(issue("info", key, "single_allele", "one allele listed: homozygous or incomplete typing"));
      if (rows.length === 2 && rows[0].allele_2field === rows[1].allele_2field && rows[0].allele_2field !== "UNRESOLVABLE")
        issues.push(issue("info", key, "homozygous", `both alleles are ${rows[0].allele_2field}`));
    }

    const profile = buildProfile(typing, rowLookup, canonicalLookup);
    const drb345 = buildDrb345(typing, rowLookup, canonicalLookup, issues);

    const counts = { error: 0, warning: 0, info: 0 };
    for (const iss of issues) counts[iss.severity]++;
    const valid = counts.error === 0;

    const response = { release, valid, loci: lociOut, issues, counts, profile, drb345, attribution: manifest.attribution };
    return [response, rowLookup, canonicalLookup];
  }

  async function checkTyping(typing) {
    return (await check(typing))[0];
  }

  // -------------------------------------------------------------- /v1/compat (§4)
  function multisetMatch(recRows, donRows) {
    const donPool = donRows.map((r) => r.allele_2field);
    const donUnmatched = [...donRows];
    const recUnmatched = [];
    let matched = 0;
    for (const r of recRows) {
      const v = r.allele_2field;
      const idx = donPool.indexOf(v);
      if (idx >= 0) { donPool.splice(idx, 1); donUnmatched.splice(idx, 1); matched += 1; }
      else recUnmatched.push(r);
    }
    return { matched, recUnmatched, donUnmatched };
  }
  function buildBLeader(recResp, donResp, recRowsB, donRowsB) {
    let bMismatches = null, leaderMatch = null;
    if (recRowsB.length >= 1 && recRowsB.length <= 2 && donRowsB.length >= 1 && donRowsB.length <= 2 &&
        recRowsB.every((r) => r.allele_2field !== "UNRESOLVABLE") && donRowsB.every((r) => r.allele_2field !== "UNRESOLVABLE")) {
      const { matched, recUnmatched, donUnmatched } = multisetMatch(recRowsB, donRowsB);
      const slots = Math.max(recRowsB.length, donRowsB.length);
      bMismatches = slots - matched;
      if (bMismatches === 1 && recRowsB.length === 2 && donRowsB.length === 2 && recUnmatched.length === 1 && donUnmatched.length === 1) {
        const rLeader = recUnmatched[0].ligands?.leader_21;
        const dLeader = donUnmatched[0].ligands?.leader_21;
        if ((rLeader === "M" || rLeader === "T") && (dLeader === "M" || dLeader === "T")) leaderMatch = rLeader === dLeader;
      }
    }
    return {
      recipient: recResp.profile.b_leader_genotype,
      donor: donResp.profile.b_leader_genotype,
      b_mismatches: bMismatches,
      leader_match: leaderMatch,
      rule: PETERSDORF_RULE,
    };
  }
  function kirClass(v) {
    return v.startsWith("Bw4") ? "Bw4" : v;
  }
  function buildKirLigands(recResp, donResp) {
    const recClasses = sortedUnique(recResp.profile.kir_ligands_present.map(kirClass));
    const donClasses = sortedUnique(donResp.profile.kir_ligands_present.map(kirClass));
    const missingInRecipient = sortedUnique(donClasses.filter((c) => !recClasses.includes(c)));
    const missingInDonor = sortedUnique(recClasses.filter((c) => !donClasses.includes(c)));
    const status = recResp.profile.kir_ligand_status === "complete" && donResp.profile.kir_ligand_status === "complete" ? "complete" : "incomplete";
    return { recipient: recClasses, donor: donClasses, missing_in_recipient: missingInRecipient, missing_in_donor: missingInDonor, status, rule: KIR_RULE };
  }
  async function compat(recipient, donor) {
    const [recResp, recRows, recCanon] = await check(recipient);
    const [donResp, donRows, donCanon] = await check(donor);
    const recRowsB = rowsForCanon(recipient, recRows, recCanon, "B");
    const donRowsB = rowsForCanon(donor, donRows, donCanon, "B");
    return {
      release: manifest.release,
      b_leader: buildBLeader(recResp, donResp, recRowsB, donRowsB),
      kir_ligands: buildKirLigands(recResp, donResp),
      recipient_valid: recResp.valid,
      donor_valid: donResp.valid,
      issues: { recipient: recResp.issues, donor: donResp.issues },
      attribution: manifest.attribution,
    };
  }

  // ------------------------------------------------------------- /v1/glstring (§5)
  async function isGroupName(base) {
    const row = await lookup(base);
    return row?.s === "g";
  }
  async function processToken(release, rawTok, issues, allelesByText, orderList) {
    const t = rawTok.trim();
    const base = t.startsWith("HLA-") ? t.slice(4) : t;
    let status, currentName, locus;

    if ([...t].some((c) => /\s/.test(c))) {
      status = "unresolvable";
      currentName = null;
      locus = regexLocus(base);
      issues.push({ severity: "error", code: "whitespace_in_name", detail: `'${t}' contains whitespace` });
    } else if (await isGroupName(base)) {
      status = "group";
      currentName = base;
      locus = base.split("*")[0];
    } else {
      const [name, flags] = await resolveName(base);
      if (name == null) { status = "unresolvable"; currentName = null; locus = regexLocus(base); }
      else if (flags.includes("deprecated_name")) { status = "renamed"; currentName = name; locus = localeOf(name); }
      else { status = "valid"; currentName = name; locus = localeOf(name); }
    }

    if (status === "unresolvable")
      issues.push({ severity: "error", code: "unresolvable_allele", detail: `'${t}' is not a name in release ${release}` });
    else if (status === "renamed")
      issues.push({ severity: "warning", code: "renamed_allele", detail: `'${t}' is outdated; current name is ${currentName}` });

    const norm = status === "renamed" ? (t.startsWith("HLA-") ? "HLA-" : "") + currentName : t;

    const entry = { token: t, status, current_name: currentName, locus };
    if (!hasOwn(allelesByText, t)) { allelesByText[t] = entry; orderList.push(t); }
    return { t, locus, norm };
  }
  async function parseList(release, rawText, issues, allelesByText, orderList) {
    const pieces = rawText.split("/");
    const normPieces = [];
    const loci = new Set();
    for (const piece of pieces) {
      const t = piece.trim();
      if (t === "") {
        issues.push({ severity: "error", code: "empty_element", detail: `empty element in '${rawText}'` });
        normPieces.push("");
        continue;
      }
      const tok = await processToken(release, piece, issues, allelesByText, orderList);
      normPieces.push(tok.norm);
      if (tok.locus != null) loci.add(tok.locus);
    }
    const normText = normPieces.join("/");
    if (loci.size > 1)
      issues.push({ severity: "error", code: "mixed_locus_allele_list", detail: `'${rawText}' mixes loci ${Array.from(loci).sort().join(", ")}` });
    return { norm: normText, loci };
  }
  async function parseHaplotype(release, rawText, issues, allelesByText, orderList) {
    const pieces = rawText.split("~");
    const lists = [];
    for (const p of pieces) lists.push(await parseList(release, p, issues, allelesByText, orderList));
    const normText = lists.map((l) => l.norm).join("~");
    const counts = {};
    for (const l of lists) for (const lo of l.loci) counts[lo] = (counts[lo] || 0) + 1;
    const loci = new Set(Object.keys(counts));
    const repeated = Object.keys(counts).filter((lo) => counts[lo] > 1).sort();
    if (repeated.length)
      issues.push({ severity: "error", code: "haplotype_repeats_locus", detail: `'${rawText}' repeats locus ${repeated[0]}` });
    return { norm: normText, loci };
  }
  async function parseGenotype(release, rawText, issues, allelesByText, orderList) {
    const pieces = rawText.split("+");
    const haps = [];
    for (const p of pieces) haps.push(await parseHaplotype(release, p, issues, allelesByText, orderList));
    const normText = haps.map((h) => h.norm).join("+");
    const loci = new Set();
    for (const h of haps) for (const lo of h.loci) loci.add(lo);
    if (haps.length > 2)
      issues.push({ severity: "warning", code: "more_than_two_haplotypes", detail: `'${rawText}' has ${haps.length} haplotypes` });
    const hapLociSets = haps.map((h) => h.loci);
    if (hapLociSets.length > 1 && hapLociSets.slice(1).some((s) => !setsEqual(s, hapLociSets[0])))
      issues.push({ severity: "error", code: "genotype_loci_differ", detail: `'${rawText}' pairs different loci` });
    return { norm: normText, loci };
  }
  async function parseBlock(release, rawText, issues, allelesByText, orderList) {
    const pieces = rawText.split("|");
    const genos = [];
    for (const p of pieces) genos.push(await parseGenotype(release, p, issues, allelesByText, orderList));
    const normText = genos.map((g) => g.norm).join("|");
    const loci = new Set();
    for (const g of genos) for (const lo of g.loci) loci.add(lo);
    const genoLociSets = genos.map((g) => g.loci);
    if (genoLociSets.length > 1 && genoLociSets.slice(1).some((s) => !setsEqual(s, genoLociSets[0])))
      issues.push({ severity: "warning", code: "genotype_list_loci_differ", detail: `'${rawText}' lists genotypes over different loci` });
    return { norm: normText, loci };
  }
  async function glString(gl) {
    const s = gl.trim();
    const release = manifest.release;
    const issues = [];
    const allelesByText = {};
    const orderList = [];

    const blocksRaw = s.split("^");
    const blocks = [];
    for (const p of blocksRaw) blocks.push(await parseBlock(release, p, issues, allelesByText, orderList));
    const normText = blocks.map((b) => b.norm).join("^");

    const blockCounts = {};
    for (const b of blocks) for (const lo of b.loci) blockCounts[lo] = (blockCounts[lo] || 0) + 1;
    for (const lo of Object.keys(blockCounts).filter((lo) => blockCounts[lo] > 1).sort())
      issues.push({ severity: "warning", code: "locus_repeated_across_blocks", detail: `locus ${lo} appears in more than one ^ block` });

    const counts = { error: 0, warning: 0 };
    for (const iss of issues) counts[iss.severity]++;
    const valid = counts.error === 0;

    const lociOut = sortedUnique(Object.values(allelesByText).map((e) => e.locus).filter((l) => l != null));
    const allelesOut = orderList.map((t) => allelesByText[t]);

    return {
      release, valid, normalized_gl: normText, changed: normText !== s,
      loci: lociOut, alleles: allelesOut, issues, counts, attribution: manifest.attribution,
    };
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

  return { lookup, resolveName, normalizeOne, antigenOf, verify, normalizeBatch, allele, match,
    checkTyping, compat, glString };
}
