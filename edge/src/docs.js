// API reference page and OpenAPI document for api.hlaverify.com.
// The tier table on /docs and /pricing is generated from keys.js TIER_LIMITS,
// so the published limits and the enforced ones cannot drift apart.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { TIER_LIMITS } from "./keys.js";
import { MAX_TYPINGS } from "./handlers.js";

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const n = (v) => (v === null ? "uncapped" : v.toLocaleString("en-US"));
const CALLS = (t) => n(TIER_LIMITS[t].calls);
const TYPINGS = (t) => n(TIER_LIMITS[t].typings);

// One row per tier, shared by /docs and /pricing. `extra` renders the trailing
// cell (auth on /docs, the call to action on /pricing).
function tierRows(extra) {
  return Object.entries(TIER_LIMITS).map(([t, l]) =>
    `<tr><td><code>${t}</code></td><td>${n(l.calls)} calls/day</td><td>${n(l.typings)}</td><td>${esc(l.burst)}</td><td>${extra(t, l)}</td></tr>`).join("\n");
}

export function DOCS_HTML(m) {
  const curl = (s) => `<pre><code>${esc(s)}</code></pre>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify API — reference</title>
<meta name="description" content="Deterministic HLA nomenclature and donor-recipient matching verification API, pinned to IPD-IMGT/HLA ${esc(m.release)}. Allele names, not patient identifiers. No LLM, nothing stored.">
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
.beta{background:#DCEFDC;border-radius:10px;padding:12px 16px;margin:1.2em 0}
.send{background:#EEECE4;border-left:4px solid var(--green);border-radius:10px;padding:12px 16px;margin:1.2em 0}
</style></head><body><div class="wrap">
<nav><a href="https://hlaverify.com">hlaverify.com</a><a href="https://hlaverify.com/demo">in-browser demo</a><a href="/openapi.json">openapi.json</a><a href="https://github.com/jasonbrelsford/verifiable-science-envs">source &amp; benchmark</a></nav>
<h1>HLA-Verify API</h1>
<p class="mut">Base URL <code>https://api.hlaverify.com</code> (also <code>https://hlaverify.com/v1/…</code>). Pinned to IPD-IMGT/HLA <b>${esc(m.release)}</b> — ${m.alleles.toLocaleString()} named alleles. Every response carries the release and the attribution line. No LLM anywhere; nothing you send is stored.</p>
<p class="send"><b>What to send.</b> HLA-Verify checks allele nomenclature, typing-report consistency and match arithmetic against a pinned IPD-IMGT/HLA release. Send <b>allele names, typing strings, GL strings and report text about HLA typing</b>. Do not send patient identifiers: no names, medical record numbers, dates of birth, accession or case identifiers, or other patient details. The service neither needs nor wants them, request bodies are processed in memory and never stored, and de-identifying before you send is the caller's responsibility. This is a nomenclature and reference-release checker: not a diagnostic aid, not clinical decision support, and it does not recommend a donor.</p>
<p class="beta"><b>Free public beta.</b> Verdicts are production-quality and pinned to IPD-IMGT/HLA ${esc(m.release)} — the beta is about pricing and limits, not about correctness. Anonymous access stays open with no key, at ${CALLS("free")} calls a day per IP and 60 requests/minute. Paid keys with higher rate limits arrive within days: <a href="https://hlaverify.com/beta">join the list</a> to be notified (or <code>POST /v1/beta-signup</code>), or email <a href="mailto:hello@hlaverify.com?subject=HLA-Verify%20beta%20key">hello@hlaverify.com</a> for a beta key now.</p>

<h2>Authentication and limits</h2>
<p>Without a key the API is open for evaluation at <b>${CALLS("free")} calls a day per IP</b>, 60 requests per minute. Labs, LIMS vendors and agent platforms get a key (header <code>X-API-Key: …</code> or <code>Authorization: Bearer …</code>) with a higher or uncapped daily quota, larger batches, per-key usage reporting, and a release-change notice before each quarterly IPD-IMGT/HLA update. Keys: <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>
<table>
<tr><th>Tier</th><th>Calls/day</th><th>Typings per <code>/v1/normalize</code> call</th><th>Burst</th><th>Auth</th></tr>
${tierRows((t) => (t === "free" ? "none (anonymous)" : "API key"))}
</table>
<p class="mut"><code>pro</code> is the former name of <code>lab</code>. Keys issued as <code>pro</code> keep working and get Lab's limits; they still report <code>x-hla-verify-tier: pro</code>.</p>
<h3>Daily quotas</h3>
<p>Calls are counted per <b>UTC day</b> — the quota resets at 00:00 UTC, no rolling window, no proration. A key is counted per key (an OAuth token on <code>/mcp</code> counts against the key behind it); an anonymous caller is counted per IP, and the IP is never stored — the counter is addressed by a SHA-256 digest of the day and the address, which changes at midnight. Every billable response carries the count:</p>
<table>
<tr><th>Header</th><th>Meaning</th></tr>
<tr><td><code>x-hla-verify-tier</code></td><td>The tier this call was served at.</td></tr>
<tr><td><code>x-hla-verify-daily-limit</code></td><td>Calls per UTC day, or <code>unlimited</code>.</td></tr>
<tr><td><code>x-hla-verify-daily-remaining</code></td><td>Calls left today. <code>unknown</code> on the rare occasion the counter is unreachable — the call is served anyway.</td></tr>
<tr><td><code>x-hla-verify-daily-reset</code></td><td>ISO-8601 timestamp of the next UTC midnight.</td></tr>
<tr><td><code>x-hla-verify-max-typings</code></td><td>Your tier's cap on <code>typings</code> in one <code>/v1/normalize</code> call.</td></tr>
</table>
<p>Over quota is <code>429</code> with the usual <code>{"detail": "…"}</code>, naming the tier, the limit, the reset time and where to upgrade, plus <code>Retry-After</code> in seconds. Over your tier's batch cap is <code>422</code>, naming the cap and the tier that lifts it — split the batch or upgrade. <b>What does not consume quota:</b> <code>/healthz</code>, <code>/docs</code>, <code>/openapi.json</code>, <code>/pricing</code>, <code>/checkout/success</code>, <code>/v1/beta-signup</code>, the OAuth and <code>.well-known</code> routes, the Stripe webhook, and on <code>/mcp</code> everything that is not a tool call plus the <code>about</code> and <code>beta_signup</code> tools. <code>text</code> on <code>/v1/verify</code> stays capped at 200,000 characters for every tier, including free.</p>
<h3>Keys during the beta</h3>
<p>Self-serve checkout is not open yet. Beta keys are issued by hand at a paid tier's limit, free for the duration of the beta — email <a href="mailto:hello@hlaverify.com?subject=HLA-Verify%20beta%20key">hello@hlaverify.com</a> with roughly what you're calling and how often, or <a href="https://hlaverify.com/beta">join the list</a> to be told when checkout opens. The rest of this section describes how self-serve will work when it does.</p>
<h3>Self-serve keys</h3>
<p>Starter and Pro keys are issued automatically through Stripe: buy on the <a href="/pricing">pricing page</a>, and Stripe's webhook creates an active key in the same store the API reads at request time — usually ready within a few seconds of payment, no manual provisioning. The key is shown once on the checkout success page and is also written to your Stripe customer record (visible in your receipts and the Stripe customer portal). Cancelling or letting a subscription lapse in the <a href="/pricing">Stripe customer portal</a> revokes the key the same way. If self-serve checkout isn't live yet for your account, or you need an <code>enterprise</code> key, email <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>

<h2>Endpoints</h2>
<h3><span class="pill">POST</span><code>/v1/verify</code> — check every allele-shaped token in free text</h3>
<p>Send HLA typing report text or a model's answer about HLA, with patient identifiers removed first. Every token that looks like an allele is classified: <code>valid</code>, <code>group</code> (G/P), <code>deleted</code> (with successor), <code>fabricated_group</code>, or <code>hallucinated</code>. <code>clean</code> is true only when nothing is fabricated, deleted, or a made-up group.</p>
${curl(`curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' \\
  -d '{"text": "Reported typing: A*0101, B*15:504:01, DRB1*14:06. Assistant suggested DQB1*05:03:26:99 (DQB1*05:03:01G)."}'`)}
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
<p><code>assigned</code> (G/P group, first release, confirmed status, WMDA serology, null flag), <code>valid_prefix</code> (member count and sample), or <code>deleted</code> (successor). 404 for anything not in the release. Class I (A/B/C) names carry a trailing <code>ligands</code> object: expression, the -21 leader residue (<code>leader_21</code>: M/T, Petersdorf 2020), Bw4/Bw6 (<code>bw</code>), the C1/C2 epitope (<code>c_group</code>), and the aggregate <code>kir_ligand</code> class, each aggregated over the name's members with an <code>ambiguities</code> map when they disagree.</p>
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

<h3><span class="pill">POST</span><code>/v1/typing/check</code> — QC one typing (all loci)</h3>
<p>Lab Toolkit. <code>{"typing": {"A": [...], "B": [...], "DRB1": [...], ...}}</code>, any nomenclature era, up to 4 reported alleles per locus. Resolves every reported string, flags <code>unresolvable</code> / <code>deprecated_name</code> / <code>locus_mismatch</code> / <code>null_allele</code> per allele and <code>too_many_alleles</code> / <code>single_allele</code> / <code>homozygous</code> per locus, and returns a <code>profile</code> (B-leader -21 M/T genotype, C KIR-ligand genotype, KIR ligands present, and whether the A/B/C typing is complete enough for a confident KIR-ligand call) plus a <code>drb345</code> expected-vs-reported block when a DRB1 key is present. Units metered = total reported strings.</p>
${curl(`curl -s https://api.hlaverify.com/v1/typing/check -H 'content-type: application/json' -d '{
  "typing": {"A": ["A*02:01"], "B": ["B*07:02", "B*46:01"], "C": ["C*07:02", "C*01:02"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]}}'`)}

<h3><span class="pill">POST</span><code>/v1/compat</code> — donor/recipient immunogenetic compatibility</h3>
<p>Lab Toolkit. <code>{"recipient": typing, "donor": typing}</code> (each shaped as in <code>/v1/typing/check</code>). Two published models, each run over the full typing QC on both sides: HLA-B leader match (-21 M/T; Petersdorf 2020, <em>Blood</em>) for a single HLA-B mismatch, and KIR ligand (C1/C2/Bw4) class comparison, which requires complete A, B and C typing. <b>Decision support only; not a medical device.</b> Units metered = total reported strings on both sides.</p>
${curl(`curl -s https://api.hlaverify.com/v1/compat -H 'content-type: application/json' -d '{
  "recipient": {"B": ["B*07:02", "B*44:02"]}, "donor": {"B": ["B*07:02", "B*44:03"]}}'`)}

<h3><span class="pill">POST</span><code>/v1/glstring</code> — GL String validation and normalization</h3>
<p>Lab Toolkit. <code>{"gl": "A*01:01/A*02:01+A*03:01~B*07:02"}</code> — the <code>^</code> locus-block / <code>|</code> genotype-list / <code>+</code> genotype / <code>~</code> haplotype / <code>/</code> allele-list grammar, up to 5,000 allele tokens. Resolves and renames every allele token and flags structural problems (<code>mixed_locus_allele_list</code>, <code>haplotype_repeats_locus</code>, <code>more_than_two_haplotypes</code>, <code>genotype_loci_differ</code>, <code>genotype_list_loci_differ</code>, <code>locus_repeated_across_blocks</code>, <code>empty_element</code>, <code>whitespace_in_name</code>), returning a normalized string with outdated names rewritten to current. Units metered = allele token count (including empty slots from a doubled separator).</p>
${curl(`curl -s https://api.hlaverify.com/v1/glstring -H 'content-type: application/json' -d '{"gl": "A*0101+A*02:01"}'`)}

<h3><span class="pill">POST</span><code>/v1/beta-signup</code> — join the beta list for paid keys</h3>
<p><code>{"email": "you@lab.example", "org": "…", "use_case": "…", "source": "…"}</code> — only <code>email</code> is required; <code>org</code> (≤120 chars), <code>use_case</code> (≤500) and <code>source</code> (≤120, a free-text hint such as <code>site</code>, <code>mcp</code> or <code>docs</code>) are optional. Returns <code>{"ok":true,"status":"recorded"|"already_recorded","message":"…","release":"${esc(m.release)}"}</code>; signing the same address twice is not an error and does not create a second record. Rejections are the usual <code>{"detail": "…"}</code>: 422 for an address that doesn't look like one or a field over its cap. We store the address, the optional fields, a timestamp and the <code>CF-IPCountry</code> of the request — no IP address, nothing else, and the record is not an API key. Need a higher limit today? Email <a href="mailto:hello@hlaverify.com?subject=HLA-Verify%20beta%20key">hello@hlaverify.com</a> for a beta key.</p>
${curl(`curl -s https://api.hlaverify.com/v1/beta-signup -H 'content-type: application/json' \\
  -d '{"email": "you@lab.example", "org": "Example HLA Lab", "use_case": "LIMS ingest QC", "source": "docs"}'`)}

<h3><span class="pill">GET</span><code>/healthz</code></h3>
<p><code>{"ok":true,"release":"${esc(m.release)}","alleles":${m.alleles},"uptime_s":…}</code></p>

<h2>MCP for agents</h2>
<p>A remote MCP server lives at <code>POST /mcp</code> (Streamable HTTP transport, JSON-RPC 2.0, stateless — one JSON response per call, no session to manage). It exposes the same deterministic lookups as the REST API as tools: <code>verify_text</code>, <code>normalize_allele</code>, <code>allele_info</code>, <code>match_score</code>, <code>check_typing</code>, <code>donor_compat</code>, <code>validate_gl_string</code>, <code>about</code>, plus <code>beta_signup</code>, the one tool that writes (it joins the beta list, as the endpoint above does). Results are byte-identical to the matching <code>/v1/…</code> response because both run the same code underneath. <code>donor_compat</code> is decision support only; not a medical device. The same input rule applies as on REST: send allele names, typing strings, GL strings and HLA report text, never patient identifiers. Anonymous access shares the free tier's ${CALLS("free")} calls a day and 60 req/min; an API key on <code>/mcp</code> gets the same tier, daily quota and batch cap as on REST. A tool call over quota comes back on HTTP 200 as an ordinary tool result with <code>isError:true</code> and a message naming the reset time, with <code>x-hla-verify-daily-remaining: 0</code> and <code>Retry-After</code> on the response: MCP clients treat a non-2xx POST as a transport failure and never read the frame, so the refusal is sent the one way an agent actually sees it. REST keeps its 429.</p>
<p>Protocol versions: <code>2026-07-28</code> (stateless — call <code>server/discover</code> for versions, capabilities and instructions; send the <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code> and, for <code>tools/call</code>, <code>Mcp-Name</code> headers) and, through the <code>initialize</code> handshake, <code>2025-11-25</code>, <code>2025-06-18</code>, <code>2025-03-26</code> and <code>2024-11-05</code>. Clients that support both, such as the Cloudflare Agents SDK, pick the newest automatically.</p>
<p>Discovery before connecting: an MCP Server Card (SEP-2127) at <a href="/mcp/server-card"><code>GET /mcp/server-card</code></a> (also <code>/.well-known/mcp/server-card.json</code>) gives name, version, endpoint, headers and protocol versions without a handshake, and <a href="/.well-known/ai-catalog.json"><code>/.well-known/ai-catalog.json</code></a> lists it for domain-level crawlers. Tools are not in the card — call <code>tools/list</code>. The repository's <code>server.json</code> describes the same server (<code>com.hlaverify/hla-verify</code>) for the official MCP Registry.</p>
<h3>Claude Desktop / claude.ai connectors</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}`)}
<h3>Claude Desktop / claude.ai, with a key</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp",
  "headers": {"Authorization": "Bearer YOUR_KEY"}}}}`)}
<h3>Cursor (<code>.cursor/mcp.json</code>)</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}`)}
<p class="mut">Prefer a local process instead? <code>python -m sci_envs.mcp_server</code> serves the same tools over stdio except <code>allele_info</code> — see <a href="https://hlaverify.com/llms.txt">llms.txt</a>.</p>

<h2>Integrating into a pipeline</h2>
<table>
<tr><th>Where</th><th>Call</th><th>Gate on</th></tr>
<tr><td>Typing report ingest (LIMS, HistoTrac/TIMS exports, PDF-to-text)</td><td><code>/v1/normalize</code> per reported allele</td><td><code>nonexistent_allele</code> → reject; <code>deprecated_name</code> → rewrite to <code>current_name</code> and log</td></tr>
<tr><td>Any LLM or agent output that mentions HLA</td><td><code>/v1/verify</code> on the text</td><td><code>clean == false</code> → block or annotate before display</td></tr>
<tr><td>Search / match reports</td><td><code>/v1/match</code> per pair</td><td>Compare with the lab's count; any <code>potential</code> or <code>null_allele*</code> flag routes to human review</td></tr>
<tr><td>Registry / data-warehouse QC</td><td><code>/v1/normalize</code> in batches up to your tier's cap (<code>x-hla-verify-max-typings</code>)</td><td>Diff <code>reported</code> vs <code>current_name</code> per release</td></tr>
</table>
<p>Python (no HTTP): <code>pip install "verifiable-science-envs @ git+https://github.com/jasonbrelsford/verifiable-science-envs"</code>, then <code>from sci_envs.families.nomenclature.normalize import normalize</code> and <code>from sci_envs.families.matching.rules import score</code> — the same engine that computed these tables. Agents: MCP server <code>python -m sci_envs.mcp_server</code> with tools <code>verify_text</code>, <code>normalize_allele</code>, <code>match_score</code>, <code>check_typing</code>, <code>donor_compat</code>, <code>validate_gl_string</code>, <code>about</code>; see <a href="https://hlaverify.com/llms.txt">llms.txt</a>.</p>

<h2>Release pinning</h2>
<p>This deployment is pinned to <b>${esc(m.release)}</b>; the tables were exported ${esc(m.exported_at)} from the release's own files (Allelelist, Deleted_alleles, Allelelist_history, hla_nom_g/p, rel_dna_ser). IPD-IMGT/HLA publishes quarterly; keyed customers receive a diff of changed verdicts before the pin moves, and an older release can be kept for a customer on request.</p>

<h2>Errors</h2>
<p>Errors are JSON <code>{"detail": "…"}</code>: 400 malformed JSON, 401 missing/invalid/revoked key, 404 unknown name or route, 415 wrong content type, 422 invalid input, 429 rate limited or daily quota exhausted (tier-specific, with <code>Retry-After</code>), 500 (nothing stored). MCP <code>tools/call</code> validation failures are not HTTP or JSON-RPC errors — they come back as a normal tool result with <code>isError:true</code> and an explanatory text block, per the MCP spec.</p>

<h2>Terms</h2>
<p class="mut">HLA-Verify validates HLA nomenclature and match arithmetic against a pinned reference release. It is a research-and-evaluation tool and not a medical device; it is not clinical decision support, and output supports and does not replace clinical judgement. Send allele names and HLA report text only: the service is not designed to receive protected health information, does not need patient identifiers, and de-identifying input before sending is the caller's responsibility. Service code: PolyForm Noncommercial 1.0.0 — commercial use requires a licence from Brelsford Software LLC (<a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>). Reference data: IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Research 2025), CC-BY-ND, fetched from the official source and never redistributed in bulk. Requests are processed in memory and discarded; metering records counts per key, never content.</p>
</div></body></html>`;
}

// /pricing — plain HTML, same styling as DOCS_HTML.
//
// FREE PUBLIC BETA (2026-09): the paid cells show a "Join the beta list" call to
// action instead of the Stripe checkout buttons, because the Payment Links are
// still Stripe TEST links and cannot take real money. The tiers and their limits
// stay visible — the prices are real, only the checkout is not.
//
// TO RESTORE THE BUTTONS when Stripe goes live: put the LIVE Payment Links in
// STRIPE_STARTER_LINK / STRIPE_PRO_LINK (edge/wrangler.jsonc), then swap the
// `betaCta` cells in the table below back to `buy(starterLink, "Buy Starter")`
// and `buy(proLink, "Buy Lab")`. Nothing else here or in stripe.js changed; the
// `buy` helper and both link vars are kept wired for exactly that swap.
export function PRICING_HTML(m, { starterLink, proLink } = {}) {
  const buy = (link, label) =>
    link ? `<a class="btn" href="${esc(link)}">${esc(label)}</a>` : `<span class="btn mut" aria-disabled="true">coming soon</span>`;
  const betaCta = `<a class="btn" href="https://hlaverify.com/beta">Join the beta list</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify — pricing</title>
<meta name="description" content="HLA-Verify API pricing during the free public beta: open at ${CALLS("free")} calls a day per IP, paid Starter, Lab and Scale keys within days, Enterprise by request.">
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:28px 22px 60px}
h1{font-family:Georgia,serif;font-size:2rem;margin:.2em 0}
table{border-collapse:collapse;width:100%;font-size:.93rem;margin-top:1.2em}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
a{color:var(--green)}.mut{color:var(--mut)}nav a{margin-right:14px}
.btn{display:inline-block;background:var(--green);color:#fff;border-radius:8px;padding:8px 16px;text-decoration:none;font-weight:600}
.btn.mut{background:#EEECE4;color:var(--mut)}
.beta{background:#DCEFDC;border-radius:10px;padding:12px 16px;margin-top:1.2em}
</style></head><body><div class="wrap">
<nav><a href="/docs">API reference</a><a href="https://hlaverify.com">hlaverify.com</a></nav>
<h1>Pricing</h1>
<p class="beta"><b>Free public beta.</b> Verdicts are production-quality and pinned to IPD-IMGT/HLA ${esc(m.release)}. Paid keys with higher daily quotas arrive within days — <a href="https://hlaverify.com/beta">join the list</a> to be notified, or email <a href="mailto:hello@hlaverify.com?subject=HLA-Verify%20beta%20key">hello@hlaverify.com</a> for a beta key now.</p>
<p class="mut">Every tier hits the same deterministic API, pinned to IPD-IMGT/HLA ${esc(m.release)}. Prices and billing period are set at checkout; cancel anytime from the Stripe customer portal link in your receipt.</p>
<table>
<tr><th>Tier</th><th>Price</th><th>Calls/day</th><th>Typings per <code>/v1/normalize</code> call</th><th>Burst</th><th></th></tr>
<tr><td><b>Free</b></td><td>free, no key</td><td>${CALLS("free")} per IP</td><td>${TYPINGS("free")}</td><td>60/min</td><td class="mut">just start calling the API</td></tr>
<tr><td><b>Starter</b></td><td>$49/mo</td><td>${CALLS("starter")}</td><td>${TYPINGS("starter")}</td><td>60/min</td><td>${betaCta}</td></tr>
<tr><td><b>Lab</b></td><td>$299/mo</td><td>${CALLS("lab")}</td><td>${TYPINGS("lab")}</td><td>600/min</td><td>${betaCta}</td></tr>
<tr><td><b>Scale</b></td><td>$1,999/mo</td><td>${CALLS("scale")}</td><td>${TYPINGS("scale")}</td><td>6,000/min</td><td>${betaCta}</td></tr>
<tr><td><b>Enterprise</b></td><td>custom</td><td>uncapped</td><td>${TYPINGS("enterprise")}</td><td>uncapped</td><td><a class="btn" href="mailto:hello@hlaverify.com?subject=HLA-Verify%20Enterprise">Contact us</a></td></tr>
<tr><td><b>Research</b></td><td>free with approval</td><td colspan="3">hlaverify.com/research</td><td><a class="btn" href="https://hlaverify.com/research">hlaverify.com/research</a></td></tr>
</table>
<p class="mut">Calls are counted per <b>UTC day</b> and reset at 00:00 UTC; every billable response tells you where you stand in <code>x-hla-verify-daily-limit</code>, <code>-daily-remaining</code> and <code>-daily-reset</code>. The endpoints are batched, so the second number matters as much as the first: one <code>/v1/normalize</code> call carries up to your tier's cap of typings. <code>/healthz</code>, <code>/docs</code>, <code>/pricing</code> and <code>/v1/beta-signup</code> are free and never counted, and <code>/v1/verify</code> accepts 200,000 characters of text on every tier including Free. <code>Lab</code> was called <code>pro</code> before 2026-09: existing <code>pro</code> keys keep working at Lab's limits.</p>
<p class="mut" style="margin-top:2em">Self-serve checkout opens when the beta ends: you'll land on a success page showing your API key once — copy it then, it is also written to your Stripe customer record. Until then, beta keys are issued by hand — email <a href="mailto:hello@hlaverify.com?subject=HLA-Verify%20beta%20key">hello@hlaverify.com</a> and say roughly what you're calling and how often. Full endpoint reference: <a href="/docs">/docs</a>.</p>
</div></body></html>`;
}

// GET /checkout/success?session_id=... — shown right after Stripe redirects
// back. `result` is resolveCheckoutSuccess()'s return value from stripe.js:
// {status:"ok",key,tier,label} | {status:"pending"} | {status:"not_found"} | {status:"no_secret"}.
export function CHECKOUT_SUCCESS_HTML(m, result = {}) {
  const body = (() => {
    if (result.status === "ok") {
      return `<p class="pill">Payment received</p>
<h2>Your HLA-Verify API key</h2>
<pre><code>${esc(result.key)}</code></pre>
<p>Tier: <b>${esc(result.tier || "starter")}</b>. This key is shown <b>once</b> — copy it now. It is also saved to your Stripe customer record (visible in your receipt email and the Stripe customer portal) if you ever need to look it up again.</p>
<h3>Use it</h3>
<pre><code>curl -s https://api.hlaverify.com/v1/allele/A*01:01 -H 'X-API-Key: ${esc(result.key)}'</code></pre>
<pre><code>{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp",
  "headers": {"Authorization": "Bearer ${esc(result.key)}"}}}}</code></pre>
<p class="mut">Full reference: <a href="/docs">/docs</a>. Cancel anytime from the customer portal link in your receipt — that revokes this key.</p>`;
    }
    if (result.status === "pending") {
      return `<p class="pill">Payment received</p><h2>Issuing your key…</h2>
<p>Your payment went through, but the key isn't in our store quite yet (webhook lag, usually a few seconds). <a href="javascript:location.reload()">Refresh in a few seconds</a>. If this page still doesn't show a key after a minute or two, email <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a> with your receipt.</p>`;
    }
    if (result.status === "no_secret") {
      return `<h2>Checkout received</h2><p>Payment confirmation isn't wired up on this deployment yet. Your key will still be issued by the webhook — check your email receipt from Stripe, or email <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>`;
    }
    return `<h2>We couldn't confirm this checkout</h2><p>Either the session id is missing/invalid, or payment hasn't completed yet. If you just paid, check your email receipt, or email <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>`;
  })();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify — checkout</title>
<meta name="robots" content="noindex">
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:680px;margin:0 auto;padding:28px 22px 60px}
h2{font-family:Georgia,serif;color:var(--green)}
pre{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:13px;line-height:1.5}pre code{background:none;padding:0}
.pill{display:inline-block;background:#DCEFDC;color:var(--green);border-radius:999px;padding:2px 10px;font-size:.8rem;font-weight:600}
a{color:var(--green)}.mut{color:var(--mut)}
</style></head><body><div class="wrap">
${body}
</div></body></html>`;
}

export function openapi(m) {
  const attribution = { type: "string" };
  return {
    openapi: "3.1.0",
    info: { title: "HLA-Verify", version: "1.0.0",
      description: `Deterministic validation of HLA nomenclature and donor-recipient match arithmetic against IPD-IMGT/HLA ${m.release}. No LLM; nothing stored. ` +
        "What to send: allele names, typing strings, GL strings and report text about HLA typing. What never to send: patient identifiers of any kind " +
        "(names, medical record numbers, dates of birth, accession or case identifiers, other patient details). The service neither needs nor wants them, " +
        "request bodies are processed in memory and never stored, and de-identifying before sending is the caller's responsibility. " +
        "This is a nomenclature and reference-release checker: not a diagnostic aid, not clinical decision support, and it does not recommend a donor. " +
        `Limits are a daily call quota plus a per-call batch cap, both per tier: free ${CALLS("free")} calls/day per IP and ${TYPINGS("free")} typings per /v1/normalize call, ` +
        `starter ${CALLS("starter")}/${TYPINGS("starter")}, lab ${CALLS("lab")}/${TYPINGS("lab")}, scale ${CALLS("scale")}/${TYPINGS("scale")}, enterprise uncapped/${TYPINGS("enterprise")}; ` +
        "'pro' is the legacy name for 'lab'. Quotas reset at UTC midnight and every billable response carries x-hla-verify-daily-limit, -daily-remaining, -daily-reset and -max-typings. " +
        "/healthz, /docs, /openapi.json, /pricing and /v1/beta-signup are not billable. " +
        "Free public beta: verdicts are production-quality and anonymous access stays open; paid keys with higher quotas arrive within days " +
        "(join the list at https://hlaverify.com/beta or POST /v1/beta-signup, or email hello@hlaverify.com for a beta key now).",
      contact: { email: "hello@hlaverify.com", url: "https://hlaverify.com" } },
    servers: [{ url: "https://api.hlaverify.com" }, { url: "https://hlaverify.com" }],
    components: {
      securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      schemas: {
        Error: { type: "object", properties: { detail: { type: "string" } } },
        Typing: { type: "object",
          description: "locus -> up to 4 reported allele names. Allele strings only: never patient names, medical record numbers, dates of birth, or accession or case identifiers.",
          additionalProperties: { type: "array", items: { type: "string" }, maxItems: 4 },
          example: { A: ["A*02:01", "A*24:02"], B: ["B*07:02", "B*44:02"], C: ["C*07:02", "C*05:01"], DRB1: ["DRB1*15:01", "DRB1*04:01"] } },
      },
    },
    security: [{}, { ApiKey: [] }],
    paths: {
      "/healthz": { get: { summary: "Liveness and pinned release", responses: { 200: { description: "ok" } } } },
      "/v1/verify": { post: { summary: "Classify every allele-shaped token in HLA report text or model output",
        description: "Nomenclature checking against the pinned release, not interpretation of a case. Send HLA typing report text or model output about HLA typing " +
          "with patient identifiers removed first: no names, medical record numbers, dates of birth, accession or case identifiers, or other patient details. " +
          "The service neither needs nor wants them and does not store request bodies; de-identifying is the caller's responsibility.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"],
          properties: { text: { type: "string", maxLength: 200000,
            description: "HLA typing report text, or model output about HLA typing, to scan for allele names. Allele names and HLA content only, never patient identifiers." } } } } } },
        responses: { 200: { description: "verdicts", content: { "application/json": { schema: { type: "object", properties: {
          release: { type: "string" }, clean: { type: "boolean" },
          counts: { type: "object", additionalProperties: { type: "integer" } },
          tokens: { type: "array", items: { type: "object", properties: { token: { type: "string" },
            status: { type: "string", enum: ["valid", "group", "deleted", "fabricated_group", "hallucinated"] },
            note: { type: "string" }, successor: { type: "string" }, current_2field: { type: "string" },
            g_group: { type: "string" }, flags: { type: "array", items: { type: "string" } } } } },
          attribution } } } } }, 422: { description: "invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/v1/normalize": { post: { summary: "Normalize reported typings to the current release",
        description: `maxItems is the ceiling. The cap that applies to a request is the caller's tier's (` +
          Object.entries(TIER_LIMITS).map(([t, l]) => `${t} ${n(l.typings)}`).join(", ") +
          "), reported on every response as x-hla-verify-max-typings; a batch over it is a 422 naming the cap and the tier that lifts it.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["typings"],
          properties: { typings: { type: "array", items: { type: "string" }, maxItems: MAX_TYPINGS } } } } } },
        responses: { 200: { description: "rows", content: { "application/json": { schema: { type: "object", properties: {
          release: { type: "string" }, rows: { type: "array", items: { type: "object", properties: {
            reported: { type: "string" }, current_name: { type: "string" }, allele_2field: { type: "string" },
            g_group: { type: "string" }, flags: { type: "array", items: { type: "string" } } } } }, attribution } } } } } } } },
      "/v1/allele/{name}": { get: { summary: "Facts for one allele, prefix, or deleted name",
        description: "Class I (A/B/C) names carry a trailing 'ligands' object (leader_21, bw, c_group, kir_ligand; see /v1/typing/check).",
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
      "/v1/typing/check": { post: { summary: "QC-check one HLA typing (all loci): resolution, renames, locus mismatches, null alleles, B-leader/KIR-ligand profile, DRB3/4/5",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["typing"],
          properties: { typing: { $ref: "#/components/schemas/Typing" } } } } } },
        responses: { 200: { description: "release, valid, loci, issues, counts, profile, drb345, attribution" },
          422: { description: "invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/v1/compat": { post: { summary: "Donor/recipient immunogenetic compatibility: HLA-B leader (Petersdorf 2020) and KIR ligand (C1/C2/Bw4). Decision support only; not a medical device.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["recipient", "donor"],
          properties: { recipient: { $ref: "#/components/schemas/Typing" }, donor: { $ref: "#/components/schemas/Typing" } } } } } },
        responses: { 200: { description: "release, b_leader, kir_ligands, recipient_valid, donor_valid, issues, attribution" },
          422: { description: "invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/v1/glstring": { post: { summary: "Validate and normalize a GL String (^ | + ~ / grammar)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["gl"],
          properties: { gl: { type: "string", maxLength: 100000 } } } } } },
        responses: { 200: { description: "release, valid, normalized_gl, changed, loci, alleles, issues, counts, attribution" },
          422: { description: "invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/v1/beta-signup": { post: { summary: "Join the free public beta's list for paid API keys",
        description: "Records one address per beta list entry; re-submitting the same address returns already_recorded rather than failing. Stores the address, the optional fields, a timestamp and CF-IPCountry — no IP address. The record is not an API key and cannot be used as one.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"],
          properties: { email: { type: "string", maxLength: 254, example: "you@lab.example" },
            org: { type: "string", maxLength: 120 }, use_case: { type: "string", maxLength: 500 },
            source: { type: "string", maxLength: 120, description: "Free-text hint: site, mcp, docs." } } } } } },
        responses: { 200: { description: "recorded or already_recorded", content: { "application/json": { schema: { type: "object",
          required: ["ok", "status", "message", "release"],
          properties: { ok: { type: "boolean" }, status: { type: "string", enum: ["recorded", "already_recorded"] },
            message: { type: "string" }, release: { type: "string" } } } } } },
          422: { description: "invalid email or an oversized field", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: { description: "rate limited (60 req/min per IP; /v1/beta-signup does not consume daily quota)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/mcp": { post: { summary: "Remote MCP endpoint (Streamable HTTP transport, JSON-RPC 2.0, stateless)",
        description: "Tools: verify_text, normalize_allele, allele_info, match_score, check_typing, donor_compat, validate_gl_string, beta_signup, about. " +
          "Every tool call but about and beta_signup consumes one call of the caller's daily quota, the same one /v1/* spends. donor_compat is decision support only; not a medical device. beta_signup is the only tool that writes. Same input rule as REST: send allele names, typing strings, GL strings and HLA report text, never patient identifiers. See the MCP for agents section above.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object",
          required: ["jsonrpc", "method"],
          properties: { jsonrpc: { type: "string", enum: ["2.0"] }, id: {}, method: { type: "string" }, params: { type: "object" } } } } } },
        responses: { 200: { description: "JSON-RPC 2.0 response or error" }, 202: { description: "notification acknowledged (no body)" },
          405: { description: "GET not supported" },
          429: { description: "rate limited (per-minute burst). A spent DAILY quota is not a 429 here: it is a 200 JSON-RPC result whose tool result has isError:true and names the UTC-midnight reset, with x-hla-verify-daily-remaining: 0 and Retry-After on the response." } } } },
    },
  };
}
