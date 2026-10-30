"""HLA-Verify on Hugging Face Spaces: Gradio version.

NOT what jason-brelsford/hla-verify runs by default. Hugging Face requires PRO to host Gradio (and
Docker) Spaces on free cpu-basic hardware: the create call for this account returned exactly that
in September 2026 (see the hf-space deploy log history). The default Space is the static page in
spaces/hla-verify/, which offers the same tabs. Deploy this one with
`SPACE_SDK=gradio ./spaces/deploy.sh` once the account (or an org that owns the Space) is PRO.

A thin Gradio front end over the public HLA-Verify REST API
(https://api.hlaverify.com/docs). Every verdict comes from the API, which checks
names deterministically against a pinned IPD-IMGT/HLA release: no LLM anywhere.

Keys, in order of precedence:
  1. a key the visitor pastes into the "Your API key" box (used for their calls only,
     forwarded to api.hlaverify.com and never stored or logged by this Space);
  2. the HLAVERIFY_API_KEY Space secret, if the owner has set one;
  3. none: the anonymous free tier (100 calls per UTC day per IP). Without a secret every
     visitor shares this Space's outbound IP, so that shared quota can run out.
"""
from __future__ import annotations

import json
import os
import re
from urllib.parse import quote

import gradio as gr
import requests

API = os.environ.get("HLAVERIFY_API_URL", "https://api.hlaverify.com").rstrip("/")
SPACE_KEY = os.environ.get("HLAVERIFY_API_KEY", "").strip()
TIMEOUT = 20
UA = "hla-verify-hf-space/1.0 (+https://huggingface.co/spaces/jason-brelsford/hla-verify)"

RESEARCH_URL = "https://hlaverify.com/research"
DOCS_URL = "https://api.hlaverify.com/docs"
PRICING_URL = "https://api.hlaverify.com/pricing"
BENCH_URL = "https://huggingface.co/datasets/jason-brelsford/hla-bench"
REPO_URL = "https://github.com/jasonbrelsford/verifiable-science-envs"
SUPPORT_URL = "https://hlaverify.com/support"

# One place to change the key call-to-action wording.
KEY_CTA = (
    f"**Free API key for academic research** — [apply at hlaverify.com/research]({RESEARCH_URL}) "
    "with your university or hospital address. HLA-Verify is free during early access; without a key "
    "the API allows 100 calls a day."
)

QUOTA_HELP = (
    "The shared demo quota for this Space is used up for today (the anonymous tier is 100 calls "
    "per UTC day per IP, and every visitor to this Space shares its IP). Paste your own key under "
    f"**Your API key** to keep going: research keys are free at [hlaverify.com/research]({RESEARCH_URL}). "
    f"Or call the API from your own machine, which gets its own 100 calls a day ([docs]({DOCS_URL}))."
)

NO_PHI = (
    "Paste allele names, typing strings, GL strings or report text **with identifiers removed**: "
    "no names, dates of birth or record numbers. Research tool, not a medical device."
)


# --------------------------------------------------------------------------- API
class ApiError(Exception):
    pass


def _headers(user_key: str | None) -> dict:
    h = {"user-agent": UA, "accept": "application/json"}
    key = (user_key or "").strip() or SPACE_KEY
    if key:
        h["x-api-key"] = key
    return h


def _quota_line(resp: requests.Response) -> str:
    tier = resp.headers.get("x-hla-verify-tier")
    left = resp.headers.get("x-hla-verify-daily-remaining")
    limit = resp.headers.get("x-hla-verify-daily-limit")
    release = resp.headers.get("x-hla-verify-release")
    bits = []
    if release:
        bits.append(f"IPD-IMGT/HLA {release}")
    if tier:
        bits.append(f"tier: {tier}")
    if left and limit:
        bits.append(f"{left}/{limit} calls left today")
    return " · ".join(bits)


def call(method: str, path: str, user_key: str | None = None, body: dict | None = None):
    """Returns (json_body, http_status, quota_line). Raises ApiError with a readable message.
    A 404 is returned, not raised: /v1/allele answers 404 for a name that does not exist."""
    try:
        resp = requests.request(method, API + path, headers=_headers(user_key), json=body, timeout=TIMEOUT)
    except requests.RequestException as e:  # network trouble, not a verdict
        raise ApiError(f"Could not reach {API} ({e.__class__.__name__}). Try again in a moment.") from None
    if resp.status_code == 429:
        raise ApiError(QUOTA_HELP)
    if resp.status_code == 401:
        raise ApiError("That API key was not accepted. Check it, or clear the box to use the free tier.")
    try:
        data = resp.json()
    except ValueError:
        raise ApiError(f"Unexpected response from the API (HTTP {resp.status_code}).") from None
    if resp.status_code >= 400 and resp.status_code != 404:
        detail = data.get("detail", data) if isinstance(data, dict) else data
        raise ApiError(f"HTTP {resp.status_code}: {detail}")
    return data, resp.status_code, _quota_line(resp)


def _fail(msg: str, n_outputs: int):
    return (f"⚠️ {msg}",) + (None,) * (n_outputs - 1)


def _foot(q: str) -> str:
    return f"\n\n<small>{q}</small>" if q else ""


# ------------------------------------------------------------------- 1. verify
STATUS_LABEL = {
    "valid": "valid",
    "deleted": "deleted / renamed",
    "group": "G/P group",
    "fabricated_group": "fabricated group",
    "hallucinated": "fabricated",
    "mac_code": "MAC code (not checked)",
    "out_of_scope": "out of scope (KIR)",
}
COLORS = {
    "valid": "#22c55e",
    "deleted / renamed": "#f59e0b",
    "G/P group": "#3b82f6",
    "fabricated group": "#ef4444",
    "fabricated": "#ef4444",
    "MAC code (not checked)": "#a1a1aa",
    "out of scope (KIR)": "#a1a1aa",
}
COLORS["valid, legacy form"] = "#84cc16"


def _label(t: dict) -> str:
    if t.get("status") == "valid" and "deprecated_name" in (t.get("flags") or []):
        return "valid, legacy form"
    return STATUS_LABEL.get(t.get("status"), t.get("status"))


_BOUND_L = r"(?<![A-Za-z0-9*:])"
_BOUND_R = r"(?![A-Za-z0-9:])"


def highlight(text: str, tokens: list[dict]) -> list[tuple[str, str | None]]:
    """Splits the input into (span, label) pairs for gr.HighlightedText. The API returns each
    distinct token once; every occurrence of it in the text is labelled."""
    labels = {t["token"]: _label(t) for t in tokens if t.get("token")}
    if not labels:
        return [(text, None)]
    alts = sorted(labels, key=len, reverse=True)
    rx = re.compile(_BOUND_L + "(" + "|".join(re.escape(a) for a in alts) + ")" + _BOUND_R)
    out, pos = [], 0
    for m in rx.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], None))
        out.append((m.group(1), labels[m.group(1)]))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], None))
    return out


def verify(text: str, user_key: str = ""):
    n = 4
    if not text or not text.strip():
        return _fail("Paste some text first.", n)
    try:
        d, _, q = call("POST", "/v1/verify", user_key, {"text": text})
    except ApiError as e:
        return _fail(str(e), n)
    toks = d.get("tokens", [])
    c = d.get("counts", {})
    bad = c.get("hallucinated", 0) + c.get("fabricated_group", 0)
    if not toks:
        head = "No allele-shaped names found in that text."
    elif d.get("clean"):
        head = f"✅ **Clean**: {len(toks)} distinct name(s), none fabricated or deleted."
    else:
        parts = []
        if bad:
            parts.append(f"**{bad} fabricated**")
        if c.get("deleted"):
            parts.append(f"**{c['deleted']} deleted/renamed**")
        head = "❌ " + " and ".join(parts) + f" out of {len(toks)} distinct name(s)."
    counts = " · ".join(f"{STATUS_LABEL.get(k, k)}: {v}" for k, v in c.items() if v)
    rows = [[
        t.get("token"), _label(t),
        t.get("successor") or "", t.get("current_2field") or "", t.get("g_group") or "",
        ", ".join(t.get("flags", [])), t.get("note", ""),
    ] for t in toks]
    return head + "\n\n" + counts + _foot(q), highlight(text, toks), rows, d


# ---------------------------------------------------------------- 2. normalize
def _split_names(s: str) -> list[str]:
    return [x for x in re.split(r"[\s,;]+", s or "") if x]


def normalize(text: str, user_key: str = ""):
    n = 3
    typings = _split_names(text)
    if not typings:
        return _fail("Enter one or more allele names.", n)
    if len(typings) > 250:
        return _fail("The free tier takes up to 250 names per call; a key raises that to 5,000.", n)
    try:
        d, _, q = call("POST", "/v1/normalize", user_key, {"typings": typings})
    except ApiError as e:
        return _fail(str(e), n)
    data = d.get("rows", [])
    rows = [[r.get("reported"), r.get("current_name"), r.get("allele_2field"), r.get("g_group"),
             ", ".join(r.get("flags", []))] for r in data]
    unresolved = sum(1 for r in data if r.get("current_name") == "UNRESOLVABLE")
    changed = sum(1 for r in data if r.get("current_name") not in (r.get("reported"), "UNRESOLVABLE"))
    summary = (f"{len(rows)} name(s): **{changed} rewritten** to a current name, "
               f"**{unresolved} unresolvable**.")
    return summary + _foot(q), rows, d


# ------------------------------------------------------------------- 3. allele
def allele(name: str, user_key: str = ""):
    n = 3
    name = (name or "").strip()
    if not name:
        return _fail("Enter an allele name, e.g. B*57:01.", n)
    try:
        d, status, q = call("GET", "/v1/allele/" + quote(name, safe=""), user_key)
    except ApiError as e:
        return _fail(str(e), n)
    if status == 404:
        return f"❌ {d.get('detail', 'not found')}: fabricated or mistyped." + _foot(q), None, d
    st = d.get("status", "")
    lines = [f"### `{d.get('name')}`: {st.replace('_', ' ')}"]
    if d.get("resolves_to"):
        lines.append(f"Reported form ({', '.join(d.get('flags', []))}) of **{d['resolves_to']}**.")
    if st == "deleted":
        lines.append(f"No longer current. Successor: **{d.get('successor') or 'none'}**.")
    if st == "valid_prefix":
        lines.append(f"A lower-resolution name: it stands for **{d.get('members_count')} full-resolution "
                     "alleles** in this release. Expanding names like this is the two-field ambiguity task on "
                     f"which every model family in [HLA-Bench]({BENCH_URL}) scored 0%.")
    if st == "group":
        lines.append(f"{d.get('group_type')} group with {d.get('members_count')} member(s).")
    if st == "mac_code":
        lines.append(d.get("note", ""))
    facts = []
    for k in ("g_group", "p_group", "first_release", "confirmed", "null_allele"):
        if d.get(k) is not None:
            facts.append(f"**{k.replace('_', ' ')}:** {d[k]}")
    if d.get("serology"):
        facts.append(f"**serology:** `{json.dumps(d['serology'])}`")
    if d.get("resolution"):
        facts.append(f"**resolution:** {d['resolution'].get('fields')} fields ({d['resolution'].get('level')})")
    lig = d.get("ligands")
    if lig:
        facts.append("**ligands:** " + ", ".join(f"{k}={v}" for k, v in lig.items() if v is not None))
    if facts:
        lines.append("\n".join("- " + f for f in facts))
    members = d.get("members_sample") or []
    if members:
        lines.append(f"First {len(members)} of {d.get('members_count')} member alleles listed below.")
    return "\n\n".join(lines) + _foot(q), ([[m] for m in members] or None), d


# ----------------------------------------------------------------- 4. glstring
def glstring(gl: str, user_key: str = ""):
    n = 3
    if not gl or not gl.strip():
        return _fail("Enter a GL string.", n)
    try:
        d, _, q = call("POST", "/v1/glstring", user_key, {"gl": gl})
    except ApiError as e:
        return _fail(str(e), n)
    ok = d.get("valid")
    lines = [("✅ **Valid GL string**" if ok else "❌ **Problems found**")
             + (", with names rewritten to current form." if d.get("changed") else ".")]
    if d.get("changed") or not ok:
        lines.append(f"Normalized: `{d.get('normalized_gl')}`")
    for i in d.get("issues", []):
        lines.append(f"- {i.get('severity', '')}: {i.get('detail', i)}" if isinstance(i, dict) else f"- {i}")
    rows = [[a.get("token"), a.get("status"), a.get("current_name"), a.get("locus")] for a in d.get("alleles", [])]
    return "\n\n".join(lines) + _foot(q), rows, d


# -------------------------------------------------------------------- 5. match
def parse_typing(s: str) -> dict:
    """'A*02:01, A*24:02\\nB*07:02 B*44:02' -> {'A': [...], 'B': [...]}. A line may start with an
    explicit 'LOCUS:' label; otherwise each name's locus is the part before '*'."""
    out: dict[str, list[str]] = {}
    for line in (s or "").splitlines():
        line = line.strip()
        label = None
        m = re.match(r"^(?:HLA-)?([A-Za-z0-9]+)\s*:\s*(.*)$", line)
        if m and "*" not in m.group(1) and not m.group(1).isdigit():
            label, line = m.group(1).upper(), m.group(2)
        for name in _split_names(line):
            locus = label or re.sub(r"^HLA-", "", name, flags=re.I).split("*")[0].upper()
            out.setdefault(locus, []).append(name)
    return out


FRAMEWORKS = ["8/8", "6/6", "10/10", "12/12", "antigen"]


def match(recipient: str, donor: str, framework: str = "8/8", with_compat: bool = False, user_key: str = ""):
    n = 3
    r, dn = parse_typing(recipient), parse_typing(donor)
    if not r or not dn:
        return _fail("Enter both typings.", n)
    try:
        m, _, q = call("POST", "/v1/match", user_key, {"framework": framework, "recipient": r, "donor": dn})
    except ApiError as e:
        return _fail(str(e), n)
    lines = [f"## {m.get('count')} ({m.get('framework')})",
             f"Host-versus-graft mismatches: **{m.get('hvg_mismatches')}** · "
             f"graft-versus-host mismatches: **{m.get('gvh_mismatches')}**"]
    if m.get("flags"):
        lines.append("Flags: " + ", ".join(map(str, m["flags"])))
    rows = [[locus, v] for locus, v in (m.get("verdicts") or {}).items()]
    raw = {"match": m}
    if with_compat:
        try:
            c, _, q = call("POST", "/v1/compat", user_key, {"recipient": r, "donor": dn})
            raw["compat"] = c
            bl, kir = c.get("b_leader") or {}, c.get("kir_ligands") or {}
            lines.append(f"**HLA-B leader (-21 M/T):** recipient {bl.get('recipient')}, donor {bl.get('donor')}, "
                         f"leader-matched: {bl.get('leader_match')}")
            lines.append(f"**KIR ligands:** recipient {kir.get('recipient')}, donor {kir.get('donor')}; "
                         f"missing in recipient {kir.get('missing_in_recipient')}, "
                         f"missing in donor {kir.get('missing_in_donor')} ({kir.get('status')})")
            for side in ("recipient", "donor"):
                for i in (c.get("issues") or {}).get(side, []):
                    lines.append(f"- {side} {i.get('severity')}: {i.get('detail')}")
            lines.append("<small>B-leader and KIR-ligand checks are decision support only; not a medical device.</small>")
        except ApiError as e:
            lines.append(f"⚠️ compat: {e}")
    return "\n\n".join(lines) + _foot(q), rows, raw


# ----------------------------------------------------------------------- UI
# Example inputs. Every verdict described here was checked against the live API (release 3.66.0):
# A*02:9999, DRB1*15:999 and B*57:01:99 are fabricated; C*03:03:01:39 is deleted (successor
# C*03:03:01:39Q); A*0101 is the legacy form of A*01:01; B*15:AB is a MAC code.
EX_VERIFY = (
    "Model answer: the recipient types as HLA-A*02:01, A*24:02 and B*57:01. For abacavir screening, "
    "B*57:01:99 should also be excluded. The closest donor carries A*02:9999 and DRB1*15:999; "
    "an older report lists C*03:03:01:39 and A*0101."
)
EX_NORMALIZE = "A*0101\nA*24:02:03Q\nC*03:03:01:39\nDRB1*04:01:01G\nB*15:AB\nA*02:9999"
EX_GL = "HLA-A*02:01+HLA-A*24:02^HLA-B*07:02+HLA-B*44:02"
EX_R = "A*02:01, A*24:02\nB*07:02, B*44:02\nC*07:02, C*05:01\nDRB1*15:01, DRB1*04:01"
EX_D = "A*02:01, A*24:02\nB*07:02, B*44:03\nC*07:02, C*04:01\nDRB1*15:01, DRB1*04:01"

HEADER = f"""
# 🧬 HLA-Verify: catch fabricated HLA allele names

Deterministic checks against a pinned **IPD-IMGT/HLA** release, with no LLM anywhere: every name in an
AI answer, a typing report or a GL string is looked up, never guessed. Built for checking model
output; in [HLA-Bench]({BENCH_URL}) every model family tested fabricates allele names.

> {KEY_CTA}

[API docs]({DOCS_URL}) · MCP server `https://api.hlaverify.com/mcp` · [Source]({REPO_URL}) ·
[HLA-Bench dataset]({BENCH_URL}) · [Report a wrong answer]({SUPPORT_URL})

⚠️ {NO_PHI}
"""

MCP_SNIPPET = """### MCP (Claude, Cursor, any MCP client)

Streamable HTTP; a key is optional and goes in an `X-API-Key` header.

```json
{"mcpServers": {"hla-verify": {"url": "https://api.hlaverify.com/mcp"}}}
```

### REST

```bash
curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' \\
  -d '{"text": "A*02:01 and B*57:01:99"}'
# with a key: add  -H 'x-api-key: hlv_...'
```
"""

FOOTER = f"""
---
Verdicts are computed from IPD-IMGT/HLA (Barker DJ et al., *Nucleic Acids Res* 2025, CC-BY-ND), and each
response names the release it used. This Space forwards what you type to `api.hlaverify.com` and keeps
nothing; the API processes requests in memory. For a version that runs entirely in your browser, see
[hlaverify.com/demo](https://hlaverify.com/demo). Research tool, not a medical device.
Paid tiers: [api.hlaverify.com/pricing]({PRICING_URL}).
"""

CSS = ".cta blockquote {font-size: 1.05em}"


def build() -> gr.Blocks:
    with gr.Blocks(title="HLA-Verify: catch fabricated HLA allele names") as demo:
        gr.Markdown(HEADER, elem_classes="cta")
        with gr.Accordion("Your API key (optional)", open=False):
            key = gr.Textbox(
                label="X-API-Key", type="password", placeholder="hlv_...",
                info="Used only for your own calls from this page; forwarded to api.hlaverify.com, never stored. "
                     f"Free for academic research: {RESEARCH_URL}",
            )

        with gr.Tab("Check text for fabricated names"):
            gr.Markdown("Paste an LLM answer, a typing report or any text. Every allele-shaped token is "
                        "checked (`POST /v1/verify`).")
            v_in = gr.Textbox(label="Text", lines=6, value=EX_VERIFY, max_length=200_000)
            v_btn = gr.Button("Check names", variant="primary")
            v_sum = gr.Markdown()
            v_hl = gr.HighlightedText(label="Highlighted", color_map=COLORS, show_legend=True)
            v_tab = gr.Dataframe(headers=["token", "status", "successor", "current 2-field", "G group", "flags",
                                          "note"], label="Per-name verdicts", wrap=True, interactive=False)
            with gr.Accordion("Raw JSON", open=False):
                v_json = gr.JSON()
            v_btn.click(verify, [v_in, key], [v_sum, v_hl, v_tab, v_json], api_name="verify")

        with gr.Tab("Normalize names"):
            gr.Markdown("Rewrite legacy, renamed and shorthand names to current form and flag what cannot "
                        "resolve (`POST /v1/normalize`). One name per line, or comma-separated.")
            n_in = gr.Textbox(label="Allele names", lines=6, value=EX_NORMALIZE)
            n_btn = gr.Button("Normalize", variant="primary")
            n_sum = gr.Markdown()
            n_tab = gr.Dataframe(headers=["reported", "current name", "2-field", "G group", "flags"],
                                 label="Normalized", wrap=True, interactive=False)
            with gr.Accordion("Raw JSON", open=False):
                n_json = gr.JSON()
            n_btn.click(normalize, [n_in, key], [n_sum, n_tab, n_json], api_name="normalize")

        with gr.Tab("Allele lookup"):
            gr.Markdown("Status, G/P group, serology, first release, KIR ligands and, for a two-field name, how "
                        "many full-resolution alleles it stands for (`GET /v1/allele/{name}`).")
            a_in = gr.Textbox(label="Allele name", value="B*57:01")
            gr.Examples([["B*57:01"], ["A*02:01"], ["A*24:09N"], ["C*03:03:01:39"], ["A*0101"], ["A*02:9999"]],
                        inputs=[a_in], label="Try")
            a_btn = gr.Button("Look up", variant="primary")
            a_sum = gr.Markdown()
            a_tab = gr.Dataframe(headers=["member alleles (sample)"], interactive=False)
            with gr.Accordion("Raw JSON", open=False):
                a_json = gr.JSON()
            a_btn.click(allele, [a_in, key], [a_sum, a_tab, a_json], api_name="allele")
            a_in.submit(allele, [a_in, key], [a_sum, a_tab, a_json], api_name=False)

        with gr.Tab("Donor–recipient match"):
            gr.Markdown("Match count with host-versus-graft and graft-versus-host direction (`POST /v1/match`), "
                        "and optionally HLA-B leader and KIR-ligand checks (`POST /v1/compat`). One locus per "
                        "line, e.g. `A*02:01, A*24:02` or `A: A*02:01, A*24:02`; list one allele for a "
                        "homozygous locus.")
            with gr.Row():
                m_r = gr.Textbox(label="Recipient", lines=6, value=EX_R)
                m_d = gr.Textbox(label="Donor", lines=6, value=EX_D)
            with gr.Row():
                m_fw = gr.Dropdown(FRAMEWORKS, value="8/8", label="Framework")
                m_c = gr.Checkbox(label="Also run B-leader / KIR-ligand checks (one extra call)", value=False)
            m_btn = gr.Button("Match", variant="primary")
            m_sum = gr.Markdown()
            m_tab = gr.Dataframe(headers=["locus", "verdict"], interactive=False)
            with gr.Accordion("Raw JSON", open=False):
                m_json = gr.JSON()
            m_btn.click(match, [m_r, m_d, m_fw, m_c, key], [m_sum, m_tab, m_json], api_name="match")

        with gr.Tab("GL string"):
            gr.Markdown("Validate a GL String and rewrite its names to current form (`POST /v1/glstring`).")
            g_in = gr.Textbox(label="GL string", lines=3, value=EX_GL)
            g_btn = gr.Button("Validate", variant="primary")
            g_sum = gr.Markdown()
            g_tab = gr.Dataframe(headers=["token", "status", "current name", "locus"], interactive=False)
            with gr.Accordion("Raw JSON", open=False):
                g_json = gr.JSON()
            g_btn.click(glstring, [g_in, key], [g_sum, g_tab, g_json], api_name="glstring")

        with gr.Tab("API and MCP"):
            gr.Markdown(MCP_SNIPPET + f"\nFull reference: [{DOCS_URL}]({DOCS_URL})\n\n> {KEY_CTA}")

        gr.Markdown(FOOTER)
    return demo


demo = build()

if __name__ == "__main__":
    demo.launch(css=CSS, theme=gr.themes.Soft(primary_hue="emerald"))
