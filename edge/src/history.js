// IPD-IMGT/HLA release history: every allele name in every release since 1.05.0,
// from the files sci_envs/service/history_export.py writes beside the release
// tables (public/history/). Four questions, all answered from the official
// Allelelist_history.txt and Deleted_alleles.txt with no inference of our own:
//
//   releases   which releases the history covers
//   translate  what is this name, as reported in release X, called in release Y?
//   diff       which names were added, removed or renamed between X and Y?
//   history    when did this name appear, change and disappear, and what was
//              the allele behind it called in each release?
//
// Names are matched exactly as they were written in the release (A*0101 in 1.x,
// A*01:01:01:01 today), with an optional HLA- prefix. One HLA ID is one allele;
// a deletion retires a NAME, and the ID may live on under another one.
const NAME_RE = /^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{2})/;
export const MAX_DIFF_LIMIT = 5000;
const DEFAULT_DIFF_LIMIT = 500;

const bad = (status, detail) => ({ ok: false, status, detail });
const good = (body, units = 1) => ({ ok: true, body, units });

export function createHistory(load) {
  // load(path) -> parsed JSON or null; results are cached for the isolate's life.
  const cache = new Map();
  const get = (path) => {
    if (!cache.has(path)) cache.set(path, Promise.resolve(load(path)).catch(() => null));
    return cache.get(path);
  };

  async function meta() {
    const m = await get("history/releases.json");
    if (!m || !Array.isArray(m.releases)) return null;
    if (!m.index) m.index = new Map(m.releases.map((r, i) => [r, i]));
    return m;
  }
  const clean = (name) => name.trim().replace(/^HLA-/, "");

  async function idsFor(name) {
    const m = NAME_RE.exec(name);
    if (!m) return [];
    const shard = await get(`history/names/${m[1]}/${m[2]}.json`);
    return (shard && shard[name]) || [];
  }
  async function record(locus, id) {
    const file = await get(`history/ids/${locus}.json`);
    return file ? file[id] || null : null;
  }
  const nameAt = (rec, i) => {
    for (const [a, b, nm] of rec.t) if (a <= i && i <= b) return nm;
    return null;
  };
  const span = (rec) => [rec.t[0][0], rec.t[rec.t.length - 1][1]];
  const timeline = (rec, rels) => rec.t.map(([a, b, nm]) => ({ name: nm, from: rels[a], to: rels[b] }));

  function release(m, value, label) {
    if (value === undefined || value === null || value === "") return [null, null];
    if (typeof value !== "string" || !m.index.has(value.trim()))
      return [null, `${label} must be a release this history covers, like "3.40.0" (see GET /v1/releases); got ${JSON.stringify(value)}`];
    return [m.index.get(value.trim()), null];
  }

  // What `name` (as it was written in release `fromI`, or ever if fromI is null) is called at `toI`.
  async function translateOne(m, raw, fromI, toI) {
    const name = clean(raw);
    const row = { name: raw, status: "unknown", to_name: null, hla_id: null };
    const hits = await idsFor(name);
    if (!hits.length) {
      row.note = `${name} is not an allele name in any release from ${m.releases[0]} to ${m.latest}. ` +
        "Legacy shorthand and lower-resolution names (B*1501, A*02:XX) are resolved by POST /v1/normalize";
      return row;
    }
    const cands = [];
    for (const [id, locus] of hits) {
      const rec = await record(locus, id);
      if (!rec) continue;
      if (fromI !== null && nameAt(rec, fromI) !== name) continue;
      cands.push({ id, rec });
    }
    if (!cands.length) {
      const where = [];
      for (const [id, locus] of hits) {
        const rec = await record(locus, id);
        if (rec) for (const [a, b, nm] of rec.t) if (nm === name) where.push(`${m.releases[a]}–${m.releases[b]}`);
      }
      row.status = "not_in_from_release";
      row.note = `${name} is not a name in ${m.releases[fromI]}; it was used in ${where.join(", ")}`;
      return row;
    }
    const outcomes = [];
    for (const { id, rec } of cands) {
      const to = nameAt(rec, toI);
      const [first, last] = span(rec);
      const o = { hla_id: id, to_name: to };
      if (to === name) o.status = "unchanged";
      else if (to) o.status = "renamed";
      else if (toI < first) { o.status = "not_yet_named"; o.note = `the allele was first named in ${m.releases[first]}`; }
      else {
        o.status = "deleted";
        const lastName = rec.t[rec.t.length - 1][2];
        const del = (rec.d && (rec.d[name] || rec.d[lastName])) || null;
        o.note = del ? del.reason : `no name for this allele after ${m.releases[last]}`;
        if (del && del.successor) {
          const succ = await translateOne(m, del.successor, null, toI);
          o.successor = del.successor;
          o.successor_to_name = succ.to_name;
        }
      }
      outcomes.push(o);
    }
    const same = outcomes.every((o) => o.status === outcomes[0].status && o.to_name === outcomes[0].to_name);
    if (outcomes.length === 1 || same) return { ...row, ...outcomes[0] };
    return { ...row, status: "ambiguous", candidates: outcomes,
      note: `${name} was used for ${outcomes.length} different alleles; each is listed` };
  }

  return {
    async releases() {
      const m = await meta();
      if (!m) return bad(503, "release history is not available on this deployment");
      return good({ releases: m.releases, latest: m.latest, count: m.releases.length, loci: m.loci || [] }, 0);
    },

    async translate(names, from, to, { cap = 250, tier = "free" } = {}) {
      const m = await meta();
      if (!m) return bad(503, "release history is not available on this deployment");
      if (!Array.isArray(names) || !names.length || !names.every((s) => typeof s === "string" && s.trim()))
        return bad(422, "names must be a non-empty list of allele names");
      if (names.length > cap)
        return bad(422, `at most ${cap} names per call on the ${tier} tier; got ${names.length}. Split the batch or see https://api.hlaverify.com/pricing`);
      const [fromI, e1] = release(m, from, "from"); if (e1) return bad(422, e1);
      const [toGiven, e2] = release(m, to, "to"); if (e2) return bad(422, e2);
      const toI = toGiven ?? m.releases.length - 1;
      const rows = [];
      for (const n of names) rows.push(await translateOne(m, n, fromI, toI));
      const counts = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return good({ from: fromI === null ? null : m.releases[fromI], to: m.releases[toI], counts, rows }, names.length);
    },

    async diff(from, to, { locus = null, limit = DEFAULT_DIFF_LIMIT } = {}) {
      const m = await meta();
      if (!m) return bad(503, "release history is not available on this deployment");
      if (!from || !to) return bad(422, "from and to are both required, like ?from=3.58.0&to=3.66.0");
      const [fi, e1] = release(m, from, "from"); if (e1) return bad(422, e1);
      const [ti, e2] = release(m, to, "to"); if (e2) return bad(422, e2);
      const n = limit === undefined || limit === null || limit === "" ? DEFAULT_DIFF_LIMIT : Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DIFF_LIMIT) return bad(422, `limit must be 1 to ${MAX_DIFF_LIMIT}`);
      const loci = locus ? [locus] : (m.loci || []);
      if (locus && !(m.loci || []).includes(locus)) return bad(422, `locus must be one of ${(m.loci || []).join(", ")}`);
      const added = [], removed = [], renamed = [];
      for (const l of loci) {
        const file = await get(`history/ids/${l}.json`);
        if (!file) continue;
        for (const [id, rec] of Object.entries(file)) {
          const a = nameAt(rec, fi), b = nameAt(rec, ti);
          if (a === b) continue;
          if (!a) added.push({ hla_id: id, name: b });
          else if (!b) {
            const del = rec.d && rec.d[a];
            removed.push({ hla_id: id, name: a, ...(del ? { reason: del.reason, successor: del.successor } : {}) });
          } else renamed.push({ hla_id: id, from_name: a, to_name: b });
        }
      }
      const byName = (k) => (x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0);
      added.sort(byName("name")); removed.sort(byName("name")); renamed.sort(byName("from_name"));
      const cut = (list) => list.slice(0, n);
      return good({
        from: m.releases[fi], to: m.releases[ti], locus: locus || null,
        counts: { added: added.length, removed: removed.length, renamed: renamed.length },
        truncated: added.length > n || removed.length > n || renamed.length > n, limit: n,
        added: cut(added), removed: cut(removed), renamed: cut(renamed),
      });
    },

    async history(raw, asOf) {
      const m = await meta();
      if (!m) return bad(503, "release history is not available on this deployment");
      if (typeof raw !== "string" || !raw.trim()) return bad(422, "name must be a non-empty string");
      const [asI, e] = release(m, asOf, "as_of"); if (e) return bad(422, e);
      const name = clean(raw);
      const hits = await idsFor(name);
      if (!hits.length) return bad(404, `${name} is not an allele name in any release from ${m.releases[0]} to ${m.latest}`);
      const alleles = [];
      for (const [id, locus] of hits) {
        const rec = await record(locus, id);
        if (!rec) continue;
        const used = rec.t.filter(([, , nm]) => nm === name);
        const a = {
          hla_id: id,
          current_name: nameAt(rec, m.releases.length - 1),
          name_first_release: m.releases[used[0][0]],
          name_last_release: m.releases[used[used.length - 1][1]],
          timeline: timeline(rec, m.releases),
          deleted: (rec.d && rec.d[name]) || null,
        };
        if (asI !== null) a.as_of = { release: m.releases[asI], name: nameAt(rec, asI) };
        alleles.push(a);
      }
      return good({ name, latest: m.latest, alleles });
    },
  };
}
