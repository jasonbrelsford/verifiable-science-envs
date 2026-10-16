"""Export the IPD-IMGT/HLA name history for the edge Worker's release endpoints.

Allelelist_history.txt gives every HLA ID's name in every release since 1.05.0. This
writes it in a form the Worker can answer three questions from without the 29 MB
source file (edge/src/history.js):

  translate   what is this name, from release X, called in release Y?
  diff        what was added, removed or renamed between releases X and Y?
  history     when did this name (and the allele behind it) appear, change, disappear?

Files, under <out>/history/ (licence: PolyForm Noncommercial 1.0.0):

  releases.json        {"releases": [oldest ... newest], "latest": "3.66.0", "loci": [...]}
  ids/<LOCUS>.json     {"HLA00001": {"t": [[from, to, name], ...], "d": {...}}}
                       t: runs of one name, as indexes into releases (inclusive);
                       d: {name: {"reason", "successor"}} for each of this ID's names in
                       Deleted_alleles.txt (a deletion retires a NAME: the ID may live
                       on under a new one); successor may be null.
                       LOCUS is the locus of the ID's newest name.
  names/<shard>.json   {"A*0101": [["HLA00001", "A"]], ...}: every name ever used ->
                       the IDs that carried it and the ids/ file each lives in;
                       shard as edge_export.shard_of().

Run by edge_export.export() after the release tables, or on its own:
    python -m sci_envs.service.history_export [--tag v3.66.0-alpha] [--out edge/public]
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from sci_envs.reference.imgt import ImgtReference

LOCUS_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*")
SHARD_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{2})")


def _locus(name: str) -> str | None:
    m = LOCUS_RE.match(name)
    return m.group(1) if m else None


def _shard(name: str) -> str | None:
    m = SHARD_RE.match(name)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def runs(row_oldest_first: list[str | None]) -> list[list]:
    """[[from, to, name], ...]: consecutive releases carrying the same name."""
    out: list[list] = []
    for i, nm in enumerate(row_oldest_first):
        if nm is None:
            continue
        if out and out[-1][2] == nm and out[-1][1] == i - 1:
            out[-1][1] = i
        else:
            out.append([i, i, nm])
    return out


def export(r: ImgtReference, out: Path) -> dict:
    newest_first, table = r._history
    if not newest_first:
        raise SystemExit("history_export: Allelelist_history.txt is missing from the reference")
    releases = list(reversed(newest_first))
    deleted_by_id: dict[str, dict] = {}
    for d in r.deleted.values():
        deleted_by_id.setdefault(d.hla_id, {})[d.name] = {"reason": d.description.strip(), "successor": d.successor}
    by_locus: dict[str, dict] = {}
    names: dict[str, dict[str, list]] = {}
    skipped = 0
    for hid, row in table.items():
        t = runs(list(reversed(row)))
        if not t:
            continue
        locus = _locus(t[-1][2])
        if locus is None:
            skipped += 1
            continue
        rec: dict = {"t": t}
        if hid in deleted_by_id:
            rec["d"] = deleted_by_id[hid]
        by_locus.setdefault(locus, {})[hid] = rec
        for _, _, nm in t:
            sh = _shard(nm)
            if sh is None:
                continue
            entry = names.setdefault(sh, {}).setdefault(nm, [])
            if [hid, locus] not in entry:
                entry.append([hid, locus])
    base = out / "history"
    (base / "ids").mkdir(parents=True, exist_ok=True)
    (base / "releases.json").write_text(json.dumps({"releases": releases, "latest": releases[-1], "loci": sorted(by_locus)}), encoding="utf-8")
    for locus, recs in by_locus.items():
        (base / "ids" / f"{locus}.json").write_text(json.dumps(recs, separators=(",", ":")), encoding="utf-8")
    for sh, rows in names.items():
        p = base / "names" / f"{sh}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    summary = {"releases": len(releases), "ids": sum(len(v) for v in by_locus.values()),
               "names": sum(len(v) for v in names.values()), "loci": len(by_locus), "skipped": skipped}
    print(f"history: {summary}")
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default=os.environ.get("HLA_VERIFY_TAG", "v3.66.0-alpha"))
    ap.add_argument("--out", default="edge/public")
    a = ap.parse_args()
    export(ImgtReference.load(a.tag), Path(a.out))


if __name__ == "__main__":
    main()
