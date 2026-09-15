// Pre-connection MCP discovery: a Server Card (SEP-2127, the
// io.modelcontextprotocol/server-card extension — schema and discovery rules in
// github.com/modelcontextprotocol/experimental-ext-server-card) and an AI Catalog
// that points at it. Built from the same constants mcp.js answers
// server/discover and initialize with, so the card cannot drift from the live
// server. Cards deliberately carry no tools: primitives stay runtime-only
// (tools/list). The repo-root server.json (official MCP Registry entry) mirrors
// this card; test/discovery.test.mjs fails if the two disagree.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { SERVER_INFO, SUPPORTED_VERSIONS } from "./mcp.js";

export const MCP_URL = "https://api.hlaverify.com/mcp";
// Reverse-DNS registry name: com.hlaverify/* is granted by domain (DNS or HTTP)
// authentication for hlaverify.com in the official MCP Registry.
export const REGISTRY_NAME = `com.hlaverify/${SERVER_INFO.name}`;
export const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const CARD_TYPE = "application/mcp-server-card+json";
export const CATALOG_TYPE = "application/ai-catalog+json";

// <streamable-http-url>/server-card is the location the extension reserves;
// the .well-known alias serves clients that probe the SEP-1649-era path.
export const CARD_PATHS = ["/mcp/server-card", "/.well-known/mcp/server-card.json"];
export const CATALOG_PATH = "/.well-known/ai-catalog.json";

export function serverCard() {
  return {
    $schema: CARD_SCHEMA,
    name: REGISTRY_NAME,
    version: SERVER_INFO.version,
    description: "Verify HLA allele names and score donor-recipient matches against a pinned IPD-IMGT/HLA release.",
    title: "HLA-Verify",
    websiteUrl: "https://hlaverify.com",
    repository: { url: "https://github.com/jasonbrelsford/verifiable-science-envs", source: "github", subfolder: "edge", id: "1350739538" },
    remotes: [{
      type: "streamable-http",
      url: MCP_URL,
      headers: [{
        name: "X-API-Key",
        description: "Optional. Without a key /mcp shares the free tier (60 requests/minute); keys: https://api.hlaverify.com/pricing",
        isRequired: false,
        isSecret: true,
      }],
      supportedProtocolVersions: SUPPORTED_VERSIONS,
    }],
  };
}

export function aiCatalog() {
  return {
    specVersion: "1.0",
    host: { displayName: "HLA-Verify", identifier: "hlaverify.com", documentationUrl: "https://api.hlaverify.com/docs" },
    entries: [{
      identifier: `urn:air:hlaverify.com:mcp:${SERVER_INFO.name}`,
      type: CARD_TYPE,
      url: `${MCP_URL}/server-card`,
      tags: ["hla", "immunogenetics", "mcp"],
    }],
  };
}

// CORS and caching exactly as docs/discovery.md asks of card hosts.
const DISCOVERY_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
};

const bodies = new Map(); // path kind -> { text, etag }; content only changes on deploy
async function rendered(kind) {
  if (!bodies.has(kind)) {
    const text = JSON.stringify(kind === "card" ? serverCard() : aiCatalog());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
    bodies.set(kind, { text, etag: `"${hex}"` });
  }
  return bodies.get(kind);
}

// Returns a Response for a discovery path, or null so the caller keeps routing.
export async function handleDiscovery(req, path) {
  const kind = CARD_PATHS.includes(path) ? "card" : path === CATALOG_PATH ? "catalog" : null;
  if (!kind) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...DISCOVERY_CORS, "access-control-max-age": "86400" } });
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(JSON.stringify({ detail: `GET ${path}` }), { status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD, OPTIONS", ...DISCOVERY_CORS } });
  const { text, etag } = await rendered(kind);
  const headers = { "cache-control": "public, max-age=3600", etag, ...DISCOVERY_CORS };
  const inm = req.headers.get("if-none-match") || "";
  if (inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*"))
    return new Response(null, { status: 304, headers });
  headers["content-type"] = kind === "card" ? CARD_TYPE : CATALOG_TYPE;
  return new Response(req.method === "HEAD" ? null : text, { headers });
}
