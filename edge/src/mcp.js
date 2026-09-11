// Remote MCP endpoint (Streamable HTTP transport, JSON-RPC 2.0). Stateless: no
// sessions, no SSE — every POST gets exactly one JSON response. Tool names and
// descriptions mirror sci_envs/mcp_server.py (the stdio server) so an agent
// that knows one knows the other; the outputs are the same shapes the REST API
// returns (doVerify/doNormalize/doAllele/doMatch in handlers.js), so results
// are byte-identical between /v1/* and /mcp for the same input.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS } from "./engine.js";
import { doVerify, doNormalize, doAllele, doMatch, MAX_TEXT, MAX_TYPINGS, MAX_NAME } from "./handlers.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "hla-verify", version: "1.0.0" };
export const INSTRUCTIONS =
  "Deterministic HLA verification against a pinned IPD-IMGT/HLA release. No LLM " +
  "inside: every verdict is a table lookup. Call verify_text on any AI-generated " +
  "or transcribed content that mentions HLA alleles before presenting it; call " +
  "normalize_allele or allele_info before asserting an allele name is valid or " +
  "current; call match_score instead of computing a donor-recipient match count " +
  "yourself. LLMs (including you) fabricate allele names and miscount matches — " +
  "verify HLA names before presenting them.";

function toolDefs() {
  return [
    {
      name: "verify_text",
      description:
        "Scan free text for HLA allele-shaped tokens and classify each one: " +
        "valid / legacy (with modern form) / deleted (with successor) / fabricated. " +
        "Use on any AI-generated or transcribed content mentioning HLA.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", maxLength: MAX_TEXT, description: "Free text to scan." } },
        additionalProperties: false,
      },
    },
    {
      name: "normalize_allele",
      description:
        "Normalize one reported HLA allele name (any era) to current 2-field form, " +
        "with G group, P group, serologic equivalent, and flags.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", maxLength: MAX_NAME, description: "Reported allele name, any nomenclature era." } },
        additionalProperties: false,
      },
    },
    {
      name: "allele_info",
      description:
        "Look up one exact name in the pinned release and return what it is: " +
        "assigned (G/P group, first release, confirmed status, WMDA serology, null flag), " +
        "valid_prefix (member count and sample), or deleted (successor). Not found if the " +
        "name has never existed in any release.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", maxLength: MAX_NAME, description: "Exact allele, prefix, or deleted name." } },
        additionalProperties: false,
      },
    },
    {
      name: "match_score",
      description:
        "Score a donor-recipient HLA match with the published rules (R1-R6). " +
        'recipient/donor: {"A": ["A*01:01","A*02:01"], "B": [...], ...} (two reported ' +
        "alleles per locus, any nomenclature era). framework: 6/6, 8/8, 10/10, 12/12, " +
        "or antigen. Returns count, per-locus verdicts, GvH/HvG mismatch counts, and " +
        "flags; unresolvable typing yields 'potential', never a confident count.",
      inputSchema: {
        type: "object",
        required: ["recipient", "donor"],
        properties: {
          recipient: { type: "object", description: "locus -> up to 4 reported alleles", additionalProperties: { type: "array", items: { type: "string" } } },
          donor: { type: "object", description: "locus -> up to 4 reported alleles", additionalProperties: { type: "array", items: { type: "string" } } },
          framework: { type: "string", enum: Object.keys(FRAMEWORKS), default: "8/8" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "about",
      description: "What this server is, benchmark evidence for why to use it, and terms.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

function aboutBody(manifest) {
  return {
    name: "HLA-Verify",
    release: manifest.release,
    why: "Every LLM family tested scores 0% on 2-field ambiguity expansion and fabricates allele names at 0.05-0.14/task (HLA-Bench).",
    code: "https://github.com/jasonbrelsford/verifiable-science-envs",
    api: "https://api.hlaverify.com/docs",
    demo: "https://hlaverify.com/demo",
    agents: "https://hlaverify.com/llms.txt",
    commercial: "hello@hlaverify.com (Brelsford Software LLC)",
    disclaimer: "Research-and-evaluation tool; not a medical device.",
  };
}

function okResult(structured, units) {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, units };
}
function errResult(detail) {
  return { isError: true, content: [{ type: "text", text: detail }], units: 0 };
}

async function callTool(name, args, eng, manifest) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return errResult("arguments must be an object");

  switch (name) {
    case "verify_text": {
      const r = await doVerify(eng, manifest, args.text);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "normalize_allele": {
      if (typeof args.name !== "string") return errResult("name must be a string");
      const r = await doNormalize(eng, manifest, [args.name]);
      return r.ok ? okResult(r.body.rows[0], 1) : errResult(r.detail);
    }
    case "allele_info": {
      if (typeof args.name !== "string") return errResult("name must be a string");
      const r = await doAllele(eng, manifest, args.name);
      return r.ok ? okResult(r.body, 1) : errResult(r.detail);
    }
    case "match_score": {
      const r = await doMatch(eng, manifest, args.framework, args.recipient, args.donor);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "about":
      return okResult(aboutBody(manifest), 0);
    default:
      return errResult(`unknown tool: ${name}`);
  }
}

function rpcResult(id, result) {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(id, code, message) {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, code === -32700 || code === -32600 ? 400 : 200);
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// handleMcp(request, engine, who, manifest, onCall?) -> Response
// onCall(toolName, httpishStatus, units) is an optional metering hook invoked
// once per tools/call so the caller (index.js) can record usage the same way
// it meters REST calls; it is a no-op by default so this module works standalone
// (as it does in the golden tests, which call it directly with a synthetic Request).
export async function handleMcp(request, engine, who, manifest, onCall = () => {}) {
  let raw;
  try {
    raw = await request.text();
  } catch (_) {
    raw = "";
  }

  let msg;
  try {
    msg = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return rpcError(null, -32700, "Parse error");
  }

  if (Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request: batch requests are not supported");
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return rpcError(msg && typeof msg === "object" ? msg.id : null, -32600, "Invalid Request");

  const { method, params, id } = msg;

  if (method === "notifications/initialized") return new Response(null, { status: 202 });

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
    return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: toolDefs() });

  if (method === "tools/call") {
    const name = params && params.name;
    const args = params && params.arguments;
    if (typeof name !== "string" || !name) return rpcError(id, -32602, "Invalid params: params.name (string) is required");
    const result = await callTool(name, args, engine, manifest);
    onCall(name, result.isError ? 422 : 200, result.units ?? 0);
    const out = { content: result.content, isError: result.isError };
    if (!result.isError) out.structuredContent = result.structuredContent;
    return rpcResult(id, out);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
