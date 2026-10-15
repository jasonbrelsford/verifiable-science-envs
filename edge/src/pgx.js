// Pharmacogenomics lookup: published CPIC and PharmGKB HLA–drug associations,
// keyed by two-field allele, served over the same normalizer as /v1/normalize.
//
// The table is hla-pgx-open (CC BY-SA 4.0), vendored at deploy time by
// sci_envs/service/pgx_export.py into edge/public/pgx.json — a separate bundle
// beside the IPD-IMGT/HLA tables, never inside them, so the verification
// engine's own data promise is untouched. Every response carries the snapshot
// (date + git commit) the answer came from, the way every verdict carries the
// IPD-IMGT/HLA release.
//
// The product is the normalize step: PharmCAT-style lookups need clean
// two-field names, and callers send every era and shorthand (A*3101, B*5701,
// HLA-B*15:02:01G). Each name is resolved first — with the flags the rest of
// the API raises, so nothing is converted silently — and only then joined.
// Decision support only; not a medical device (SCOPE below, verbatim on
// every response and both MCP tool descriptions).
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { validateTyping, MAX_PER_LOCUS, MAX_LOCI } from "./handlers.js";

export const SCOPE =
  "Guideline lookup over published CPIC and PharmGKB associations, keyed by two-field HLA allele. " +
  "Decision support only; not a medical device. After an allogeneic transplant the recipient's blood " +
  "carries the donor's genome, and which genome should drive an HLA-mediated drug alert is an open question " +
  "(NCT06856226); this lookup reports both and decides nothing.";

// The most names one screen may send as a flat list: a full typing is at most
// MAX_LOCI loci × MAX_PER_LOCUS alleles, and that is the ceiling here too.
export const MAX_PGX_ALLELES = MAX_LOCI * MAX_PER_LOCUS;

// The columns a caller gets back per association — the clinically read ones,
// not the bookkeeping (source_version, hlaverify_* check columns).
const ASSOCIATION_FIELDS = ["source", "source_record_id", "gene", "allele", "allele_status", "source_allele_label",
  "drug", "drug_id", "evidence_level", "clinpgx_level", "pgx_testing", "phenotype_category", "implication",
  "recommendation", "classification", "population", "score", "guideline_name", "guideline_url", "annotation_url",
  "citations_pmid"];
const CSV_FIELDS = [...ASSOCIATION_FIELDS, "hlaverify_current_name", "hlaverify_2field", "hlaverify_flags",
  "ipd_release", "source_version"];

const stripPrefix = (s) => (typeof s === "string" && s.startsWith("HLA-") ? s.slice(4) : s);
const pick = (row) => Object.fromEntries(ASSOCIATION_FIELDS.map((k) => [k, row[k] ?? ""]));

// An association is "actionable" when it is a CPIC level-A recommendation for
// carrying the allele: the rows a prescriber acts on, as opposed to PharmGKB
// annotations (associations, not prescriptions) and negative-status rows (what
// to do when the allele is absent).
export const isActionable = (a) => a.source === "cpic" && a.evidence_level === "CPIC A" && a.allele_status === "positive";

// Loads edge/public/pgx.json once per isolate and indexes it two ways. Returns
// null when the bundle is missing: the routes then answer 503, and nothing
// else in the Worker is affected. Only a loaded table is cached, and get()'s
// arguments reach the loader on every attempt, so a missing bundle is retried
// with the environment of the request that asks, never one captured earlier.
export function createPgx(loadBundle) {
  let loaded = null;
  async function get(...args) {
    if (loaded) return loaded;
    const b = await loadBundle(...args);
    if (!b || !Array.isArray(b.rows)) return null;
    const byAllele = new Map();      // "B*57:01" -> rows (two-field, no HLA- prefix)
    const byGeneDrug = new Map();    // "HLA-B|abacavir" -> rows
    for (const row of b.rows) {
      const key = stripPrefix(row.hlaverify_2field || row.allele || "");
      if (key) {
        if (!byAllele.has(key)) byAllele.set(key, []);
        byAllele.get(key).push(row);
      }
      const gd = `${row.gene}|${String(row.drug || "").toLowerCase()}`;
      if (!byGeneDrug.has(gd)) byGeneDrug.set(gd, []);
      byGeneDrug.get(gd).push(row);
    }
    loaded = {
      snapshot: { date: b.snapshot?.date ?? null, commit: b.snapshot?.commit ?? null },
      license: b.license || "CC-BY-SA-4.0",
      attribution: b.attribution || "",
      sources: b.sources || {},
      rows: b.rows,
      byAllele, byGeneDrug,
    };
    return loaded;
  }
  return { get };
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function tableCsv(pgx) {
  const lines = [CSV_FIELDS.join(",")];
  for (const row of pgx.rows) lines.push(CSV_FIELDS.map((k) => csvCell(row[k])).join(","));
  return lines.join("\n") + "\n";
}

const envelope = (manifest, pgx) => ({
  release: manifest.release,
  pgx_snapshot: pgx.snapshot,
  scope: SCOPE,
  license: pgx.license,
  attribution: pgx.attribution,
});

// GET /v1/pgx/table — the whole table, JSON (default) or CSV. Not billable,
// no key: open data is the adoption hook.
export function doPgxTable(manifest, pgx, format = "json") {
  if (format === "csv") return { ok: true, csv: tableCsv(pgx), units: 0 };
  return { ok: true, body: { ...envelope(manifest, pgx), row_count: pgx.rows.length, columns: CSV_FIELDS,
    rows: pgx.rows.map((r) => ({ ...pick(r), hlaverify_current_name: r.hlaverify_current_name ?? "",
      hlaverify_2field: r.hlaverify_2field ?? "", hlaverify_flags: r.hlaverify_flags ?? "" })) }, units: 0 };
}

const bad = (status, detail) => ({ ok: false, status, detail });

// Accepts {"typing": {locus: [names]}} (the shape every other typing route
// takes) or {"alleles": [names]}; returns the flat, de-duplicated name list or
// a refusal. Exactly one of the two must be present.
export function pgxInputNames(body, side = "body") {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, `${side} must be a JSON object`);
  const hasTyping = body.typing !== undefined, hasAlleles = body.alleles !== undefined;
  if (hasTyping === hasAlleles) return bad(422, `${side}: send exactly one of "typing" (locus -> [names]) or "alleles" ([names])`);
  let names;
  if (hasTyping) {
    const e = validateTyping(body.typing, `${side}.typing`);
    if (e) return bad(422, e);
    names = Object.values(body.typing).flat();
  } else {
    if (!Array.isArray(body.alleles) || !body.alleles.every((s) => typeof s === "string" && s.length > 0 && s.length <= 64))
      return bad(422, `${side}.alleles must be a list of non-empty allele strings (at most 64 characters each)`);
    if (body.alleles.length > MAX_PGX_ALLELES) return bad(422, `${side}.alleles: at most ${MAX_PGX_ALLELES} names per call`);
    names = body.alleles;
  }
  if (!names.length) return bad(422, `${side}: no allele names given`);
  return { ok: true, names: [...new Set(names)] };
}

// Normalize every name, then join each on its two-field form.
async function screenNames(eng, pgx, names) {
  const { rows } = await eng.normalizeBatch(names);
  const out = rows.map((r) => {
    const key = r.allele_2field === "UNRESOLVABLE" ? null : stripPrefix(r.allele_2field);
    const associations = key ? (pgx.byAllele.get(key) || []).map(pick) : [];
    return { reported: r.reported, current_name: r.current_name, allele_2field: r.allele_2field, flags: r.flags,
      associations };
  });
  return out;
}

const actionableOf = (screened) => {
  const seen = new Set(), list = [];
  for (const s of screened) for (const a of s.associations) {
    if (!isActionable(a)) continue;
    const k = `${a.allele}|${a.drug}|${a.source_record_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ reported: s.reported, ...a });
  }
  return list;
};

// POST /v1/pgx/screen
export async function doPgxScreen(eng, manifest, pgx, body) {
  const inp = pgxInputNames(body);
  if (!inp.ok) return inp;
  const alleles = await screenNames(eng, pgx, inp.names);
  const actionable = actionableOf(alleles);
  return { ok: true, units: inp.names.length, body: {
    ...envelope(manifest, pgx),
    alleles,
    summary: {
      names: inp.names.length,
      unresolvable: alleles.filter((a) => a.allele_2field === "UNRESOLVABLE").length,
      with_associations: alleles.filter((a) => a.associations.length).length,
      actionable,
      drugs_actionable: [...new Set(actionable.map((a) => a.drug))].sort(),
    },
  } };
}

// POST /v1/pgx/pair — screen both sides, then say for every actionable
// association which genome carries it. Decides nothing (SCOPE).
export async function doPgxPair(eng, manifest, pgx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(422, "body must be a JSON object");
  const rec = pgxInputNames(body.recipient, "recipient");
  if (!rec.ok) return rec;
  const don = pgxInputNames(body.donor, "donor");
  if (!don.ok) return don;
  const recipient = await screenNames(eng, pgx, rec.names);
  const donor = await screenNames(eng, pgx, don.names);
  const recAct = actionableOf(recipient), donAct = actionableOf(donor);
  const key = (a) => `${a.allele}|${a.drug}|${a.source_record_id}`;
  const recKeys = new Set(recAct.map(key)), donKeys = new Set(donAct.map(key));
  const merged = new Map();
  for (const a of [...recAct, ...donAct]) if (!merged.has(key(a))) merged.set(key(a), a);
  const actionable = [...merged.values()].map((a) => {
    const inR = recKeys.has(key(a)), inD = donKeys.has(key(a));
    const { reported, ...rest } = a;
    return { ...rest, in_recipient: inR, in_donor: inD, discordant: inR !== inD,
      whose_hla: inR && inD ? "both" : inR ? "recipient_only" : inD ? "donor_only" : "neither" };
  });
  return { ok: true, units: rec.names.length + don.names.length, body: {
    ...envelope(manifest, pgx),
    recipient: { alleles: recipient, unresolvable: recipient.filter((a) => a.allele_2field === "UNRESOLVABLE").length },
    donor: { alleles: donor, unresolvable: donor.filter((a) => a.allele_2field === "UNRESOLVABLE").length },
    actionable,
    summary: {
      actionable: actionable.length,
      discordant: actionable.filter((a) => a.discordant).length,
      drugs: [...new Set(actionable.map((a) => a.drug))].sort(),
    },
  } };
}
