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
  2. The 17-name allele panel from the 2026-10-05 evaluation (extended 2026-10-09 with a
     non-classical gene and a prefixed G-group name, 2026-10-16 with a deleted-identical-to name), GET /v1/allele/{name}: the HTTP status
     and `status` field each name must return under the current contract.
  3. One POST /v1/verify and one POST /v1/normalize on fixed strings, checked token by token.
  4. One POST /v1/normalize with a 60-name mixed-locus batch (the #111 class: every uncached
     locus+2-field shard was a subrequest, and a batch past the plan's cap answered 500), and
     one POST /v1/pgx/screen on B*5701 (abacavir actionable, deprecated_name flag kept).
  5. The site's public pages: HTTP status, and the release string on /llms.txt.
  6. The release-history routes and support reports (2026-10-16): GET /v1/releases, GET
     /v1/releases/diff (limit=1), POST /v1/translate, GET /v1/allele/{name}/history, and a valid
     and an empty-input POST /v1/report. Each must answer as documented and state the release
     /healthz states. The valid report stores one record in the REPORTS namespace, labelled as
     the probe (source hlaverify-probe, input says so): a daily record to ignore when triaging.

Latency (#148): every call's wall time is kept (`latency` in the JSON: p50, max, slowest call,
and the Cloudflare `cf-ray` / `cf-cache-status` / colo hint of each slow call). A call over its budget
is a WARNING (`warnings`, `::warning::`), never a failure: the 60-name batch over BATCH_BUDGET_MS, any
other API call over SLOW_FACTOR x the median of this run's API calls (floor SLOW_FLOOR_MS). The
trailing median across runs is not available to a stateless job, so the run's own median stands in.

Budget: 24 billable anonymous calls per run (17 + 1 + 1 + 1 + 1, plus diff, translate and history) out of
the 100/day the runner's IP gets; the documents, /v1/releases, both reports and site pages are free. Exit status is 1 when anything is off, so a
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

# The 17-name panel: (name, expected HTTP status, expected `status` field or None for a 404).
# Expectations are the current contract (handlers.js / sci_envs service), verified against
# the Python oracle on 2026-10-06. A release bump does not change them: every valid name
# here has been assigned for years and C*04:09N has been deleted since 3.0x. MICA*091 and
# HLA-B*49:01:01G were added 2026-10-09 so the 46-gene and HLA- prefix claims are checked
# live every day (both already in edge/test/fixtures.json).
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
    ("MICA*091", 200, "assigned"),      # non-classical gene, proves the 46-gene claim
    ("HLA-B*49:01:01G", 200, "group"),  # prefixed G-group name
    ("MICB*002:01:34", 200, "deleted"), # deleted, identical to MICB*002:01:37 (successor checked below)
]
PANEL_SUCCESSOR = {"MICB*002:01:34": "MICB*002:01:37"}

# One POST. The last three tokens are the legacy-spelling class from the 2026-10-06 evaluation
# (PR #92, golden.test.mjs #88/#89): a 4-digit name and a Cw* name resolve as valid with the
# deprecated_name flag, and a fabricated Cw* name is hallucinated. Tokens are reported with any
# HLA- prefix stripped, so the expectation keys use the bare spelling.
VERIFY_TEXT = "A*01:01:01:01 B*44:02:01:01 DQB1*05:03:26:99 A*0201 Cw*0702 Cw*9999"
VERIFY_EXPECTED = {"A*01:01:01:01": "valid", "B*44:02:01:01": "valid", "DQB1*05:03:26:99": "hallucinated",
                   "A*0201": "valid", "Cw*0702": "valid", "Cw*9999": "hallucinated"}

NORMALIZE_TYPINGS = ["A*02:XX", "A*02:AB", "A*0101"]
NORMALIZE_EXPECTED = {
    "A*02:XX": {"current_name": "A*02", "flags": ["xx_code"]},
    "A*02:AB": {"current_name": "UNRESOLVABLE", "flags": ["mac_code"]},
    "A*0101": {"current_name": "A*01:01", "flags": ["deprecated_name"]},
}

# The #111 class: a mixed-locus batch whose cold-isolate shard count exceeds Workers Free's
# 50-subrequest cap. Names come from the golden fixtures (edge/test/fixtures.json, generated by
# gen_fixtures.py from the Python oracle), one per distinct 2-field group, round-robin across
# loci. The batch must answer 200 with one row per name; current_name is compared too when the
# fixtures were generated for the release the API is serving.
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "edge", "test", "fixtures.json")
BATCH_SIZE = 60

PGX_ALLELES = ["B*5701"]

# Latency budgets (#148). The 60-name batch took 2856 ms once against 783 ms another time, same input.
# Over budget is a warning in the log and the JSON, never a failed run.
BATCH_BUDGET_MS = 2000
SLOW_FACTOR = 3
SLOW_FLOOR_MS = 1000
CALLS: list[dict] = []   # every fetch() of the run, in order

# The release-history routes (#141) and the support report (#135). A1's first name, A*0101, was
# renamed A*01:01:01:01 in 3.00.0 (HLA00001) and has kept that name since, so a translate from 1.05.0
# is stable across releases; the diff window is fixed and only its envelope is asserted.
TRANSLATE_BODY = {"names": ["A*0101"], "from": "1.05.0"}
TRANSLATE_EXPECTED = {"status": "renamed", "to_name": "A*01:01:01:01", "hla_id": "HLA00001"}
DIFF_FROM, DIFF_TO = "3.58.0", "3.66.0"
HISTORY_NAME = "A*01:01:01:01"
# The one valid report stores a real record, so it says plainly that it is the probe. Never
# resend it more than once a run: REPORTS_PER_DAY is 20 per IP.
REPORT_VALID = {"kind": "other", "source": "hlaverify-probe",
                "input": "hlaverify-probe: automated daily check of POST /v1/report",
                "expected": "No action needed: this is the scheduled probe, not a user report."}
REPORT_INVALID = {"kind": "other", "input": "", "expected": "an empty input must be refused"}


def batch_names(path: str = FIXTURES, size: int = BATCH_SIZE) -> tuple[dict[str, str], str | None]:
    """{reported: current_name} for `size` fixture names in distinct 2-field groups, and the fixtures' release."""
    with open(path, encoding="utf-8") as f:
        fx = json.load(f)
    by_locus: dict[str, list[dict]] = {}
    seen_groups: set[str] = set()
    for case in fx["normalize"]:
        for row in case["expected"]["rows"]:
            group = row.get("allele_2field") or row["reported"]
            if group in seen_groups:
                continue
            seen_groups.add(group)
            by_locus.setdefault(group.split("*")[0], []).append(row)
    picked: dict[str, str] = {}
    queues = [by_locus[k] for k in sorted(by_locus)]
    while len(picked) < size and any(queues):
        for q in queues:
            if q and len(picked) < size:
                row = q.pop(0)
                picked.setdefault(row["reported"], row["current_name"])
    return picked, fx.get("release")


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
    result = _fetch(req, t0)
    CALLS.append({"host": urllib.parse.urlsplit(url).netloc, "call": f"{method} {urllib.parse.urlsplit(url).path}", "ms": result["ms"], "http": result["status"],
                  "cf_ray": result["headers"].get("cf-ray"), "cf_cache": result["headers"].get("cf-cache-status")})
    return result


def _fetch(req: urllib.request.Request, t0: float) -> dict:
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


def median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return float(s[n // 2]) if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def latency_report(api_calls: list[dict]) -> tuple[dict, list[str]]:
    """p50 / max / slowest of the API calls, plus a warning for each call over its budget."""
    timed = [c for c in api_calls if c["http"] is not None]
    if not timed:
        return {}, []
    p50 = median([c["ms"] for c in timed])
    slowest = max(timed, key=lambda c: c["ms"])
    limit = max(SLOW_FACTOR * p50, SLOW_FLOOR_MS)
    warnings = []
    for c in timed:
        budget = BATCH_BUDGET_MS if c.get("batch") else limit
        if c["ms"] > budget:
            warnings.append(f"slow: {c['call']}{' (batch)' if c.get('batch') else ''} took {c['ms']} ms "
                            f"(budget {round(budget)} ms; run p50 {round(p50)} ms; cf-ray {c['cf_ray'] or 'n/a'})")
    return ({"calls": len(timed), "p50_ms": round(p50), "max_ms": slowest["ms"], "slowest": slowest["call"],
             "slow_limit_ms": round(limit), "batch_budget_ms": BATCH_BUDGET_MS,
             "slow": [c for c in timed if c["ms"] > (BATCH_BUDGET_MS if c.get("batch") else limit)]},
            warnings)


def stated_release(text: str) -> str | None:
    m = RELEASE_JSON.search(text) or RELEASE_PROSE.search(text)
    return m.group(1) if m else None


def as_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        return None


def probe(api: str, site: str | None) -> dict:
    CALLS.clear()
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
        if name in PANEL_SUCCESSOR and b.get("successor") != PANEL_SUCCESSOR[name]:
            ok = row["ok"] = False
            failures.append(f"/v1/allele/{name}: successor {b.get('successor')!r} (expected {PANEL_SUCCESSOR[name]!r})")
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

    # 3b. the #111 batch and the pgx screen
    try:
        names, fx_release = batch_names()
    except Exception as e:  # missing or malformed fixtures: say so, do not crash the probe
        names, fx_release = {}, None
        failures.append(f"/v1/normalize batch: cannot read fixtures ({type(e).__name__}: {e})")
    if names:
        r = fetch(api + "/v1/normalize", "POST", {"typings": list(names)})
        CALLS[-1]["batch"] = True
        out["billable_calls"] += 1
        b = as_json(r["text"]) or {}
        got_rows = b.get("rows") if isinstance(b.get("rows"), list) else []
        same_release = bool(fx_release) and fx_release == healthz_release
        wrong = [] if not same_release else [
            f"{row.get('reported')}: {row.get('current_name')!r} != {names[row.get('reported')]!r}"
            for row in got_rows if isinstance(row, dict) and row.get("reported") in names
            and row.get("current_name") != names[row.get("reported")]]
        ok = r["status"] == 200 and len(got_rows) == len(names) and not wrong
        out["normalize_batch"] = {"http": r["status"], "ms": r["ms"], "ok": ok, "names": len(names),
                                  "rows": len(got_rows), "compared_current_name": same_release,
                                  "mismatches": wrong[:10], "release": b.get("release")}
        if not ok:
            failures.append(f"/v1/normalize batch of {len(names)}: HTTP {r['status']}, {len(got_rows)} rows"
                            + (f", mismatches {wrong[:3]}" if wrong else ""))

    r = fetch(api + "/v1/pgx/screen", "POST", {"alleles": PGX_ALLELES})
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    summ = b.get("summary") if isinstance(b.get("summary"), dict) else {}
    actionable = summ.get("actionable") if isinstance(summ.get("actionable"), list) else []
    abacavir = any(isinstance(a, dict) and a.get("drug") == "abacavir" for a in actionable)
    arows = b.get("alleles") if isinstance(b.get("alleles"), list) else []
    flagged = any(isinstance(a, dict) and "deprecated_name" in (a.get("flags") or []) for a in arows)
    ok = r["status"] == 200 and abacavir and flagged
    out["pgx_screen"] = {"http": r["status"], "ms": r["ms"], "ok": ok, "alleles": PGX_ALLELES,
                         "abacavir_actionable": abacavir, "deprecated_name_flag": flagged,
                         "pgx_snapshot": b.get("pgx_snapshot")}
    if not ok:
        failures.append(f"/v1/pgx/screen {PGX_ALLELES}: HTTP {r['status']}, abacavir actionable {abacavir}, deprecated_name flag {flagged}")

    # 3c. release history and support reports. Billable: translate, diff, allele history (3).
    # Free: releases, and both reports (never billable; the valid one stores a labelled record).
    def check(key: str, label: str, r: dict, want_http: int, problems: list[str], b: dict) -> None:
        if r["status"] != want_http:
            problems.append(f"HTTP {r['status']} (expected {want_http})")
        out[key] = {"http": r["status"], "ms": r["ms"], "ok": not problems, "problems": problems}
        if problems:
            failures.append(f"{label}: " + "; ".join(problems))

    r = fetch(api + "/v1/releases")
    b = as_json(r["text"]) or {}
    rels = b.get("releases") if isinstance(b.get("releases"), list) else []
    problems = []
    if r["status"] == 200:
        if b.get("latest") != healthz_release:
            problems.append(f"latest {b.get('latest')!r} != /healthz {healthz_release!r}")
        if not rels or rels[-1] != b.get("latest") or b.get("count") != len(rels):
            problems.append("releases list is empty, does not end at latest, or count differs")
        if DIFF_FROM not in rels:
            problems.append(f"{DIFF_FROM} missing from the list")
    check("releases", "/v1/releases", r, 200, problems, b)
    out["releases"].update({"latest": b.get("latest"), "count": b.get("count")})

    r = fetch(api + "/v1/releases/diff?" + urllib.parse.urlencode({"from": DIFF_FROM, "to": DIFF_TO, "limit": 1}))
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    counts = b.get("counts") if isinstance(b.get("counts"), dict) else {}
    problems = []
    if r["status"] == 200:
        if b.get("to") != DIFF_TO or b.get("from") != DIFF_FROM:
            problems.append(f"window {b.get('from')!r}..{b.get('to')!r} (asked {DIFF_FROM}..{DIFF_TO})")
        if not all(isinstance(counts.get(k), int) for k in ("added", "removed", "renamed")):
            problems.append(f"counts not integers: {counts}")
        elif counts["added"] < 1:
            problems.append("no names added between the two releases")
        if not isinstance(b.get("added"), list) or len(b["added"]) > 1 or b.get("limit") != 1:
            problems.append("limit=1 not honoured")
    check("releases_diff", "/v1/releases/diff", r, 200, problems, b)
    out["releases_diff"]["counts"] = counts

    body = dict(TRANSLATE_BODY, to=healthz_release) if healthz_release else dict(TRANSLATE_BODY)
    r = fetch(api + "/v1/translate", "POST", body)
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    row = next((x for x in b.get("rows", []) if isinstance(x, dict)), {}) if r["status"] == 200 else {}
    problems = []
    if r["status"] == 200:
        got = {k: row.get(k) for k in TRANSLATE_EXPECTED}
        if got != TRANSLATE_EXPECTED:
            problems.append(f"row {got} (expected {TRANSLATE_EXPECTED})")
        if b.get("to") != healthz_release:
            problems.append(f"to {b.get('to')!r} != /healthz {healthz_release!r}")
    check("translate", "/v1/translate", r, 200, problems, b)

    r = fetch(api + "/v1/allele/" + urllib.parse.quote(HISTORY_NAME, safe="*:") + "/history")
    out["billable_calls"] += 1
    b = as_json(r["text"]) or {}
    al = next((x for x in b.get("alleles", []) if isinstance(x, dict)), {}) if r["status"] == 200 else {}
    problems = []
    if r["status"] == 200:
        if b.get("latest") != healthz_release:
            problems.append(f"latest {b.get('latest')!r} != /healthz {healthz_release!r}")
        if al.get("hla_id") != "HLA00001" or al.get("current_name") != HISTORY_NAME:
            problems.append(f"allele {al.get('hla_id')!r} current_name {al.get('current_name')!r}")
        tl = al.get("timeline") if isinstance(al.get("timeline"), list) else []
        if not tl or tl[0].get("name") != "A*0101" or tl[-1].get("to") != healthz_release:
            problems.append("timeline does not run from A*0101 to the serving release")
    check("allele_history", "/v1/allele/{name}/history", r, 200, problems, b)

    r = fetch(api + "/v1/report", "POST", REPORT_VALID)
    b = as_json(r["text"]) or {}
    problems = []
    if r["status"] == 200:
        if b.get("ok") is not True or b.get("status") != "received" or not b.get("id"):
            problems.append(f"body ok={b.get('ok')!r} status={b.get('status')!r} id={bool(b.get('id'))}")
        if b.get("release") != healthz_release:
            problems.append(f"release {b.get('release')!r} != /healthz {healthz_release!r}")
    check("report_valid", "POST /v1/report (valid)", r, 200, problems, b)

    r = fetch(api + "/v1/report", "POST", REPORT_INVALID)
    b = as_json(r["text"]) or {}
    problems = []
    if r["status"] == 422 and "input" not in str(b.get("detail", "")):
        problems.append(f"detail does not name the input field: {str(b.get('detail'))[:80]!r}")
    check("report_invalid", "POST /v1/report (empty input)", r, 422, problems, b)

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

    api_calls = [c for c in CALLS if c["host"] == urllib.parse.urlsplit(api).netloc]
    out["latency"], out["warnings"] = latency_report(api_calls)
    out["failures"] = failures
    out["ok"] = not failures
    return out


def summary(res: dict) -> str:
    lines = [f"### HLA-Verify probe {res['probed_at']} — {'OK' if res['ok'] else 'FAILURES: ' + str(len(res['failures']))}",
             f"API `{res['api']}` release {res['release']['healthz']} (documents agree: {res['release']['agree']}); "
             f"{res['billable_calls']} billable anonymous calls spent.", ""]
    if res["failures"]:
        lines += ["**Failures**", ""] + [f"- {f}" for f in res["failures"]] + [""]
    lat = res.get("latency")
    if lat:
        lines += [f"Latency: {lat['calls']} API calls, p50 {lat['p50_ms']} ms, max {lat['max_ms']} ms ({lat['slowest']}); "
                  f"slow limit {lat['slow_limit_ms']} ms, batch budget {lat['batch_budget_ms']} ms.", ""]
    if res.get("warnings"):
        lines += ["**Latency warnings** (not failures)", ""] + [f"- {w}" for w in res["warnings"]] + [""]
    lines += ["| document | HTTP | ms | release |", "|---|---:|---:|---|"]
    lines += [f"| `{d['path']}` | {d['http']} | {d['ms']} | {d['release'] or ''} |" for d in res["documents"]]
    lines += ["", "| allele | HTTP | status | flags | ms | ok |", "|---|---:|---|---|---:|---|"]
    lines += [f"| `{p['name']}` | {p['http']} | {p['status'] or ''} | {' '.join(p.get('flags') or [])} | {p['ms']} | {'yes' if p['ok'] else 'NO'} |"
              for p in res["panel"]]
    v, n = res["verify"], res["normalize"]
    lines += ["", f"- `/v1/verify`: HTTP {v['http']}, {v['ms']} ms, {'ok' if v['ok'] else 'MISMATCH'} — {v['tokens']}",
              f"- `/v1/normalize`: HTTP {n['http']}, {n['ms']} ms, {'ok' if n['ok'] else 'MISMATCH'}"]
    for key, label in (("releases", "GET /v1/releases"), ("releases_diff", "GET /v1/releases/diff"),
                       ("translate", "POST /v1/translate"), ("allele_history", "GET /v1/allele/{name}/history"),
                       ("report_valid", "POST /v1/report (valid)"), ("report_invalid", "POST /v1/report (empty input)")):
        x = res.get(key)
        if x:
            lines.append(f"- `{label}`: HTTP {x['http']}, {x['ms']} ms, {'ok' if x['ok'] else 'MISMATCH'}")
    nb, pg = res.get("normalize_batch"), res.get("pgx_screen")
    if nb:
        lines.append(f"- `/v1/normalize` batch of {nb['names']}: HTTP {nb['http']}, {nb['rows']} rows, {nb['ms']} ms, "
                     f"{'ok' if nb['ok'] else 'MISMATCH'} (current_name compared: {nb['compared_current_name']})")
    if pg:
        lines.append(f"- `/v1/pgx/screen`: HTTP {pg['http']}, {pg['ms']} ms, {'ok' if pg['ok'] else 'MISMATCH'} — "
                     f"abacavir actionable {pg['abacavir_actionable']}, deprecated_name flag {pg['deprecated_name_flag']}")
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
    for w in res.get("warnings", []):
        print(f"::warning::{w}")
    if not res["ok"]:
        for fl in res["failures"]:
            print(f"::error::{fl}")
    return 0 if res["ok"] or a.no_fail else 1


if __name__ == "__main__":
    sys.exit(main())
