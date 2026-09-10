// Golden equality test: the edge engine must reproduce the Python oracle byte-for-byte.
// Fixtures come from edge/test/gen_fixtures.py; shards from sci_envs.service.edge_export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createEngine } from "../src/engine.js";

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
    assert.deepEqual(got, c.expected);
  }
});

test(`allele: ${fx.allele.length} names`, async () => {
  for (const c of fx.allele) {
    const got = await engine.allele(c.input);
    assert.equal(got.status, c.status, `status mismatch for ${JSON.stringify(c.input)}`);
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
