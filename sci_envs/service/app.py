"""HLA-Verify — the HLA-Bench graders as a verification API.

Deterministic, no LLM anywhere: every answer is computed from a pinned
IPD-IMGT/HLA release (fetched at runtime, never redistributed; CC-BY-ND
attribution in every response). Stores nothing; logs counts, not content.

Run:  uvicorn sci_envs.service.app:app --host 0.0.0.0 --port 8000
Env:  HLA_VERIFY_TAG        release tag to pin (default v3.65.0-alpha)
      HLA_VERIFY_API_KEYS   comma-separated keys; unset = open (demo mode)
"""
from __future__ import annotations

import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from sci_envs.reference.imgt import ImgtReference, ImgtError, split_allele
from sci_envs.families.nomenclature.normalize import normalize, resolve_name

TAG = os.environ.get("HLA_VERIFY_TAG", "v3.65.0-alpha")
ATTRIBUTION = ("Computed from IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Res 2025), "
               "fetched at runtime from the ANHIG/IMGTHLA mirror under CC-BY-ND.")

app = FastAPI(title="HLA-Verify", version="0.1.0",
              description="Deterministic verification of HLA nomenclature against a pinned IPD-IMGT/HLA release.")
_ref: ImgtReference | None = None
_stats = {"started": time.time(), "requests": 0, "tokens_checked": 0}


def ref() -> ImgtReference:
    global _ref
    if _ref is None:
        _ref = ImgtReference.load(TAG)
    return _ref


def _auth(request: Request) -> None:
    keys = os.environ.get("HLA_VERIFY_API_KEYS", "")
    if not keys:
        return  # demo mode
    if request.headers.get("x-api-key", "") not in {k.strip() for k in keys.split(",") if k.strip()}:
        raise HTTPException(401, "missing or invalid X-API-Key")


class VerifyIn(BaseModel):
    text: str = Field(..., max_length=200_000, description="Free text: a report, an AI answer, a note.")


class NormalizeIn(BaseModel):
    typings: list[str] = Field(..., max_length=5_000, description="Reported typing strings, any era.")


STATUS_HELP = {
    "valid": "assigned in this release (or a valid lower-resolution prefix)",
    "group": "a G/P group name in this release",
    "deleted": "was assigned once, no longer current — see successor",
    "fabricated_group": "shaped like a G/P group but no such group exists",
    "hallucinated": "no such name in any release back to 1.05.0 — fabricated",
}


@app.get("/healthz")
def healthz():
    r = ref()
    return {"ok": True, "release": r.release, "alleles": len(r.manifest), "uptime_s": int(time.time() - _stats["started"])}


@app.post("/v1/verify")
def verify(body: VerifyIn, _: None = Depends(_auth)):
    r = ref()
    _stats["requests"] += 1
    buckets = r.classify_tokens(body.text)
    tokens = []
    for status, toks in buckets.items():
        for t in toks:
            row = {"token": t, "status": status, "note": STATUS_HELP[status]}
            if status == "deleted":
                succ = r.renamed_to(t)
                if succ:
                    row["successor"] = succ
            if status in ("valid", "deleted"):
                n = normalize(r, t)
                if n["allele_2field"] != "UNRESOLVABLE":
                    row["current_2field"], row["g_group"] = n["allele_2field"], n["g_group"]
                    if n["flags"]:
                        row["flags"] = n["flags"].split(";")
            tokens.append(row)
    tokens.sort(key=lambda x: x["token"])
    _stats["tokens_checked"] += len(tokens)
    counts = {k: len(v) for k, v in buckets.items()}
    return {"release": r.release, "tokens": tokens, "counts": counts,
            "clean": counts["hallucinated"] == 0 and counts["fabricated_group"] == 0 and counts["deleted"] == 0,
            "attribution": ATTRIBUTION}


@app.post("/v1/normalize")
def normalize_batch(body: NormalizeIn, _: None = Depends(_auth)):
    r = ref()
    _stats["requests"] += 1
    rows = []
    for s in body.typings:
        name, flags = resolve_name(r, s)
        n = normalize(r, s)
        rows.append({"reported": s, "current_name": name or "UNRESOLVABLE",
                     "allele_2field": n["allele_2field"], "g_group": n["g_group"],
                     "flags": n["flags"].split(";") if n["flags"] else []})
    return {"release": r.release, "rows": rows, "attribution": ATTRIBUTION}


@app.get("/v1/allele/{name:path}")
def allele(name: str, _: None = Depends(_auth)):
    r = ref()
    _stats["requests"] += 1
    name = name.strip()
    if r.is_deleted(name):
        succ = r.renamed_to(name)
        return {"release": r.release, "name": name, "status": "deleted", "successor": succ, "attribution": ATTRIBUTION}
    try:
        exists = r.exists(name)
        prefix = (not exists) and r._valid_prefix(name)
    except ImgtError:
        raise HTTPException(404, f"{name!r} is not a parseable HLA allele name")
    if not exists and not prefix:
        raise HTTPException(404, f"{name!r} is not assigned in release {r.release}")
    out = {"release": r.release, "name": name, "status": "assigned" if exists else "valid_prefix",
           "attribution": ATTRIBUTION}
    if exists:
        out.update({"g_group": r.g_group(name) or None, "p_group": r.p_group(name) or None,
                    "first_release": r.first_release(name), "confirmed": r.confirmed(name)})
        sero = r.serology(name)
        if sero is not None:
            import dataclasses
            d = dataclasses.asdict(sero)
            out["serology"] = {k: list(v) for k, v in d.items() if k != "allele" and v}
        if split_allele(name)[2] == "N":
            out["null_allele"] = True
    else:
        members = r.expand(name)
        out["members_count"] = len(members)
        out["members_sample"] = members[:10]
    return out


@app.get("/", response_class=HTMLResponse)
def home():
    return DEMO_HTML.replace("__RELEASE__", ref().release)


DEMO_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLA-Verify</title><style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;background:#fafaf7;color:#1a1a18}
textarea{width:100%;min-height:110px;font:13px/1.5 ui-monospace,monospace;padding:.6rem;border:1px solid #c9c5ba;border-radius:8px;box-sizing:border-box}
button{background:#2f5d3a;color:#fff;border:0;border-radius:8px;padding:.55rem 1.2rem;font-size:14px;cursor:pointer;margin-top:.5rem}
.tok{display:inline-block;margin:.15rem;padding:.2rem .55rem;border-radius:6px;font:12px ui-monospace,monospace}
.valid{background:#dcefdc}.group{background:#dbe7f6}.deleted{background:#fdeece}.hallucinated,.fabricated_group{background:#f8d7d7}
small{color:#6b6a64}#out{margin-top:1rem}h1{font-size:1.4rem}code{background:#eeece6;padding:.1rem .3rem;border-radius:4px}</style></head><body>
<h1>HLA-Verify</h1>
<p>Paste anything — a typing report, an AI answer, a note. Every allele-shaped token is checked
<b>deterministically</b> against IPD-IMGT/HLA <b>__RELEASE__</b>. No LLM. Fabricated names glow red.</p>
<textarea id="t">Patient typing: A*0101, B*15:504:01, DRB1*14:06. Assistant suggested DQB1*05:03:26:99 (DQB1*05:03:01G).</textarea><br>
<button onclick="go()">Verify</button>
<div id="out"></div>
<p><small>API: <code>POST /v1/verify {"text": …}</code> · <code>POST /v1/normalize {"typings": […]}</code> ·
<code>GET /v1/allele/A*01:01</code> · docs at <a href="/docs">/docs</a>. Nothing you paste is stored.</small></p>
<script>
async function go(){
  const r = await fetch('/v1/verify',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:document.getElementById('t').value})});
  const d = await r.json(); const o = document.getElementById('out'); o.innerHTML='';
  const v = document.createElement('p');
  v.innerHTML = d.clean ? '✅ <b>Clean</b> — every name is real and current.'
    : '⚠️ <b>Problems found</b> — ' + (d.counts.hallucinated+d.counts.fabricated_group) + ' fabricated, ' + d.counts.deleted + ' outdated.';
  o.appendChild(v);
  for (const t of d.tokens){
    const s = document.createElement('span'); s.className = 'tok ' + t.status;
    s.title = t.note + (t.successor ? ' → ' + t.successor : '') + (t.g_group ? ' · G: ' + t.g_group : '');
    s.textContent = t.token + (t.status==='deleted' && t.successor ? ' → ' + t.successor : '') +
      (t.status==='hallucinated' ? ' ✗' : t.status==='fabricated_group' ? ' ✗' : '');
    o.appendChild(s);
  }
  const a = document.createElement('p'); a.innerHTML='<small>'+d.attribution+' Release '+d.release+'.</small>'; o.appendChild(a);
}
</script></body></html>"""
