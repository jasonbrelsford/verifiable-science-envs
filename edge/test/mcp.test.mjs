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

  for (const v of ["2025-03-26", "2024-11-05"]) {
    const r = await rpc("initialize", { protocolVersion: v });
    assert.equal(r.json.result.protocolVersion, v);
  }
  // Unknown/omitted version falls back to the newest we support, not an error.
  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.json.result.protocolVersion, "2025-06-18");
  const omitted = await rpc("initialize", {});
  assert.equal(omitted.json.result.protocolVersion, "2025-06-18");
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
  assert.deepEqual(names, ["about", "allele_info", "match_score", "normalize_allele", "verify_text"]);
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
