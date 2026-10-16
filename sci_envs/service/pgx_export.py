"""Vendor the hla-pgx-open table for the edge Worker's /v1/pgx/* routes.

Fetches ``data/hla_pgx.json``, ``manifest.json`` and ``ATTRIBUTION.md`` from the
public hla-pgx-open repository (CC BY-SA 4.0; CPIC + PharmGKB associations keyed by
two-field HLA allele) and writes ``edge/public/pgx.json``, a single bundle the Worker
loads beside the IPD-IMGT/HLA tables — never inside them: the verification engine's
"no licensed tables" promise is untouched because this file is only read by
edge/src/pgx.js.

Called from ``edge_export.export()`` on every deploy. Standalone:

    python -m sci_envs.service.pgx_export [--out edge/public] [--ref main]

Deploy rules (issue #112):
  * the deploy FAILS if the manifest says either upstream source was not ok, or the
    snapshot is older than 60 days — a stale or half-built table must not ship;
  * on a fetch failure it fails CLOSED on a first deploy (no previous bundle) and
    OPEN on a refresh (a previous ``pgx.json`` exists and is kept, with a warning).
The snapshot's git commit is pinned into the bundle and surfaced by the Worker as
``pgx_snapshot`` on every response.  Licence: PolyForm Noncommercial 1.0.0
(sci_envs/service/LICENSE); the data it bundles stays CC BY-SA 4.0.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from sci_envs.reference.netfetch import fetch_bytes

REPO_RAW = "https://raw.githubusercontent.com/jasonbrelsford/hla-pgx-open/{ref}/{path}"
MAX_AGE_DAYS = 60
BUNDLE_VERSION = 1

FALLBACK_ATTRIBUTION = (
    "hla-pgx-open (https://github.com/jasonbrelsford/hla-pgx-open), CC BY-SA 4.0. Compiled from the "
    "CPIC guideline database (https://cpicpgx.org, CC0) and PharmGKB clinical annotations "
    "(https://www.pharmgkb.org, CC BY-SA 4.0). Allele names checked against IPD-IMGT/HLA."
)


class PgxExportError(RuntimeError):
    pass


def _fetch(url: str, timeout: float = 60.0) -> bytes:
    return fetch_bytes(url, headers={"user-agent": "hlaverify-pgx-export/1"}, timeout=timeout)


def bundle(table: list[dict], manifest: dict, attribution: str | None,
           now: dt.date | None = None) -> dict:
    """Validate the upstream manifest and shape the Worker's bundle.

    Pure: raises PgxExportError on a manifest that must not ship; otherwise returns the
    dict ``edge/public/pgx.json`` holds.  ``now`` is injectable for tests.
    """
    if not isinstance(table, list) or not table:
        raise PgxExportError("hla_pgx.json is not a non-empty list of rows")
    sources = manifest.get("sources") or {}
    for src in ("cpic", "pharmgkb"):
        if not (sources.get(src) or {}).get("ok"):
            raise PgxExportError(f"manifest.sources.{src}.ok is not true — refusing to ship a half-built table")
    snap = manifest.get("snapshot_date")
    try:
        snap_date = dt.date.fromisoformat(str(snap))
    except (TypeError, ValueError):
        raise PgxExportError(f"manifest.snapshot_date is not an ISO date: {snap!r}") from None
    today = now or dt.datetime.now(dt.timezone.utc).date()
    age = (today - snap_date).days
    if age > MAX_AGE_DAYS:
        raise PgxExportError(f"snapshot {snap} is {age} days old (limit {MAX_AGE_DAYS}) — the weekly rebuild has stalled")
    required = {"source", "gene", "allele", "allele_status", "drug", "evidence_level"}
    bad = [i for i, r in enumerate(table) if not isinstance(r, dict) or not required <= set(r)]
    if bad:
        raise PgxExportError(f"{len(bad)} rows lack the required columns (first: row {bad[0]})")
    return {
        "bundle_version": BUNDLE_VERSION,
        "snapshot": {
            "date": str(snap),
            "commit": manifest.get("git_commit"),
            "built_at": manifest.get("built_at"),
        },
        "license": manifest.get("license", "CC-BY-SA-4.0"),
        "sources": {
            "cpic": {k: v for k, v in (sources.get("cpic") or {}).items() if k in ("base_url", "ok", "pairs", "recommendations")},
            "pharmgkb": {k: v for k, v in (sources.get("pharmgkb") or {}).items() if k in ("url_used", "ok", "created_stamp", "annotations", "allele_rows")},
            "hlaverify": {k: v for k, v in (sources.get("hlaverify") or {}).items() if k in ("ok", "ipd_release", "alleles_checked")},
        },
        "attribution": (attribution or "").strip() or FALLBACK_ATTRIBUTION,
        "rows": table,
    }


def fetch_bundle(ref: str = "main", now: dt.date | None = None) -> dict:
    table = json.loads(_fetch(REPO_RAW.format(ref=ref, path="data/hla_pgx.json")))
    manifest = json.loads(_fetch(REPO_RAW.format(ref=ref, path="data/manifest.json")))
    try:
        attribution = _fetch(REPO_RAW.format(ref=ref, path="ATTRIBUTION.md")).decode("utf-8")
    except Exception:  # noqa: BLE001 - attribution text is nice-to-have; the fallback names the sources
        attribution = None
    return bundle(table, manifest, attribution, now=now)


def export(out: Path, ref: str = "main") -> dict | None:
    """Write ``<out>/pgx.json``. Returns the bundle written, or the kept previous one."""
    out = Path(out)
    target = out / "pgx.json"
    try:
        b = fetch_bundle(ref)
    except PgxExportError:
        raise
    except Exception as e:  # noqa: BLE001 - network: fail closed first time, open on refresh
        if target.exists():
            print(f"pgx_export: fetch failed ({e!r}); keeping the previous {target}", file=sys.stderr)
            return json.loads(target.read_text(encoding="utf-8"))
        raise PgxExportError(f"could not fetch hla-pgx-open and no previous {target} exists: {e!r}") from e
    out.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(b, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"pgx_export: {len(b['rows'])} rows, snapshot {b['snapshot']['date']} "
          f"({(b['snapshot']['commit'] or '')[:7]}) -> {target}")
    return b


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="edge/public")
    ap.add_argument("--ref", default="main", help="git ref of jasonbrelsford/hla-pgx-open to vendor")
    a = ap.parse_args()
    export(Path(a.out), a.ref)


if __name__ == "__main__":
    main()
