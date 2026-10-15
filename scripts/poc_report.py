#!/usr/bin/env python3
"""HLA-Verify trial report: run your own typing data through HLA-Verify and see what it finds.

WHAT IT DOES. Reads a file you already have (a LIMS export, a CSV or TSV, a typing
report saved as text), finds every HLA allele name in it, and checks each distinct
name against the pinned IPD-IMGT/HLA release with POST /v1/normalize. It writes
two files next to the input:

  <input>.hlaverify-report.md   one page: how many names need attention, by kind,
                                with examples, plus how fast the run was
  <input>.hlaverify-names.csv   every distinct name: how often it appears, its
                                current name, 2-field name, G group and flags

WHAT LEAVES YOUR MACHINE. Only the allele names themselves (for example
"A*0201" or "DRB1*15:01:01"), deduplicated. Every other column and every other
word in the file stays here: patient names, record numbers and dates are never
read into a request. HLA-Verify processes the names in memory and stores none
of them. Read this file to check: the only network call is post_batch().

REQUIREMENTS: Python 3.8+ and nothing else. Excel files: save as CSV first.

USAGE
  python3 poc_report.py typings.csv                      # anonymous: 250 names a call, 100 calls a day
  HLAVERIFY_API_KEY=hlv_... python3 poc_report.py export.tsv
  python3 poc_report.py report.txt --key hlv_... --api https://api.hlaverify.com

Founding-lab trial keys and every other key work the same way. Questions, or a
result you think is wrong: https://hlaverify.com/support

Licence: Apache-2.0, like the engine.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.hlaverify.com"
UA = "hlaverify-poc-report/1.0 (+https://hlaverify.com)"
# Anything allele-shaped: an optional HLA- prefix, a locus, a star, then fields.
# Deliberately generous (legacy colon-less names, G/P/N/L/S/Q suffixes, XX and MAC
# codes); the API decides what each one is.
ALLELE = re.compile(r"\b(?:HLA-)?(?:[A-Z][A-Za-z0-9]{0,5})\*[0-9]{2,4}(?::?[0-9A-Z]{2,5}){0,3}[A-Z]?\b")
FALLBACK_BATCH = 250

# How each kind of finding is described on the report, in the order shown.
KINDS = [
    ("nonexistent", "Not in any IPD-IMGT/HLA release (typos, fabricated or mistyped names)",
     lambda r: "nonexistent_allele" in r["flags"] or "unresolvable_allele" in r["flags"]
     or r["current_name"] == "UNRESOLVABLE"),
    ("renamed", "Deleted or renamed: the current name is different",
     lambda r: "renamed_allele" in r["flags"]
     or (r["current_name"] not in ("UNRESOLVABLE", r["reported"]) and "deprecated_name" not in r["flags"])),
    ("legacy", "Outdated spelling (pre-2010 colon-less names, Cw*, legacy forms)",
     lambda r: "deprecated_name" in r["flags"] or "lg_notation" in r["flags"]),
    ("null", "Null alleles (not expressed): worth a second look in a match",
     lambda r: "null_allele" in r["flags"]),
    ("codes", "Ambiguity codes (NMDP MAC or XX): not a single allele",
     lambda r: "mac_code" in r["flags"] or "xx_code" in r["flags"]),
    ("groups", "G or P group names used where an allele may be expected",
     lambda r: "g_group_name" in r["flags"] or "p_group_name" in r["flags"] or "allele_group" in r["flags"]),
]


def read_names(path: Path) -> collections.Counter:
    """Distinct allele names and how often each appears. Only the names are kept."""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return collections.Counter(m.group(0) for m in ALLELE.finditer(text))


def post_batch(api: str, key: str | None, names: list[str]) -> tuple[dict, dict, float]:
    """The only network call: the names in one batch, nothing else."""
    headers = {"content-type": "application/json", "user-agent": UA}
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(api.rstrip("/") + "/v1/normalize", method="POST",
                                 data=json.dumps({"typings": names}).encode(), headers=headers)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body, hdrs = json.loads(resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", "")
        except Exception:
            detail = ""
        sys.exit(f"HLA-Verify answered HTTP {e.code}: {detail or e.reason}")
    except urllib.error.URLError as e:
        sys.exit(f"Could not reach {api}: {e.reason}")
    return body, {k.lower(): v for k, v in hdrs.items()}, time.perf_counter() - t0


def classify(row: dict) -> list[str]:
    return [k for k, _, test in KINDS if test(row)]


def main() -> int:
    ap = argparse.ArgumentParser(description="Run your typing data through HLA-Verify and write a one-page report.")
    ap.add_argument("input", type=Path, help="CSV, TSV or text file containing HLA allele names")
    ap.add_argument("--key", default=os.environ.get("HLAVERIFY_API_KEY"), help="API key (or set HLAVERIFY_API_KEY)")
    ap.add_argument("--api", default=API, help=argparse.SUPPRESS)
    args = ap.parse_args()

    counts = read_names(args.input)
    if not counts:
        print(f"No HLA allele names found in {args.input}.")
        return 1
    names = sorted(counts)
    print(f"{sum(counts.values()):,} allele names found, {len(names):,} distinct. Only the distinct names are sent.")

    rows, timings, release, batch, tier = {}, [], None, FALLBACK_BATCH, "anonymous"
    i = 0
    while i < len(names):
        chunk = names[i:i + batch]
        body, hdrs, secs = post_batch(args.api, args.key, chunk)
        timings.append((len(chunk), secs))
        release = body.get("release", release)
        for r in body.get("rows", []):
            rows[r["reported"]] = r
        tier = hdrs.get("x-hla-verify-tier", tier)
        cap = hdrs.get("x-hla-verify-max-typings")
        i += len(chunk)
        if cap and cap.isdigit() and int(cap) != batch:
            batch = int(cap)  # the first answer tells us this key's batch size
        print(f"  checked {i:,}/{len(names):,} ({secs:.2f}s)")

    found = {k: [] for k, _, _ in KINDS}
    for n in names:
        r = rows.get(n)
        if not r:
            continue
        for k in classify(r):
            found[k].append(n)
    attention = {n for k in ("nonexistent", "renamed", "legacy") for n in found[k]}
    occ_attention = sum(counts[n] for n in attention)
    total_secs = sum(s for _, s in timings)
    rate = len(names) / total_secs if total_secs else 0

    stem = str(args.input)
    with open(stem + ".hlaverify-names.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "occurrences", "current_name", "allele_2field", "g_group", "flags", "findings"])
        for n in names:
            r = rows.get(n, {})
            w.writerow([n, counts[n], r.get("current_name", ""), r.get("allele_2field", ""), r.get("g_group", ""),
                        " ".join(r.get("flags", [])), " ".join(classify(r)) if r else "not checked"])

    def examples(k, limit=8):
        out = []
        for n in sorted(found[k], key=lambda n: -counts[n])[:limit]:
            r = rows[n]
            arrow = f" → {r['current_name']}" if r["current_name"] not in (n, "UNRESOLVABLE") else ""
            out.append(f"`{n}`{arrow} ({counts[n]}×)")
        return ", ".join(out)

    lines = [
        f"# HLA-Verify trial report: {args.input.name}",
        "",
        f"Checked {dt.date.today().isoformat()} against IPD-IMGT/HLA **{release}** "
        f"({tier} access). Only the distinct allele names left this machine.",
        "",
        "## Summary",
        "",
        "| | |",
        "|---|---:|",
        f"| Allele names in the file | {sum(counts.values()):,} |",
        f"| Distinct names checked | {len(names):,} |",
        f"| **Distinct names that need attention** | **{len(attention):,}** ({len(attention) / len(names):.1%}) |",
        f"| Occurrences of those names in the file | {occ_attention:,} |",
        f"| Time to check every name | {total_secs:.1f} s ({rate:,.0f} names a second, {len(timings)} call(s)) |",
        "",
        "## What was found",
        "",
        "| Finding | Distinct names | Examples (most frequent first) |",
        "|---|---:|---|",
    ]
    for k, label, _ in KINDS:
        if found[k]:
            lines.append(f"| {label} | {len(found[k]):,} | {examples(k)} |")
    if not any(found.values()):
        lines.append("| Nothing: every name is current and valid in this release | 0 | |")
    lines += [
        "",
        "\"Need attention\" counts names that do not exist in any release, were deleted or renamed, or use an "
        "outdated spelling. Null alleles, ambiguity codes and group names are listed for review but may be "
        "exactly what you meant.",
        "",
        f"Every distinct name, with its current name, 2-field name, G group and flags: `{Path(stem).name}.hlaverify-names.csv`.",
        "",
        "Think a result is wrong? Report it at https://hlaverify.com/support; every report is reviewed by a person "
        "and confirmed errors are fixed and published.",
    ]
    Path(stem + ".hlaverify-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n{len(attention):,} of {len(names):,} distinct names need attention ({total_secs:.1f}s).")
    print(f"Report: {stem}.hlaverify-report.md\nAll names: {stem}.hlaverify-names.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
