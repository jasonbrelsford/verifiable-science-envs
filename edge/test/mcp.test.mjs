// MCP endpoint tests: protocol mechanics (initialize, tools/list, errors),
// the key-grammar parser, the webhook signature check, and golden equivalence
// against the SAME fixtures golden.test.mjs uses — proving /mcp and /v1/*
// return byte-identical results for the same input because both call the
// same handlers.js functions over the same engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createEngine } from "../src/engine.js";
import { handleMcp } from "../src/mcp.js";
import { parseKeys } from "../src/keys.js";
import { hmacHex, verifySignature, handleWebhook } from "../src/webhook.js";

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

const who = { label: "test", tier: "enterprise", keyed: true };

function rpcRequest(body) {
  return new Request("https://assets.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function rpc(method, params, id = 1) {
  const resp = await handleMcp(rpcRequest({ jsonrpc: "2.0", id, method, params }), engine, who, manifest);
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}
async function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

// --------------------------------------------------------------- protocol

test("initialize: default and each accepted protocol version", async () => {
  const { status, json } = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(status, 200);
  assert.equal(json.result.protocolVersion, "2025-06-18");
  assert.deepEqual(json.result.capabilities, { tools: {} });
  assert.equal(json.result.serverInfo.name, "hla-verify");
  assert.match(json.result.instructions, /verify/i);

  for (const v of ["2025-11-25", "2025-03-26", "2024-11-05"]) {
    const r = await rpc("initialize", { protocolVersion: v });
    assert.equal(r.json.result.protocolVersion, v);
  }
  // Unknown/omitted version falls back to the newest legacy version, not an error.
  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.json.result.protocolVersion, "2025-11-25");
  const omitted = await rpc("initialize", {});
  assert.equal(omitted.json.result.protocolVersion, "2025-11-25");
});

// ------------------------------------------------- 2026-07-28 (modern) protocol

const MODERN = "2026-07-28";
const CLIENT_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

// Sends a modern request with correct headers unless `headers` overrides them
// (a null value drops that header).
async function modernRpc(method, params = {}, { headers = {}, meta = CLIENT_META } = {}) {
  const body = { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: meta } };
  const h = { "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": method };
  if (method === "tools/call") h["mcp-name"] = params.name;
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) delete h[k];
    else h[k] = v;
  }
  const req = new Request("https://assets.local/mcp", { method: "POST", headers: h, body: JSON.stringify(body) });
  const resp = await handleMcp(req, engine, who, manifest);
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("server/discover: versions, capabilities, identity, cache hints", async () => {
  const { status, json } = await modernRpc("server/discover");
  assert.equal(status, 200);
  const r = json.result;
  assert.equal(r.resultType, "complete");
  assert.equal(r.supportedVersions[0], MODERN);
  assert.ok(r.supportedVersions.includes("2025-06-18"));
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r._meta["io.modelcontextprotocol/serverInfo"].name, "hla-verify");
  assert.match(r.instructions, /verify/i);
  assert.equal(typeof r.ttlMs, "number");
  assert.equal(r.cacheScope, "public");
});

test("server/discover with no _meta still answers (era probe)", async () => {
  const req = new Request("https://assets.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  const json = JSON.parse(await (await handleMcp(req, engine, who, manifest)).text());
  assert.equal(json.result.supportedVersions[0], MODERN);
});

test("modern tools/list: resultType, ttlMs, cacheScope, read-only annotations, deterministic order", async () => {
  const { status, json } = await modernRpc("tools/list");
  assert.equal(status, 200);
  assert.equal(json.result.resultType, "complete");
  assert.equal(json.result.cacheScope, "public");
  assert.ok(json.result.ttlMs > 0);
  const again = await modernRpc("tools/list");
  assert.deepEqual(again.json.result.tools.map((t) => t.name), json.result.tools.map((t) => t.name));
  for (const t of json.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test("modern tools/call returns the same structuredContent as legacy", async () => {
  const input = { text: "A*0101 DQB1*05:03:26:99" };
  const modern = await modernRpc("tools/call", { name: "verify_text", arguments: input });
  const legacy = await callTool("verify_text", input);
  assert.equal(modern.status, 200);
  assert.equal(modern.json.result.resultType, "complete");
  assert.equal(modern.json.result.isError, false);
  assert.deepEqual(modern.json.result.structuredContent, legacy.json.result.structuredContent);
});

test("modern tools/call accepts a base64-sentinel Mcp-Name", async () => {
  const { status, json } = await modernRpc("tools/call", { name: "about", arguments: {} },
    { headers: { "mcp-name": `=?base64?${btoa("about")}?=` } });
  assert.equal(status, 200);
  assert.equal(json.result.structuredContent.name, "HLA-Verify");
});

test("modern header validation -> 400 HeaderMismatch (-32020)", async () => {
  const cases = [
    ["tools/list", {}, { "mcp-protocol-version": null }],
    ["tools/list", {}, { "mcp-protocol-version": "2025-06-18" }],
    ["tools/list", {}, { "mcp-method": null }],
    ["tools/list", {}, { "mcp-method": "tools/call" }],
    ["tools/call", { name: "about", arguments: {} }, { "mcp-name": null }],
    ["tools/call", { name: "about", arguments: {} }, { "mcp-name": "verify_text" }],
  ];
  for (const [method, params, headers] of cases) {
    const { status, json } = await modernRpc(method, params, { headers });
    assert.equal(status, 400, `${method} ${JSON.stringify(headers)}`);
    assert.equal(json.error.code, -32020, `${method} ${JSON.stringify(headers)}`);
  }
});

test("modern request with an unsupported version -> 400 UnsupportedProtocolVersion (-32022)", async () => {
  const meta = { ...CLIENT_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" };
  const { status, json } = await modernRpc("tools/list", {}, { meta, headers: { "mcp-protocol-version": "1900-01-01" } });
  assert.equal(status, 400);
  assert.equal(json.error.code, -32022);
  assert.equal(json.error.data.requested, "1900-01-01");
  assert.ok(json.error.data.supported.includes(MODERN));
});

test("modern ping and unknown methods -> 404 Method not found (-32601)", async () => {
  for (const method of ["ping", "initialize", "resources/list"]) {
    const { status, json } = await modernRpc(method);
    assert.equal(status, 404, method);
    assert.equal(json.error.code, -32601, method);
  }
});

test("notifications/initialized: 202, empty body", async () => {
  const resp = await handleMcp(rpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), engine, who, manifest);
  assert.equal(resp.status, 202);
  assert.equal(await resp.text(), "");
});

test("ping", async () => {
  const { json } = await rpc("ping", {});
  assert.deepEqual(json.result, {});
});

test("tools/list: exact tool names", async () => {
  const { json } = await rpc("tools/list", {});
  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "about", "allele_info", "check_typing", "donor_compat", "match_score",
    "normalize_allele", "validate_gl_string", "verify_text",
  ]);
  for (const t of json.result.tools) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("unknown method -> JSON-RPC -32601", async () => {
  const { json } = await rpc("not/a/method", {});
  assert.equal(json.error.code, -32601);
});

test("tools/call with missing params.name -> -32602", async () => {
  const { json } = await rpc("tools/call", { arguments: {} });
  assert.equal(json.error.code, -32602);
});

test("tools/call with an unknown tool -> isError, not a JSON-RPC error", async () => {
  const { json } = await callTool("no_such_tool", {});
  assert.equal(json.error, undefined);
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent, undefined);
});

test("tools/call validation failure -> isError:true with text, not -32602", async () => {
  const { json } = await callTool("verify_text", { text: 12345 });
  assert.equal(json.result.isError, true);
  assert.equal(json.result.content[0].type, "text");
  assert.match(json.result.content[0].text, /string/);
});

test("parse error -> -32700", async () => {
  const resp = await handleMcp(rpcRequest("{not json"), engine, who, manifest);
  const body = JSON.parse(await resp.text());
  assert.equal(body.error.code, -32700);
});

test("batch array -> -32600", async () => {
  const resp = await handleMcp(rpcRequest([{ jsonrpc: "2.0", id: 1, method: "ping" }]), engine, who, manifest);
  const body = JSON.parse(await resp.text());
  assert.equal(body.error.code, -32600);
});

test("about tool", async () => {
  const { json } = await callTool("about", {});
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.name, "HLA-Verify");
  assert.equal(json.result.structuredContent.release, manifest.release);
});

// -------------------------------------------------------- golden equivalence

test(`mcp verify_text matches REST /v1/verify for all ${fx.verify.length} fixtures`, async () => {
  for (const c of fx.verify) {
    const { json } = await callTool("verify_text", { text: c.input });
    assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
    assert.deepEqual(json.result.structuredContent, c.expected, `verify_text mismatch for ${JSON.stringify(c.input)}`);
  }
});

test("mcp normalize_allele matches the corresponding REST /v1/normalize row (sampled)", async () => {
  let n = 0;
  for (const c of fx.normalize) {
    for (let i = 0; i < c.input.length; i += 7) {
      // sample every 7th to keep this fast while still covering every batch
      const { json } = await callTool("normalize_allele", { name: c.input[i] });
      assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input[i])}`);
      assert.deepEqual(json.result.structuredContent, c.expected.rows[i], `normalize_allele mismatch for ${JSON.stringify(c.input[i])}`);
      n++;
    }
  }
  assert.ok(n > 100, `expected a meaningful sample, got ${n}`);
});

test(`mcp allele_info matches REST /v1/allele for all ${fx.allele.length} fixtures`, async () => {
  for (const c of fx.allele) {
    const { json } = await callTool("allele_info", { name: c.input });
    assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
    assert.deepEqual(json.result.structuredContent, c.expected, `allele_info mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`mcp match_score matches the engine's /v1/match body for all ${fx.match.length} fixtures`, async () => {
  for (const c of fx.match) {
    const { json } = await callTool("match_score", c.input);
    assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
    const expected = await engine.match(c.input.framework, c.input.recipient, c.input.donor);
    assert.deepEqual(json.result.structuredContent, expected, `match_score mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`mcp check_typing matches REST /v1/typing/check for all ${fx.typing_check.length} fixtures`, async () => {
  for (const c of fx.typing_check) {
    const { json } = await callTool("check_typing", { typing: c.input });
    assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
    assert.deepEqual(json.result.structuredContent, c.expected, `check_typing mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`mcp donor_compat matches REST /v1/compat for all ${fx.compat.length} fixtures`, async () => {
  for (const c of fx.compat) {
    const { json } = await callTool("donor_compat", c.input);
    assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
    assert.deepEqual(json.result.structuredContent, c.expected, `donor_compat mismatch for ${JSON.stringify(c.input)}`);
  }
});

test(`mcp validate_gl_string matches REST /v1/glstring for all ${fx.glstring.length} fixtures`, async () => {
  for (const c of fx.glstring) {
    const { json } = await callTool("validate_gl_string", { gl: c.input });
    if (c.status === 200) {
      assert.equal(json.result.isError, false, `unexpected error for ${JSON.stringify(c.input)}`);
      assert.deepEqual(json.result.structuredContent, c.expected, `validate_gl_string mismatch for ${JSON.stringify(c.input)}`);
    } else {
      assert.equal(json.result.isError, true, `expected an error for ${JSON.stringify(c.input)}`);
      assert.equal(json.result.content[0].text, c.expected.detail, `detail mismatch for ${JSON.stringify(c.input)}`);
    }
  }
});

// ----------------------------------------------------------- output schemas
// Compliant clients validate structuredContent against each tool's outputSchema
// and reject the call on a mismatch, so every real result must pass. No npm deps
// here: a small validator for exactly the keywords the schemas use. It refuses any
// other keyword, so a schema cannot lean on something this test silently ignores.

const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description"]);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function assertSupportedSchema(schema, at = "#") {
  assert.equal(jsonType(schema), "object", `${at}: schema must be an object`);
  for (const k of Object.keys(schema)) assert.ok(SCHEMA_KEYWORDS.has(k), `${at}: unsupported keyword '${k}'`);
  if (schema.properties) for (const [k, s] of Object.entries(schema.properties)) assertSupportedSchema(s, `${at}/properties/${k}`);
  if (schema.items) assertSupportedSchema(schema.items, `${at}/items`);
  if (jsonType(schema.additionalProperties) === "object") assertSupportedSchema(schema.additionalProperties, `${at}/additionalProperties`);
  // Permissive by design: a strict output schema breaks every validating client.
  assert.notEqual(schema.additionalProperties, false, `${at}: additionalProperties:false rejects future fields`);
  for (const r of schema.required ?? []) assert.ok(schema.properties && hasOwn(schema.properties, r), `${at}: required '${r}' not in properties`);
}

function schemaErrors(schema, value, at = "$", errs = []) {
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    const t = jsonType(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      errs.push(`${at}: expected ${types.join("|")}, got ${t}`);
      return errs;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((x, i) => schemaErrors(schema.items, x, `${at}[${i}]`, errs));
  } else if (jsonType(value) === "object") {
    for (const r of schema.required ?? []) if (!hasOwn(value, r)) errs.push(`${at}: missing required '${r}'`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && hasOwn(schema.properties, k)) schemaErrors(schema.properties[k], v, `${at}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected '${k}'`);
      else if (jsonType(schema.additionalProperties) === "object") schemaErrors(schema.additionalProperties, v, `${at}.${k}`, errs);
    }
  }
  return errs;
}

const outputSchemas = Object.fromEntries((await rpc("tools/list", {})).json.result.tools.map((t) => [t.name, t.outputSchema]));

// Every tool call the fixtures exercise, as [tool, arguments].
function fixtureCalls() {
  const calls = [];
  for (const c of fx.verify) calls.push(["verify_text", { text: c.input }]);
  for (const c of fx.normalize) for (const name of c.input) calls.push(["normalize_allele", { name }]);
  for (const c of fx.allele) calls.push(["allele_info", { name: c.input }]);
  for (const c of fx.match) calls.push(["match_score", c.input]);
  for (const c of fx.typing_check) calls.push(["check_typing", { typing: c.input }]);
  for (const c of fx.compat) calls.push(["donor_compat", c.input]);
  for (const c of fx.glstring) calls.push(["validate_gl_string", { gl: c.input }]);
  calls.push(["about", {}]);
  return calls;
}

// Branches the fixtures never reach: a single HLA-B mismatch with leader_match
// true / false, and complete KIR-ligand typing on both sides.
const FULL_TYPING = { A: ["A*01:01", "A*02:01"], B: ["B*07:02", "B*08:01"], C: ["C*07:01", "C*07:02"], DRB1: ["DRB1*15:01", "DRB1*03:01"] };
const BRANCH_CALLS = [
  ["donor_compat", { recipient: FULL_TYPING, donor: { ...FULL_TYPING, B: ["B*07:02", "B*42:01"] } }],
  ["donor_compat", { recipient: FULL_TYPING, donor: { ...FULL_TYPING, B: ["B*07:02", "B*44:02"] } }],
  ["check_typing", { typing: FULL_TYPING }],
  ["check_typing", { typing: { DQB1: ["DQB1*02:01"] } }],
  ["match_score", { recipient: FULL_TYPING, donor: FULL_TYPING, framework: "12/12" }],
  ["allele_info", { name: "C*04:09N" }],
];

test("tools/list: every tool has an object outputSchema using only validator-supported keywords", async () => {
  assert.equal(Object.keys(outputSchemas).length, 8);
  for (const [name, schema] of Object.entries(outputSchemas)) {
    assert.ok(schema, `${name} has no outputSchema`);
    assert.equal(schema.type, "object", `${name}: outputSchema root must be type object`);
    assertSupportedSchema(schema, name);
  }
  const modern = await modernRpc("tools/list");
  assert.deepEqual(Object.fromEntries(modern.json.result.tools.map((t) => [t.name, t.outputSchema])), outputSchemas);
});

test("outputSchema accepts structuredContent for every fixture call and branch case", async () => {
  const calls = [...fixtureCalls(), ...BRANCH_CALLS];
  const seen = { leaderTrue: false, leaderFalse: false, kirComplete: false, potential: false, errors: 0 };
  const failures = [];
  for (const [name, args] of calls) {
    const { json } = await callTool(name, args);
    if (json.result.isError) { seen.errors++; continue; } // error results carry no structuredContent
    const sc = json.result.structuredContent;
    const errs = schemaErrors(outputSchemas[name], sc);
    if (errs.length) failures.push(`${name} ${JSON.stringify(args).slice(0, 120)}: ${errs.slice(0, 3).join("; ")}`);
    if (name === "donor_compat") {
      if (sc.b_leader.leader_match === true) seen.leaderTrue = true;
      if (sc.b_leader.leader_match === false) seen.leaderFalse = true;
      if (sc.kir_ligands.status === "complete") seen.kirComplete = true;
    }
    if (name === "match_score" && Object.values(sc.verdicts).includes("potential")) seen.potential = true;
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${calls.length} results failed their outputSchema`);
  assert.ok(calls.length > 4000, `expected every fixture call, got ${calls.length}`);
  assert.deepEqual(seen, { leaderTrue: true, leaderFalse: true, kirComplete: true, potential: true, errors: 2 });
});

test("outputSchema validation rejects wrong shapes (the check has teeth)", async () => {
  const verify = (await callTool("verify_text", { text: "A*01:01 A*99:99" })).json.result.structuredContent;
  assert.deepEqual(schemaErrors(outputSchemas.verify_text, verify), []);
  const broken = [
    [{ ...verify, clean: "yes" }, /clean: expected boolean/],
    [{ ...verify, tokens: [{ ...verify.tokens[0], status: "made_up" }] }, /not in enum/],
    [(({ counts, ...rest }) => rest)(verify), /missing required 'counts'/],
  ];
  for (const [value, re] of broken) assert.match(schemaErrors(outputSchemas.verify_text, value).join("\n"), re);

  const match = (await callTool("match_score", { recipient: FULL_TYPING, donor: FULL_TYPING })).json.result.structuredContent;
  assert.deepEqual(schemaErrors(outputSchemas.match_score, match), []);
  assert.match(schemaErrors(outputSchemas.match_score, { ...match, verdicts: { A: "maybe" } }).join("\n"), /verdicts\.A: .* not in enum/);
  assert.match(schemaErrors(outputSchemas.match_score, { ...match, hvg_mismatches: 1.5 }).join("\n"), /expected integer, got number/);

  const typing = (await callTool("check_typing", { typing: FULL_TYPING })).json.result.structuredContent;
  assert.match(schemaErrors(outputSchemas.check_typing, { ...typing, drb345: [] }).join("\n"), /drb345: expected object\|null, got array/);
});

// ------------------------------------------------------------ key grammar

test("parseKeys: key=label:tier grammar", () => {
  const m = parseKeys("k1=Acme Lab:starter, k2=Big Pharma:pro,k3=Old Key,k4,k5=Weird:notatier");
  assert.deepEqual(m.get("k1"), { label: "Acme Lab", tier: "starter" });
  assert.deepEqual(m.get("k2"), { label: "Big Pharma", tier: "pro" });
  // legacy "key=label" (no tier) defaults to enterprise, preserving old uncapped keys
  assert.deepEqual(m.get("k3"), { label: "Old Key", tier: "enterprise" });
  // bare key, no "="
  assert.deepEqual(m.get("k4"), { label: "key", tier: "enterprise" });
  // trailing ":word" that isn't a real tier is kept as part of the label
  assert.deepEqual(m.get("k5"), { label: "Weird:notatier", tier: "enterprise" });
});

test("parseKeys: empty/undefined input", () => {
  assert.equal(parseKeys("").size, 0);
  assert.equal(parseKeys(undefined).size, 0);
});

// ------------------------------------------------------------- webhook

test("webhook: HMAC-SHA256 hex signature, constant-time compare", async () => {
  const secret = "test-signing-secret";
  const body = JSON.stringify({ meta: { event_name: "license_key_created" }, data: { id: "1", attributes: { key: "hlv_abc" } } });
  const goodSig = await hmacHex(secret, body);
  assert.equal(await verifySignature(secret, body, goodSig), true);
  assert.equal(await verifySignature(secret, body, goodSig.toUpperCase()), true);
  assert.equal(await verifySignature(secret, body, "0".repeat(64)), false);
  assert.equal(await verifySignature(secret, body, ""), false);
  assert.equal(await verifySignature(secret, body + "tampered", goodSig), false);
  assert.equal(await verifySignature("wrong-secret", body, goodSig), false);
});

function fakeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

test("webhook: rejects missing/invalid signature with 401", async () => {
  const env = { LEMONSQUEEZY_WEBHOOK_SECRET: "s3cret", KEYS: fakeKV() };
  const body = JSON.stringify({ meta: { event_name: "license_key_created" }, data: { id: "1", attributes: { key: "hlv_x" } } });
  const req1 = new Request("https://assets.local/webhooks/lemonsqueezy", { method: "POST", headers: { "content-type": "application/json" }, body });
  const r1 = await handleWebhook(req1, env);
  assert.equal(r1.status, 401);

  const req2 = new Request("https://assets.local/webhooks/lemonsqueezy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": "deadbeef" },
    body,
  });
  const r2 = await handleWebhook(req2, env);
  assert.equal(r2.status, 401);
});

test("webhook: license_key_created issues an active key readable by authorize()-style lookup", async () => {
  const secret = "s3cret";
  const env = { LEMONSQUEEZY_WEBHOOK_SECRET: secret, KEYS: fakeKV(), TIER_MAP: JSON.stringify({ "HLA-Verify Pro": "pro" }) };
  const payload = { meta: { event_name: "license_key_created" }, data: { id: "lic_1", attributes: { key: "hlv_newkey", variant_name: "HLA-Verify Pro", user_email: "a@b.com" } } };
  const raw = JSON.stringify(payload);
  const sig = await hmacHex(secret, raw);
  const req = new Request("https://assets.local/webhooks/lemonsqueezy", { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body: raw });
  const resp = await handleWebhook(req, env);
  assert.equal(resp.status, 200);
  const body = JSON.parse(await resp.text());
  assert.deepEqual(body, { ok: true, handled: "license_key_created" });

  const rec = JSON.parse(await env.KEYS.get("hlv_newkey"));
  assert.equal(rec.tier, "pro");
  assert.equal(rec.status, "active");

  // subscription_cancelled for that license id revokes the key
  const cancelPayload = { meta: { event_name: "subscription_cancelled" }, data: { id: "sub_1", attributes: { license_key_id: "lic_1" } } };
  const rawCancel = JSON.stringify(cancelPayload);
  const sigCancel = await hmacHex(secret, rawCancel);
  const reqCancel = new Request("https://assets.local/webhooks/lemonsqueezy", { method: "POST", headers: { "content-type": "application/json", "x-signature": sigCancel }, body: rawCancel });
  const respCancel = await handleWebhook(reqCancel, env);
  assert.equal(respCancel.status, 200);
  const recAfter = JSON.parse(await env.KEYS.get("hlv_newkey"));
  assert.equal(recAfter.status, "revoked");
});

test("webhook: unmapped product name falls back to starter tier", async () => {
  const secret = "s3cret";
  const env = { LEMONSQUEEZY_WEBHOOK_SECRET: secret, KEYS: fakeKV(), TIER_MAP: JSON.stringify({}) };
  const payload = { meta: { event_name: "license_key_created" }, data: { id: "lic_2", attributes: { key: "hlv_other", variant_name: "Something Else" } } };
  const raw = JSON.stringify(payload);
  const sig = await hmacHex(secret, raw);
  const req = new Request("https://assets.local/webhooks/lemonsqueezy", { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body: raw });
  await handleWebhook(req, env);
  const rec = JSON.parse(await env.KEYS.get("hlv_other"));
  assert.equal(rec.tier, "starter");
});
