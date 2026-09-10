// API reference page and OpenAPI document for api.hlaverify.com.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function DOCS_HTML(m) {
  const curl = (s) => `<pre><code>${esc(s)}</code></pre>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify API — reference</title>
<meta name="description" content="Deterministic HLA nomenclature and donor-recipient matching verification API, pinned to IPD-IMGT/HLA ${esc(m.release)}. No LLM, nothing stored.">
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:28px 22px 60px}
h1{font-family:Georgia,serif;font-size:2rem;margin:.2em 0}h2{font-family:Georgia,serif;color:var(--green);margin-top:2.2em;border-bottom:1px solid var(--line);padding-bottom:.2em}
h3{margin:1.6em 0 .3em;font-size:1.05rem}code{background:#EEECE4;padding:.1em .35em;border-radius:4px;font-size:.92em}
pre{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:13px;line-height:1.5}pre code{background:none;padding:0}
.pill{display:inline-block;background:#DCEFDC;color:var(--green);border-radius:999px;padding:2px 10px;font-size:.8rem;font-weight:600;margin-right:6px}
table{border-collapse:collapse;width:100%;font-size:.93rem}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
a{color:var(--green)}.mut{color:var(--mut)}nav a{margin-right:14px}
</style></head><body><div class="wrap">
<nav><a href="https://hlaverify.com">hlaverify.com</a><a href="https://hlaverify.com/demo">in-browser demo</a><a href="/openapi.json">openapi.json</a><a href="https://github.com/jasonbrelsford/verifiable-science-envs">source &amp; benchmark</a></nav>
<h1>HLA-Verify API</h1>
<p class="mut">Base URL <code>https://api.hlaverify.com</code> (also <code>https://hlaverify.com/v1/…</code>). Pinned to IPD-IMGT/HLA <b>${esc(m.release)}</b> — ${m.alleles.toLocaleString()} named alleles. Every response carries the release and the attribution line. No LLM anywhere; nothing you send is stored.</p>

<h2>Authentication and limits</h2>
<p>Without a key the API is open for evaluation at <b>60 requests per minute per IP</b>. Labs, LIMS vendors and agent platforms get a key (header <code>X-API-Key: …</code> or <code>Authorization: Bearer …</code>) with no per-minute cap, per-key usage reporting, and a release-change notice before each quarterly IPD-IMGT/HLA update. Keys: <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>

<h2>Endpoints</h2>
<h3><span class="pill">POST</span><code>/v1/verify</code> — check every allele-shaped token in free text</h3>
<p>Send a typing report, an EHR fragment, or a model's answer. Every token that looks like an allele is classified: <code>valid</code>, <code>group</code> (G/P), <code>deleted</code> (with successor), <code>fabricated_group</code>, or <code>hallucinated</code>. <code>clean</code> is true only when nothing is fabricated, deleted, or a made-up group.</p>
${curl(`curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' \\
  -d '{"text": "Patient typing: A*0101, B*15:504:01, DRB1*14:06. Assistant suggested DQB1*05:03:26:99 (DQB1*05:03:01G)."}'`)}
${curl(`{"release":"${m.release}","clean":false,
 "counts":{"valid":2,"deleted":1,"group":1,"fabricated_group":0,"hallucinated":1},
 "tokens":[{"token":"A*0101","status":"deleted","successor":"A*01:01:01:01","current_2field":"A*01:01",
            "g_group":"AMBIGUOUS","flags":["deprecated_name"],"note":"was assigned once, no longer current — see successor"},
           {"token":"DQB1*05:03:26:99","status":"hallucinated","note":"no such name in any release back to 1.05.0 — fabricated"}, …],
 "attribution":"Computed from IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Res 2025), …"}`)}

<h3><span class="pill">POST</span><code>/v1/normalize</code> — bring reported typings to the current release</h3>
<p>Any era: colon-less 1990s strings (<code>A*0101</code>, <code>Cw*0702</code>), deleted names, lower-resolution prefixes. Returns the current name, the comparable 2-field name (keeping an expression suffix only when every full-resolution allele shares it), the G group (<code>NONE</code> / <code>AMBIGUOUS</code>), and flags such as <code>deprecated_name</code>, <code>null_allele</code>, <code>nonexistent_allele</code>.</p>
${curl(`curl -s https://api.hlaverify.com/v1/normalize -H 'content-type: application/json' \\
  -d '{"typings": ["A*0101", "A*01:34N", "DRB1*1406", "A*24:09N", "B*9999"]}'`)}

<h3><span class="pill">GET</span><code>/v1/allele/{name}</code> — the facts for one name</h3>
<p><code>assigned</code> (G/P group, first release, confirmed status, WMDA serology, null flag), <code>valid_prefix</code> (member count and sample), or <code>deleted</code> (successor). 404 for anything not in the release.</p>
${curl(`curl -s 'https://api.hlaverify.com/v1/allele/A*24:09N'`)}

<h3><span class="pill">POST</span><code>/v1/match</code> — donor–recipient match verdict</h3>
<p>Two reported alleles per locus, any nomenclature era. Frameworks <code>6/6</code>, <code>8/8</code>, <code>10/10</code>, <code>12/12</code>, <code>antigen</code>. Counts per <em>chromosome</em>, not per locus; GvH and HvG mismatches reported separately; a locus whose typing is too coarse to call is <code>potential</code> and excluded from the denominator with <code>resolution_insufficient</code> — a confident count over unresolvable typing is itself the error. Null alleles hiding inside serologic matches (the A*24:09N trap) raise <code>null_allele_mismatch</code>. Rules R1–R6 are published in <a href="https://github.com/jasonbrelsford/verifiable-science-envs/blob/main/sci_envs/families/matching/rules.py">rules.py</a> for lab audit.</p>
${curl(`curl -s https://api.hlaverify.com/v1/match -H 'content-type: application/json' -d '{
  "framework": "8/8",
  "recipient": {"A": ["A*02:01", "A*24:02"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]},
  "donor":     {"A": ["A*02:01", "A*24:09N"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]}}'`)}
${curl(`{"release":"${m.release}","framework":"8/8","count":"7/8",
 "verdicts":{"A":"mismatch","B":"match","C":"match","DRB1":"match"},
 "hvg_mismatches":1,"gvh_mismatches":1,"flags":["null_allele"], "attribution":"…"}`)}

<h3><span class="pill">GET</span><code>/healthz</code></h3>
<p><code>{"ok":true,"release":"${esc(m.release)}","alleles":${m.alleles},"uptime_s":…}</code></p>

<h2>Integrating into a pipeline</h2>
<table>
<tr><th>Where</th><th>Call</th><th>Gate on</th></tr>
<tr><td>Typing report ingest (LIMS, HistoTrac/TIMS exports, PDF-to-text)</td><td><code>/v1/normalize</code> per reported allele</td><td><code>nonexistent_allele</code> → reject; <code>deprecated_name</code> → rewrite to <code>current_name</code> and log</td></tr>
<tr><td>Any LLM or agent output that mentions HLA</td><td><code>/v1/verify</code> on the text</td><td><code>clean == false</code> → block or annotate before display</td></tr>
<tr><td>Search / match reports</td><td><code>/v1/match</code> per pair</td><td>Compare with the lab's count; any <code>potential</code> or <code>null_allele*</code> flag routes to human review</td></tr>
<tr><td>Registry / data-warehouse QC</td><td><code>/v1/normalize</code> in batches of ≤5,000</td><td>Diff <code>reported</code> vs <code>current_name</code> per release</td></tr>
</table>
<p>Python (no HTTP): <code>pip install "verifiable-science-envs @ git+https://github.com/jasonbrelsford/verifiable-science-envs"</code>, then <code>from sci_envs.families.nomenclature.normalize import normalize</code> and <code>from sci_envs.families.matching.rules import score</code> — the same engine that computed these tables. Agents: MCP server <code>python -m sci_envs.mcp_server</code> with tools <code>verify_text</code>, <code>normalize_allele</code>, <code>match_score</code>; see <a href="https://hlaverify.com/llms.txt">llms.txt</a>.</p>

<h2>Release pinning</h2>
<p>This deployment is pinned to <b>${esc(m.release)}</b>; the tables were exported ${esc(m.exported_at)} from the release's own files (Allelelist, Deleted_alleles, Allelelist_history, hla_nom_g/p, rel_dna_ser). IPD-IMGT/HLA publishes quarterly; keyed customers receive a diff of changed verdicts before the pin moves, and an older release can be kept for a customer on request.</p>

<h2>Errors</h2>
<p>Errors are JSON <code>{"detail": "…"}</code>: 400 malformed JSON, 401 bad key, 404 unknown name or route, 415 wrong content type, 422 invalid input, 429 anonymous rate limit, 500 (nothing stored).</p>

<h2>Terms</h2>
<p class="mut">HLA-Verify is a research-and-evaluation tool and not a medical device; output supports and does not replace clinical judgement. Service code: PolyForm Noncommercial 1.0.0 — commercial use requires a licence from Brelsford Software LLC (<a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>). Reference data: IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Research 2025), CC-BY-ND, fetched from the official source and never redistributed in bulk. Requests are processed in memory and discarded; metering records counts per key, never content.</p>
</div></body></html>`;
}

export function openapi(m) {
  const attribution = { type: "string" };
  return {
    openapi: "3.1.0",
    info: { title: "HLA-Verify", version: "1.0.0",
      description: `Deterministic verification of HLA nomenclature and donor-recipient match claims against IPD-IMGT/HLA ${m.release}. No LLM; nothing stored.`,
      contact: { email: "hello@hlaverify.com", url: "https://hlaverify.com" } },
    servers: [{ url: "https://api.hlaverify.com" }, { url: "https://hlaverify.com" }],
    components: {
      securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      schemas: {
        Error: { type: "object", properties: { detail: { type: "string" } } },
        Typing: { type: "object", additionalProperties: { type: "array", items: { type: "string" }, maxItems: 4 },
          example: { A: ["A*02:01", "A*24:02"], B: ["B*07:02", "B*44:02"], C: ["C*07:02", "C*05:01"], DRB1: ["DRB1*15:01", "DRB1*04:01"] } },
      },
    },
    security: [{}, { ApiKey: [] }],
    paths: {
      "/healthz": { get: { summary: "Liveness and pinned release", responses: { 200: { description: "ok" } } } },
      "/v1/verify": { post: { summary: "Classify every allele-shaped token in free text",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"],
          properties: { text: { type: "string", maxLength: 200000 } } } } } },
        responses: { 200: { description: "verdicts", content: { "application/json": { schema: { type: "object", properties: {
          release: { type: "string" }, clean: { type: "boolean" },
          counts: { type: "object", additionalProperties: { type: "integer" } },
          tokens: { type: "array", items: { type: "object", properties: { token: { type: "string" },
            status: { type: "string", enum: ["valid", "group", "deleted", "fabricated_group", "hallucinated"] },
            note: { type: "string" }, successor: { type: "string" }, current_2field: { type: "string" },
            g_group: { type: "string" }, flags: { type: "array", items: { type: "string" } } } } },
          attribution } } } } }, 422: { description: "invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/v1/normalize": { post: { summary: "Normalize reported typings to the current release",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["typings"],
          properties: { typings: { type: "array", items: { type: "string" }, maxItems: 5000 } } } } } },
        responses: { 200: { description: "rows", content: { "application/json": { schema: { type: "object", properties: {
          release: { type: "string" }, rows: { type: "array", items: { type: "object", properties: {
            reported: { type: "string" }, current_name: { type: "string" }, allele_2field: { type: "string" },
            g_group: { type: "string" }, flags: { type: "array", items: { type: "string" } } } } }, attribution } } } } } } } },
      "/v1/allele/{name}": { get: { summary: "Facts for one allele, prefix, or deleted name",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, example: "A*24:09N" }],
        responses: { 200: { description: "assigned | valid_prefix | deleted" }, 404: { description: "not in this release" } } } },
      "/v1/match": { post: { summary: "Donor-recipient match verdict (rules R1-R6)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["recipient", "donor"],
          properties: { framework: { type: "string", enum: ["6/6", "8/8", "10/10", "12/12", "antigen"], default: "8/8" },
            recipient: { $ref: "#/components/schemas/Typing" }, donor: { $ref: "#/components/schemas/Typing" } } } } } },
        responses: { 200: { description: "verdict", content: { "application/json": { schema: { type: "object", properties: {
          release: { type: "string" }, framework: { type: "string" }, count: { type: "string", example: "7/8" },
          verdicts: { type: "object", additionalProperties: { type: "string", enum: ["match", "mismatch", "potential"] } },
          hvg_mismatches: { type: "integer" }, gvh_mismatches: { type: "integer" },
          flags: { type: "array", items: { type: "string" } }, attribution } } } } } } } },
    },
  };
}
