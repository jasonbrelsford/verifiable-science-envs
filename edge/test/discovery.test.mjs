// Discovery tests: the Server Card and AI Catalog routes (media types, CORS,
// ETag/304), that the card agrees with what /mcp itself reports through
// server/discover and initialize, and that the repo-root server.json (MCP
// Registry entry) says the same thing as the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/index.js";
import { handleMcp, SERVER_INFO, SUPPORTED_VERSIONS, PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS } from "../src/mcp.js";
import { serverCard, aiCatalog, CARD_PATHS, CATALOG_PATH, CARD_TYPE, CATALOG_TYPE, MCP_URL, REGISTRY_NAME } from "../src/discovery.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJson = JSON.parse(await readFile(path.join(here, "..", "..", "server.json"), "utf8"));
const env = { PUBLIC_ACCESS: "1" };
const get = (p, init = {}) => worker.fetch(new Request(`https://api.hlaverify.com${p}`, init), env, {});

test("server card is served at the reserved and alias paths with card media type, CORS and caching", async () => {
  for (const p of [...CARD_PATHS, CARD_PATHS[0] + "/"]) {
    const r = await get(p, { headers: { accept: CARD_TYPE } });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("content-type"), CARD_TYPE);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-methods"), "GET");
    assert.equal(r.headers.get("access-control-allow-headers"), "Content-Type, If-None-Match");
    assert.equal(r.headers.get("access-control-expose-headers"), "ETag");
    assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
    assert.match(r.headers.get("etag"), /^"[0-9a-f]{32}"$/);
    assert.deepEqual(await r.json(), serverCard());
  }
});

test("ai catalog lists the card by url with the catalog media type", async () => {
  const r = await get(CATALOG_PATH);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), CATALOG_TYPE);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const cat = await r.json();
  assert.deepEqual(cat, aiCatalog());
  assert.equal(cat.specVersion, "1.0");
  assert.ok(cat.host.displayName);
  assert.equal(cat.entries.length, 1);
  const [e] = cat.entries;
  assert.equal(e.type, CARD_TYPE);
  assert.equal(e.url, `${MCP_URL}/server-card`);
  assert.ok(CARD_PATHS.includes(new URL(e.url).pathname));
  assert.match(e.identifier, /^urn:air:hlaverify\.com:mcp:hla-verify$/);
});

test("If-None-Match revalidates to 304; HEAD has no body; preflight and other methods", async () => {
  const first = await get(CARD_PATHS[0]);
  const etag = first.headers.get("etag");
  const again = await get(CARD_PATHS[1]);
  assert.equal(again.headers.get("etag"), etag, "both card paths share one representation");
  const nm = await get(CARD_PATHS[0], { headers: { "if-none-match": `W/"stale", ${etag}` } });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get("etag"), etag);
  assert.equal(await nm.text(), "");
  const changed = await get(CARD_PATHS[0], { headers: { "if-none-match": '"stale"' } });
  assert.equal(changed.status, 200);
  const head = await get(CARD_PATHS[0], { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), CARD_TYPE);
  assert.equal(await head.text(), "");
  const pre = await get(CATALOG_PATH, { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-headers": "if-none-match" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /If-None-Match/);
  const post = await get(CARD_PATHS[0], { method: "POST", body: "{}" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
});

test("discovery routes do not shadow /mcp, and unrelated .well-known paths stay 404", async () => {
  assert.equal((await get("/mcp")).status, 405); // GET /mcp is still the transport's answer
  assert.equal((await get("/.well-known/mcp")).status, 404);
  assert.equal((await get("/mcp/server-card.json")).status, 404);
});

test("card is valid per the Server Card v1 shape and matches the live server", async () => {
  const card = serverCard();
  assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
  assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(card.name, REGISTRY_NAME);
  assert.equal(card.name.split("/")[1], SERVER_INFO.name);
  assert.equal(card.version, SERVER_INFO.version);
  assert.ok(card.description.length >= 1 && card.description.length <= 100, `description is ${card.description.length} chars`);
  assert.ok(card.title.length <= 100);
  assert.equal(card.tools, undefined, "Server Cards carry no primitives");
  assert.equal(card.remotes.length, 1);
  const [remote] = card.remotes;
  assert.equal(remote.type, "streamable-http");
  assert.equal(remote.url, MCP_URL);
  assert.deepEqual(remote.supportedProtocolVersions, [...MODERN_PROTOCOL_VERSIONS, ...PROTOCOL_VERSIONS]);

  // What a client sees once connected must not contradict the card.
  const rpc = async (body, headers = {}) => {
    const req = new Request("https://assets.local/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return (await handleMcp(req, null, { label: "t", tier: "free", keyed: false }, { release: "t" })).json();
  };
  const modern = await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
  assert.deepEqual(modern.result.supportedVersions, remote.supportedProtocolVersions);
  assert.deepEqual(modern.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.deepEqual(modern.result._meta["io.modelcontextprotocol/serverInfo"], SERVER_INFO);
  const legacy = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(legacy.result.serverInfo.version, card.version);
  assert.equal(legacy.result.serverInfo.name, card.name.split("/")[1]);
});

test("server.json (MCP Registry) agrees with the card", () => {
  const card = serverCard();
  assert.equal(serverJson.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  for (const k of ["name", "title", "description", "version", "websiteUrl", "repository"])
    assert.deepEqual(serverJson[k], card[k], k);
  // The registry's remote transport has no supportedProtocolVersions; everything else must match.
  const { supportedProtocolVersions, ...remote } = card.remotes[0];
  assert.deepEqual(serverJson.remotes, [remote]);
  assert.equal(serverJson.packages, undefined);
});
