// Documentation drift: the remote MCP tool names advertised in the API docs page,
// the OpenAPI /mcp description and assets/llms.txt must equal what tools/list
// actually returns from edge/src/mcp.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { handleMcp } from "../src/mcp.js";
import { DOCS_HTML, openapi } from "../src/docs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const m = { release: "3.65.0", alleles: 1, exported_at: "test" };

async function liveToolNames() {
  const req = new Request("https://assets.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const json = await (await handleMcp(req, null, { label: "test", tier: "free", keyed: false }, m)).json();
  return json.result.tools.map((t) => t.name).sort();
}

// Every snake_case word, plus any single-word tool name (e.g. "about"), counts as a listed tool.
const namesIn = (s, tools) =>
  [...new Set((s.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/g) || []).filter((w) => w.includes("_") || tools.includes(w)))].sort();

test("docs page 'MCP for agents' paragraph lists every remote tool", async () => {
  const tools = await liveToolNames();
  const para = DOCS_HTML(m).split("<p>").find((p) => p.startsWith("A remote MCP server lives at"));
  assert.ok(para, "remote MCP paragraph not found in DOCS_HTML");
  const listed = para.slice(para.indexOf("as tools:"), para.indexOf("Results are"));
  assert.deepEqual(namesIn(listed, tools), tools);
});

test("OpenAPI /mcp description lists every remote tool", async () => {
  const tools = await liveToolNames();
  const desc = openapi(m).paths["/mcp"].post.description;
  const listed = desc.slice(desc.indexOf("Tools:"), desc.indexOf("."));
  assert.deepEqual(namesIn(listed, tools), tools);
});

test("assets/llms.txt remote MCP section lists every remote tool", async () => {
  const tools = await liveToolNames();
  const txt = (await readFile(path.join(here, "..", "..", "assets", "llms.txt"), "utf8")).replace(/\r\n/g, "\n");
  const start = txt.indexOf("Remote (Streamable HTTP");
  assert.ok(start >= 0, "remote MCP section not found in llms.txt");
  const block = txt.slice(start, txt.indexOf("config:", start));
  const listed = block.slice(block.indexOf("tools:"), block.indexOf("protocol:"));
  assert.deepEqual(namesIn(listed, tools), tools);
  assert.match(block, /2026-07-28/);
  assert.match(block, /server\/discover/);
  assert.match(block, /initialize/);
});
