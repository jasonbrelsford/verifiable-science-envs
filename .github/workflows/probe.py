#!/usr/bin/env python3
"""Read-only probe of the live HLA-Verify API and site, run by probe.yml.

The scheduled HLA-Verify tasks run in a sandbox that cannot reach api.hlaverify.com or
hlaverify.com, but it can read GitHub Actions job logs. So this script does the fetching
from a runner and prints everything it saw as ONE JSON line inside a `::group::probe.json`
log group (the same convention as the site's unmet-report workflow), plus a Markdown table
on the step summary. Anonymous calls only: no key, no secret, nothing written anywhere.

What it checks
  1. Public documents on the API: /healthz, /docs, /openapi.json, /llms.txt, /.well-known/ard.json,
     /mcp/server-card, /pricing. Each one's HTTP status and the IPD-IMGT/HLA release it states,
     if it states one; they must all agree with /healthz. None of these is billable.
  2. The 14-name allele panel from the 2026-10-05 evaluation, GET /v1/allele/{name}: the HTTP
     status and `status` field each name must return under the current contract.
  3. One POST /v1/verify and one POST /v1/normalize on fixed strings, checked token by token.
  4. The site's public pages: HTTP status, and the release string on /llms.txt.

Budget: 16 billable anonymous calls per run (14 + 1 + 1) out of the 100/day the runner's IP
gets; the documents and site pages are free. Exit status is 1 when anything is off, so a
dispatched run's conclusion is itself the signal.

Usage: probe.py [--api URL] [--site URL] [--no-site] [--out FILE] [--no-fail]
  --api / --site default to the production hosts; point them at a local server to test.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Cloudflare answers 403 to the default Python-urllib User-Agent (see the private runbook),
# so every request names itself.
USER_AGENT = "hlaverify-probe/1 (+https://github.com/jasonbrelsford/verifiable-science-envs)"
TIMEOUT = 20

# A release is stated as "IPD-IMGT/HLA 3.65.0" in prose and as "release": "3.65.0" in JSON.
RELEASE_PROSE = re.compile(r"IPD-IMGT/HLA\s+(\d+\.\d+\.\d+)")
RELEASE_JSON = re.compile(r'"release"\s*:\s*"(\d+\.\d+\.\d+)"')

# API documents: path, the HTTP status expected, and whether a stated release is expected.
# /llms.txt on the API is a redirect to the site's copy (edge/src/index.js); the site section
# reads the document itself. ard.json and the server card describe "a pinned release"
# without naming it, so they are checked for status only.
API_DOCUMENTS = [
    ("/healthz", 200, True),
    ("/docs", 200, True),
    ("/openapi.json", 200, True),
    ("/llms.txt", 302, False),
    ("/.well-known/ard.json", 200, False),
    ("/mcp/server-card", 200, False),
    ("/pricing", 200, True),
]

# The 14-name panel: (name, expected HTTP status, expected `status` field or None for a 404).
# Expectations are the current contract (handlers.js / sci_envs service), verified against
# the Python oracle on 2026-10-06. A release bump does not change them: every valid name
# here has been assigned for years and C*04:09N has been deleted since 3.0x.
PANEL = [
    ("A*01:01:01:01", 200, "assigned"),
    ("B*44:02:01:01", 200, "assigned"),
    ("DRB1*04:01:01:01", 200, "assigned"),
    ("A*02:01", 200, "valid_prefix"),
    ("A*24:09N", 200, "assigned"),
    ("C*04:09N", 200, "deleted"),
    ("A*02:01:01G", 200, "group"),
    ("DPB1*04:01P", 200, "group"),
    ("A*02:XX", 200, "valid_prefix"),   # xx_code flag, resolves_to A*02
    ("A*02:AB", 200, "mac_code"),       # recognised, not expanded
    ("A*99:99", 404, None),
    ("a*02:01", 404, None),             # case-sensitive by design
    ("A2", 404, None),                  # serology, not an allele name
    ("KIR2DL1*001", 404, None),         # not an HLA name
]

VERIFY_TEXT = "A*01:01:01:01 B*44:02:01:01 DQB1*05:03:26:99"
VERIFY_EXPECTED = {"A*01:01:01:01": "valid", "B*44:02:01:01": "valid", "DQB1*05:03:26:99": "hallucinated"}

NORMALIZE_TYPINGS = ["A*02:XX", "A*02:AB", "A*0101"]
NORMALIZE_EXPECTED = {
    "A*02:XX": {"current_name": "A*02", "flags": ["xx_code"]},
    "A*02:AB": {"current_name": "UNRESOLVABLE", "flags": ["mac_code"]},
    "A*0101": {"current_name": "A*01:01", "flags": ["deprecated_name"]},
}

SITE_PAGES = ["/", "/api", "/how-it-works", "/pricing", "/beta", "/demo", "/product",
              "/llms.txt", "/.well-known/ard.json", "/.well-known/ai-catalog.json"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(url: str, method: str = "GET", body: dict | None = None) -> dict:
    """One request; never raises. Returns status, headers, elapsed ms and the body text."""
    data = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json, text/html;q=0.9, */*;q=0.8"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    t0 = time.perf_counter()
    try:
        with OPENER.open(req, timeout=TIMEOUT) as resp:
            text = resp.read().decode("utf-8", "replace")
            status, hdrs = resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace") if e.fp else ""
        status, hdrs = e.code, dict(e.headers or {})
    except Exception as e:  # DNS, TLS, timeout, connection refused
        return {"status": None, "error": f"{type(e).__name__}: {e}", "ms": round((time.perf_counter() - t0) * 1000), "headers": {}, "text": ""}
    return {"status": status, "ms": round((time.perf_counter() - t0) * 1000),
            "headers": {k.lower(): v for k, v in hdrs.items()}, "text": text}


def stated_release(text: str) -> str | None:
    m = RELEASE_JSON.search(text) or RELEASE_PROSE.search(text)
    return m.group(1) if m else None


def as_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        return None


def probe(api: str, site: str | None) -> dict:
    failures: list[str] = []
    out: dict = {"probed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "api": api, "site": site, "billable_calls": 0}

    # 1. documents
    docs = []
    for path, want, wants_release in API_DOCUMENTS:
        r = fetch(api + path)
        rel = stated_release(r["text"]) if r["status"] == 200 else None
        row = {"path": path, "http": r["status"], "ms": r["ms"], "release": rel,
               "header_release": r["headers"].get("x-hla-verify-release"),
               "content_type": (r["headers"].get("content-type") or "").split(";")[0] or None}
        if path == "/llms.txt":
            row["location"] = r["headers"].get("location")
        if path == "/healthz":
            h = as_json(r["text"]) or {}
            row.update({"alleles": h.get("alleles"), "uptime_s": h.get("uptime_s")})
        if r.get("error"):
            row["error"] = r["error"]
        if r["status"] != want:
            failures.append(f"{path}: HTTP {r['status']} (expected {want})")
        elif wants_release and not rel:
            failures.append(f"{path}: states no release")
        docs.append(row)
    out["documents"] = docs
    healthz_release = next((d["release"] for d in docs if d["path"] == "/healthz"), None)
    disagree = [d["path"] for d in docs if d["release"] and d["release"] != healthz_release]
    disagree += [d["path"] for d in docs if d["header_release"] and d["header_release"] != healthz_release]
    out["release"] = {"healthz": healthz_release, "agree": not disagree and healthz_release is not None,
                      "disagreeing": sorted(set(disagree))}
    for p in sorted(set(disagree)):
        failures.append(f"{p}: release differs from /healthz ({healthz_release})")

    # 2. the allele panel
    panel = []
    for name, want_http, want_status in PANEL:
        r = fetch(api + "/v1/allele/" + urllib.parse.quote(name, safe="*:"))
        out["billable_calls"] += 1
        b = as_json(r["text"]) or {}
        got_status = b.get("status") if r["status"] == 200 else None
        ok = r["status"] == want_http and got_status == want_status
        row = {"name": name, "http": r["status"], "status": got_status, "ms": r["ms"], "ok": ok,
               "expected": {"http": want_http, "status": want_status}}
        for k in ("flags", "resolves_to", "successor", "release"):
            if k in b:
                row[k] = b[k]
        if r["status"] != 200:
            row["detail"] = (b.get("detail") or r.get("error") or r["text"][:120]) or None
        if b.get("release") and healthz_release and b["release"] != healthz_release:
            ok = row["ok"] = False
            failures.append(f"/v1/allele/{name}: release {b['release']} != /healthz {healthz_release}")
        if not ok:
            failures.append(f"/v1/allele/{name}: HTTP {r['status']} {got_status!r} (expected {want_http} {want_status!r})")
        panel.append(row)
    out["panel"] = panel

    # 3. verify + normalize on fixed strings
    r = fetch(api + "/v1/verify", "POST", {"text": VERIFY_TEXT})
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    got = {t.get("token"): t.get("status") for t in b.get("tokens", []) if isinstance(t, dict)}
    ok = r["status"] == 200 and got == VERIFY_EXPECTED
    out["verify"] = {"http": r["status"], "ms": r["ms"], "ok": ok, "text": VERIFY_TEXT,
                     "tokens": got, "expected": VERIFY_EXPECTED, "release": b.get("release")}
    if not ok:
        failures.append(f"/v1/verify: HTTP {r['status']} tokens {got} (expected {VERIFY_EXPECTED})")

    r = fetch(api + "/v1/normalize", "POST", {"typings": NORMALIZE_TYPINGS})
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    rows = {row.get("reported"): {"current_name": row.get("current_name"), "flags": row.get("flags")}
            for row in b.get("rows", []) if isinstance(row, dict)}
    ok = r["status"] == 200 and rows == NORMALIZE_EXPECTED
    out["normalize"] = {"http": r["status"], "ms": r["ms"], "ok": ok, "typings": NORMALIZE_TYPINGS,
                        "rows": rows, "expected": NORMALIZE_EXPECTED, "release": b.get("release")}
    if not ok:
        failures.append(f"/v1/normalize: HTTP {r['status']} rows {rows} (expected {NORMALIZE_EXPECTED})")

    # 4. the site
    if site:
        pages = []
        for path in SITE_PAGES:
            r = fetch(site + path)
            row = {"path": path, "http": r["status"], "ms": r["ms"]}
            if path == "/llms.txt":
                row["release"] = stated_release(r["text"]) if r["status"] == 200 else None
                if healthz_release and row["release"] and row["release"] != healthz_release:
                    failures.append(f"site {path}: release {row['release']} != API /healthz {healthz_release}")
            if r.get("error"):
                row["error"] = r["error"]
            if r["status"] != 200:
                failures.append(f"site {path}: HTTP {r['status']}")
            pages.append(row)
        out["site_pages"] = pages

    out["failures"] = failures
    out["ok"] = not failures
    return out


def summary(res: dict) -> str:
    lines = [f"### HLA-Verify probe {res['probed_at']} — {'OK' if res['ok'] else 'FAILURES: ' + str(len(res['failures']))}",
             f"API `{res['api']}` release {res['release']['healthz']} (documents agree: {res['release']['agree']}); "
             f"{res['billable_calls']} billable anonymous calls spent.", ""]
    if res["failures"]:
        lines += ["**Failures**", ""] + [f"- {f}" for f in res["failures"]] + [""]
    lines += ["| document | HTTP | ms | release |", "|---|---:|---:|---|"]
    lines += [f"| `{d['path']}` | {d['http']} | {d['ms']} | {d['release'] or ''} |" for d in res["documents"]]
    lines += ["", "| allele | HTTP | status | flags | ms | ok |", "|---|---:|---|---|---:|---|"]
    lines += [f"| `{p['name']}` | {p['http']} | {p['status'] or ''} | {' '.join(p.get('flags') or [])} | {p['ms']} | {'yes' if p['ok'] else 'NO'} |"
              for p in res["panel"]]
    v, n = res["verify"], res["normalize"]
    lines += ["", f"- `/v1/verify`: HTTP {v['http']}, {v['ms']} ms, {'ok' if v['ok'] else 'MISMATCH'} — {v['tokens']}",
              f"- `/v1/normalize`: HTTP {n['http']}, {n['ms']} ms, {'ok' if n['ok'] else 'MISMATCH'}"]
    if res.get("site_pages"):
        lines += ["", "| site page | HTTP | ms |", "|---|---:|---:|"]
        lines += [f"| `{p['path']}` | {p['http']} | {p['ms']} |" for p in res["site_pages"]]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default="https://api.hlaverify.com")
    ap.add_argument("--site", default="https://hlaverify.com")
    ap.add_argument("--no-site", action="store_true", help="skip the site pages")
    ap.add_argument("--out", default="probe.json")
    ap.add_argument("--no-fail", action="store_true", help="exit 0 even when something is off")
    a = ap.parse_args()

    res = probe(a.api.rstrip("/"), None if a.no_site else a.site.rstrip("/"))
    line = json.dumps(res, separators=(",", ":"), sort_keys=True)
    with open(a.out, "w") as f:
        f.write(line + "\n")
    print("::group::probe.json")
    print(line)
    print("::endgroup::")
    md = summary(res)
    print(md)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a") as f:
            f.write(md)
    if not res["ok"]:
        for fl in res["failures"]:
            print(f"::error::{fl}")
    return 0 if res["ok"] or a.no_fail else 1


if __name__ == "__main__":
    sys.exit(main())
