// Golden equality test: the edge engine must reproduce the Python oracle byte-for-byte.
// Fixtures come from edge/test/gen_fixtures.py; shards from sci_envs.service.edge_export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createEngine } from "../src/engine.js";
import { doGlString } from "../src/handlers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const manifest = JSON.parse(await readFile(path.join(pub, "manifest.json"), "utf8"));
const fx = JSON.parse(await readFile(path.join(here, "fixtures.json"), "utf8"));

const engine = createEngine({
  manifest,
  loadShard: async (sh) => {
    try {
      return JSON.parse(await readFile(path.join(pub, "data", sh + ".json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
});

test("fixtures and shards are from the same release", () => {
  assert.equal(fx.release, manifest.release);
});

test(`verify: ${fx.verify.length} texts`, async () => {
  let n = 0;
  for (const c of fx.verify) {
    const got = await engine.verify(c.input);
    delete got.attribution;
    delete c.expected.attribution;
    assert.deepEqual(got, c.expected, `verify mismatch for text: ${JSON.stringify(c.input)}`);
    n++;
  }
  assert.equal(n, fx.verify.length);
});

test(`normalize: ${fx.normalize.reduce((a, c) => a + c.input.length, 0)} typings`, async () => {
  for (const c of fx.normalize) {
    const got = await engine.normalizeBatch(c.input);
    for (let i = 0; i < c.input.length; i++)
      assert.deepEqual(got.rows[i], c.expected.rows[i], `normalize mismatch for ${JSON.stringify(c.input[i])}`);
    delete got.attribution;
    delete c.expected.attribution;
    assert.deepEqual(got, c.expected);
  }
});

test(`allele: ${fx.allele.length} names`, async () => {
  for (const c of fx.allele) {
    const got = await engine.allele(c.input);
    assert.equal(got.status, c.status, `status mismatch for ${JSON.stringify(c.input)}`);
    delete got.body.attribution;
    delete c.expected.attribution;
    assert.deepEqual(got.body, c.expected, `allele mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`match: ${fx.match.length} pairs`, async () => {
  for (const c of fx.match) {
    const got = await engine.match(c.input.framework, c.input.recipient, c.input.donor);
    delete got.attribution;
    assert.deepEqual(got, c.expected, `match mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`typing_check: ${fx.typing_check.length} typings`, async () => {
  for (const c of fx.typing_check) {
    const got = await engine.checkTyping(c.input);
    delete got.attribution;
    delete c.expected.attribution;
    assert.deepEqual(got, c.expected, `typing_check mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`compat: ${fx.compat.length} pairs`, async () => {
  for (const c of fx.compat) {
    const got = await engine.compat(c.input.recipient, c.input.donor);
    delete got.attribution;
    delete c.expected.attribution;
    assert.deepEqual(got, c.expected, `compat mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`glstring: ${fx.glstring.length} strings`, async () => {
  for (const c of fx.glstring) {
    const r = await doGlString(engine, manifest, c.input);
    if (c.status === 200) {
      assert.equal(r.ok, true, `unexpected error for ${JSON.stringify(c.input)}: ${r.detail}`);
      delete r.body.attribution;
      delete c.expected.attribution;
      assert.deepEqual(r.body, c.expected, `glstring mismatch for ${JSON.stringify(c.input)}`);
    } else {
      assert.equal(r.ok, false, `expected a ${c.status} for ${JSON.stringify(c.input)}`);
      assert.equal(r.status, c.status, `status mismatch for ${JSON.stringify(c.input)}`);
      assert.equal(r.detail, c.expected.detail, `detail mismatch for ${JSON.stringify(c.input)}`);
    }
  }
});

// Legacy spellings in /v1/verify (#88, #89): pinned expectations, independent of the fixture
// file, so a regenerated fixtures.json cannot quietly carry a regression through.
const byToken = (r) => Object.fromEntries(r.tokens.map((t) => [t.token, t]));

test("verify: common legacy 4-digit names are valid with deprecated_name, and the report is clean (#88)", async () => {
  const r = await engine.verify("A*0201, B*0702, A*2402, DRB1*1501, DRB1*0401, DQB1*0301, HLA-A*0201, A*0101, B*4402, DPB1*0401");
  assert.equal(r.clean, true);
  assert.equal(r.counts.hallucinated, 0);
  assert.equal(r.counts.deleted, 0);
  const t = byToken(r);
  for (const [tok, cur] of [["A*0201", "A*02:01"], ["B*0702", "B*07:02"], ["A*2402", "A*24:02"], ["DRB1*1501", "DRB1*15:01"],
    ["DRB1*0401", "DRB1*04:01"], ["DQB1*0301", "DQB1*03:01"], ["A*0101", "A*01:01"], ["B*4402", "B*44:02"], ["DPB1*0401", "DPB1*04:01"]]) {
    assert.equal(t[tok].status, "valid", tok);
    assert.equal(t[tok].current_2field, cur, tok);
    assert.deepEqual(t[tok].flags, ["deprecated_name"], tok);
  }
  assert.ok(!("HLA-A*0201" in t), "the HLA- prefix is stripped from the reported token");
});

test("verify: Cw* names are seen, resolved to C*, and a fabricated one is hallucinated (#89)", async () => {
  const r = await engine.verify("A*0201, Cw*0702, HLA-Cw*0702, Cw*07:02, Cw*07:XX, Cw*9999, Cw*99:99, Cw6, DRB1*1501");
  const t = byToken(r);
  assert.equal(t["Cw*0702"].status, "valid");
  assert.equal(t["Cw*0702"].current_2field, "C*07:02");
  assert.deepEqual(t["Cw*0702"].flags, ["deprecated_name"]);
  assert.equal(t["Cw*07:02"].status, "valid");
  assert.equal(t["Cw*07:02"].current_2field, "C*07:02");
  assert.deepEqual(t["Cw*07:02"].flags, ["deprecated_name"]);
  assert.equal(t["Cw*07:XX"].status, "valid");
  assert.equal(t["Cw*07:XX"].current_2field, "C*07");
  assert.deepEqual(t["Cw*07:XX"].flags, ["deprecated_name", "xx_code"]);
  assert.equal(t["Cw*9999"].status, "hallucinated");
  assert.equal(t["Cw*99:99"].status, "hallucinated");
  assert.ok(!("Cw6" in t), "serology has no * and stays out");
  assert.equal(r.counts.hallucinated, 2);
  assert.equal(r.clean, false);
});

test("verify: a legacy name keeps its own deletion record, or follows its colon form's successor", async () => {
  const r = await engine.verify("A*0105N B*1308Q Cw*04:09N A*01011 A*9999");
  const t = byToken(r);
  assert.equal(t["A*0105N"].status, "deleted");               // listed in Deleted_alleles.txt under its old spelling
  assert.equal(t["A*0105N"].successor, "A*01:04:01:01N");
  assert.equal(t["B*1308Q"].status, "deleted");               // B*13:08Q was deleted: its successor
  assert.equal(t["B*1308Q"].successor, "B*13:08");
  assert.equal(t["B*1308Q"].current_2field, "B*13:08");
  assert.equal(t["Cw*04:09N"].status, "deleted");
  assert.equal(t["Cw*04:09N"].successor, "C*04:09L");
  assert.equal(t["A*01011"].status, "deleted");               // a 5-digit interim name: history only
  assert.equal(t["A*01011"].successor, "A*01:01:01:01");
  assert.equal(t["A*9999"].status, "hallucinated");           // a fabricated legacy name is still fabricated
  assert.equal(r.clean, false);
});

test("normalize and allele read Cw*07:02 as a deprecated spelling of C*07:02 (#89)", async () => {
  const n = await engine.normalizeBatch(["Cw*07:02", "HLA-Cw*07:02:01:01", "Cw*07:AB", "cw*07:02"]);
  assert.equal(n.rows[0].current_name, "C*07:02");
  assert.deepEqual(n.rows[0].flags, ["deprecated_name"]);
  assert.equal(n.rows[1].current_name, "C*07:02:01:01");
  assert.deepEqual(n.rows[1].flags, ["deprecated_name"]);
  assert.equal(n.rows[2].current_name, "UNRESOLVABLE");
  assert.deepEqual(n.rows[2].flags, ["deprecated_name", "mac_code"]);
  assert.equal(n.rows[3].current_name, "UNRESOLVABLE", "lower-case is still a formatting variant, not a name");
  const a = await engine.allele("Cw*07:02");
  assert.equal(a.status, 200);
  assert.equal(a.body.status, "valid_prefix");
  assert.equal(a.body.resolves_to, "C*07:02");
  assert.deepEqual(a.body.flags, ["deprecated_name"]);
  const x = await engine.allele("Cw*07:XX");
  assert.equal(x.body.resolves_to, "C*07");
  assert.deepEqual(x.body.flags, ["deprecated_name", "xx_code"]);
  const m = await engine.allele("Cw*07:AB");
  assert.equal(m.body.status, "mac_code");
});
