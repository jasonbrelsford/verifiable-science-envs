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
<p>Without a key the API is open for evaluation at <b>60 requests per minute per IP</b>. Labs, LIMS vendors and agent platforms get a key (header <code>X-API-Key: …</code> or <code>Authorization: Bearer …</code>) with a higher or uncapped per-minute limit, per-key usage reporting, and a release-change notice before each quarterly IPD-IMGT/HLA update. Every response carries <code>x-hla-verify-tier</code>. Keys: <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>
<table>
<tr><th>Tier</th><th>Limit</th><th>Auth</th></tr>
<tr><td><code>free</code></td><td>60 req/min per IP</td><td>none (anonymous)</td></tr>
<tr><td><code>starter</code></td><td>600 req/min per key</td><td>API key</td></tr>
<tr><td><code>pro</code></td><td>6,000 req/min per key</td><td>API key</td></tr>
<tr><td><code>enterprise</code></td><td>uncapped</td><td>API key</td></tr>
</table>
<h3>Self-serve keys</h3>
<p>Starter and Pro keys are issued automatically through Stripe: buy on the <a href="/pricing">pricing page</a>, and Stripe's webhook creates an active key in the same store the API reads at request time — usually ready within a few seconds of payment, no manual provisioning. The key is shown once on the checkout success page and is also written to your Stripe customer record (visible in your receipts and the Stripe customer portal). Cancelling or letting a subscription lapse in the <a href="/pricing">Stripe customer portal</a> revokes the key the same way. If self-serve checkout isn't live yet for your account, or you need an <code>enterprise</code> key, email <a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>.</p>

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

<h3><span class="pill">GET</span><code>/healthz</code></h3>
<p><code>{"ok":true,"release":"${esc(m.release)}","alleles":${m.alleles},"uptime_s":…}</code></p>

<h2>MCP for agents</h2>
<p>A remote MCP server lives at <code>POST /mcp</code> (Streamable HTTP transport, JSON-RPC 2.0, stateless — one JSON response per call, no session to manage). It exposes the same deterministic lookups as the REST API as tools: <code>verify_text</code>, <code>normalize_allele</code>, <code>allele_info</code>, <code>match_score</code>, <code>check_typing</code>, <code>donor_compat</code>, <code>validate_gl_string</code>, <code>about</code>. Results are byte-identical to the matching <code>/v1/…</code> response because both run the same code underneath. <code>donor_compat</code> is decision support only; not a medical device. Anonymous access shares the free tier's 60 req/min; an API key on <code>/mcp</code> gets the same tier as on REST.</p>
<h3>Claude Desktop / claude.ai connectors</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}`)}
<h3>Claude Desktop / claude.ai, with a key</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp",
  "headers": {"Authorization": "Bearer YOUR_KEY"}}}}`)}
<h3>Cursor (<code>.cursor/mcp.json</code>)</h3>
${curl(`{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}`)}
<p class="mut">Prefer a local process instead? <code>python -m sci_envs.mcp_server</code> is the same tool surface over stdio — see <a href="https://hlaverify.com/llms.txt">llms.txt</a>.</p>

<h2>Add to Claude (Connectors Directory)</h2>
<p>Add <code>https://api.hlaverify.com/mcp</code> as a custom connector in Claude (<strong>Settings &gt; Connectors &gt; Add custom connector</strong>), or find it in the Connectors Directory once listed. Every tool is read-only (<code>readOnlyHint: true</code>) and calls only HLA-Verify's own pinned reference tables — nothing is written, nothing leaves this service. Two ways to connect:</p>
<ul>
<li><strong>No sign-in</strong> — the server works anonymously exactly as it does over plain HTTP, at the free tier's rate limit.</li>
<li><strong>Connect with OAuth</strong> — Claude runs a standard OAuth 2.1 + PKCE flow against this server; the consent screen offers "Continue with free access" (a token rate-limited per-token instead of per-IP) or "Use my HLA-Verify API key" (pastes an existing key; the token inherits that key's tier). There are no user accounts or passwords — nothing to sign up for.</li>
</ul>
<p>OAuth endpoints, for anyone verifying the metadata by hand: <code>GET /.well-known/oauth-protected-resource</code>, <code>GET /.well-known/oauth-authorization-server</code>, <code>POST /register</code> (RFC 7591 dynamic client registration), <code>GET/POST /authorize</code>, <code>POST /token</code>. Full design notes: <a href="https://github.com/jasonbrelsford/verifiable-science-envs/blob/main/docs/CLAUDE-CONNECTOR.md">docs/CLAUDE-CONNECTOR.md</a>.</p>
<p class="mut">Research-and-evaluation tool. Not a medical device. Not for clinical use.</p>

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
<p>Errors are JSON <code>{"detail": "…"}</code>: 400 malformed JSON, 401 missing/invalid/revoked key, 404 unknown name or route, 415 wrong content type, 422 invalid input, 429 rate limited (tier-specific), 500 (nothing stored). MCP <code>tools/call</code> validation failures are not HTTP or JSON-RPC errors — they come back as a normal tool result with <code>isError:true</code> and an explanatory text block, per the MCP spec.</p>

<h2>Terms</h2>
<p class="mut">HLA-Verify is a research-and-evaluation tool and not a medical device; output supports and does not replace clinical judgement. Service code: PolyForm Noncommercial 1.0.0 — commercial use requires a licence from Brelsford Software LLC (<a href="mailto:hello@hlaverify.com">hello@hlaverify.com</a>). Reference data: IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Research 2025), CC-BY-ND, fetched from the official source and never redistributed in bulk. Requests are processed in memory and discarded; metering records counts per key, never content.</p>
</div></body></html>`;
}

// /pricing — plain HTML, same styling as DOCS_HTML. Buttons link to Stripe
// Payment Links passed in as starterLink/proLink (env vars STRIPE_STARTER_LINK,
// STRIPE_PRO_LINK); either renders as "coming soon" text when unset so the page
// never links to nothing.
export function PRICING_HTML(m, { starterLink, proLink } = {}) {
  const buy = (link, label) =>
    link ? `<a class="btn" href="${esc(link)}">${esc(label)}</a>` : `<span class="btn mut" aria-disabled="true">coming soon</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify — pricing</title>
<meta name="description" content="HLA-Verify API pricing: free evaluation tier, self-serve Starter and Pro keys, Enterprise by request.">
<style>
:root{--green:#2F5D3A;--ink:#1E3A28;--paper:#FAFAF4;--mut:#5A6B5D;--line:#E4E0D4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:28px 22px 60px}
h1{font-family:Georgia,serif;font-size:2rem;margin:.2em 0}
table{border-collapse:collapse;width:100%;font-size:.93rem;margin-top:1.2em}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
a{color:var(--green)}.mut{color:var(--mut)}nav a{margin-right:14px}
.btn{display:inline-block;background:var(--green);color:#fff;border-radius:8px;padding:8px 16px;text-decoration:none;font-weight:600}
.btn.mut{background:#EEECE4;color:var(--mut)}
</style></head><body><div class="wrap">
<nav><a href="/docs">API reference</a><a href="https://hlaverify.com">hlaverify.com</a></nav>
<h1>Pricing</h1>
<p class="mut">Every tier hits the same deterministic API, pinned to IPD-IMGT/HLA ${esc(m.release)}. Prices and billing period are set at checkout; cancel anytime from the Stripe customer portal link in your receipt.</p>
<table>
<tr><th>Tier</th><th>Limit</th><th></th></tr>
<tr><td><b>Free</b></td><td>60 req/min per IP, no key required</td><td class="mut">just start calling the API</td></tr>
<tr><td><b>Starter</b></td><td>600 req/min per key</td><td>${buy(starterLink, "Buy Starter")}</td></tr>
<tr><td><b>Pro</b></td><td>6,000 req/min per key</td><td>${buy(proLink, "Buy Pro")}</td></tr>
<tr><td><b>Enterprise</b></td><td>uncapped, custom SLA</td><td><a class="btn" href="mailto:hello@hlaverify.com?subject=HLA-Verify%20Enterprise">Contact us</a></td></tr>
<tr><td><b>Academic research</b></td><td>Pro-tier rate limit, free</td><td><a class="btn" href="https://hlaverify.com/education">hlaverify.com/education</a></td></tr>
</table>
<p class="mut" style="margin-top:2em">After payment you'll land on a success page showing your API key once — copy it then, it is also written to your Stripe customer record. Full endpoint reference: <a href="/docs">/docs</a>.</p>
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
      "/mcp": { post: { summary: "Remote MCP endpoint (Streamable HTTP transport, JSON-RPC 2.0, stateless)",
        description: "Tools: verify_text, normalize_allele, allele_info, match_score, check_typing, donor_compat, validate_gl_string, about. donor_compat is decision support only; not a medical device. See the MCP for agents section above.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object",
          required: ["jsonrpc", "method"],
          properties: { jsonrpc: { type: "string", enum: ["2.0"] }, id: {}, method: { type: "string" }, params: { type: "object" } } } } } },
        responses: { 200: { description: "JSON-RPC 2.0 response or error" }, 202: { description: "notification acknowledged (no body)" }, 405: { description: "GET not supported" } } } },
    },
  };
}
