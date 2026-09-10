"""Export the pinned IPD-IMGT/HLA release as sharded lookup tables for the
edge Worker (edge/).  Every fact in every shard is computed by the same
Python engine that grades HLA-Bench — the Worker only tokenizes, converts
legacy strings, and looks rows up.  Licence: PolyForm Noncommercial 1.0.0
(sci_envs/service/LICENSE).

Run:  python -m sci_envs.service.edge_export [--tag v3.65.0-alpha] [--out edge/public]

Row schema (compact keys; absent = null/false):
  s    classify status: v=valid (assigned or valid prefix), g=G/P group, d=deleted/historical
  dl   true if the name is in Deleted_alleles.txt (is_deleted)
  succ successor (renamed_to) for s=d
  rn   resolve_name() -> current name (null if unresolvable)
  rf   resolve_name() flags
  n2/ng/nf  normalize(): allele_2field, g_group, flags
  ag   antigen_of() (WMDA antigen, '∅' null, '?' uncertain)
  ex   true if assigned in this release (exists)
  g/p  G / P group of an assigned allele
  fr   first release the exact name appeared
  c    confirmed
  se   serology columns {unambiguous,possible,assumed,expert}
  mc/ms members_count / first 10 members for a valid prefix
"""
from __future__ import annotations

import argparse
import dataclasses
import functools
import json
import os
import re
import time
from pathlib import Path

from sci_envs.reference.imgt import ImgtReference, ImgtError, GROUP_RE, split_allele
from sci_envs.families.nomenclature.normalize import normalize, resolve_name
from sci_envs.families.matching.rules import antigen_of

SHARD_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{2})")


def shard_of(name: str) -> str | None:
    """Shard path for a name: '<locus>/<first two digits>'. Mirrors edge/src/engine.js shardOf()."""
    m = SHARD_RE.match(name)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _classify_one(r: ImgtReference, t: str) -> str | None:
    """The classify_tokens() branch order for one token; None = hallucinated."""
    if r.exists(t):
        return "v"
    if r.is_group_name(t):
        return "g"
    if r._valid_prefix(t):
        return "v"
    if GROUP_RE.match(t):
        return None  # fabricated_group — never exported
    if r.is_deleted(t) or (r.ids_for_name_ever(t) and not r.exists(t)):
        return "d"
    return None


def _row(r: ImgtReference, key: str) -> dict | None:
    s = _classify_one(r, key)
    if s is None:
        return None
    row: dict = {"s": s}
    if r.is_deleted(key):
        row["dl"] = True
    if s == "d" or row.get("dl"):   # a deleted name can also be a valid prefix of its successor
        succ = r.renamed_to(key)
        if succ:
            row["succ"] = succ
    rn, rf = resolve_name(r, key)
    row["rn"] = rn
    if rf:
        row["rf"] = sorted(rf)
    n = normalize(r, key)
    row["n2"], row["ng"] = n["allele_2field"], n["g_group"]
    if n["flags"]:
        row["nf"] = n["flags"].split(";")
    row["ag"] = antigen_of(r, key)
    if s == "v":
        if r.exists(key):
            row["ex"] = True
            row["g"], row["p"] = r.g_group(key), r.p_group(key)
            row["fr"], row["c"] = r.first_release(key), r.confirmed(key)
            sero = r.serology(key)
            if sero is not None:
                d = dataclasses.asdict(sero)
                row["se"] = {k: list(v) for k, v in d.items() if k != "allele" and v}  # {} is real
        else:
            members = r.expand(key if not split_allele(key)[2] else
                               f"{split_allele(key)[0]}*{':'.join(split_allele(key)[1])}")
            if split_allele(key)[2]:
                members = [m for m in members if split_allele(m)[2] == split_allele(key)[2]]
            row["mc"], row["ms"] = len(members), members[:10]
    return {k: v for k, v in row.items() if v is not None and v is not False}


def keys_for(r: ImgtReference) -> set[str]:
    keys: set[str] = set()
    alleles = r.alleles()
    keys.update(alleles)
    prefixes: dict[str, set[str]] = {}
    for a in alleles:
        loc, f, suf = split_allele(a)
        for n in range(1, min(3, len(f)) + 1):
            if n < len(f) or True:
                p = f"{loc}*{':'.join(f[:n])}"
                prefixes.setdefault(p, set()).add(suf)
    for p, sufs in prefixes.items():
        keys.add(p)
        if len(sufs) == 1:
            s = next(iter(sufs))
            if s:
                keys.add(p + s)
    keys.update(r.deleted.keys())
    keys.update(r._name_index.keys())
    keys.update(r._g[1].keys())
    keys.update(r._p[1].keys())
    # The engine accepts 'HLA-'-prefixed names as lower-resolution prefixes (ALLELE_RE
    # tolerates the prefix; exists() does not), and their normalization can differ from
    # the bare name's.  Export those forms too so the Worker never special-cases them.
    keys.update("HLA-" + k for k in list(keys) if not k.startswith("HLA-"))
    return keys


def export(tag: str, out: Path) -> dict:
    t0 = time.time()
    r = ImgtReference.load(tag)
    # memoize the two O(n) scans the normalizer leans on; pure functions of their argument
    r.alleles = functools.lru_cache(maxsize=None)(r.alleles)  # type: ignore[method-assign]
    r.expand = functools.lru_cache(maxsize=None)(r.expand)    # type: ignore[method-assign]
    keys = keys_for(r)
    shards: dict[str, dict[str, dict]] = {}
    n_rows = 0
    skipped = []
    for i, k in enumerate(sorted(keys)):
        sh = shard_of(k)
        if sh is None:
            skipped.append(k)
            continue
        row = _row(r, k)
        if row is None:
            skipped.append(k)
            continue
        shards.setdefault(sh, {})[k] = row
        n_rows += 1
        if i % 20000 == 0:
            print(f"  {i}/{len(keys)} keys, {round(time.time() - t0)}s", flush=True)
    data = out / "data"
    for sh, rows in shards.items():
        p = data / (sh + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    manifest = {
        "release": r.release, "tag": tag, "alleles": len(r.alleles()),
        "rows": n_rows, "shards": len(shards), "keys_skipped": len(skipped),
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attribution": ("Computed from IPD-IMGT/HLA (Barker DJ et al., Nucleic Acids Res 2025), "
                        "fetched at runtime from the ANHIG/IMGTHLA mirror under CC-BY-ND."),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"exported {n_rows} rows in {len(shards)} shards to {out} in {round(time.time() - t0)}s; "
          f"skipped {len(skipped)}: {skipped[:8]}")
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default=os.environ.get("HLA_VERIFY_TAG", "v3.65.0-alpha"))
    ap.add_argument("--out", default="edge/public")
    a = ap.parse_args()
    export(a.tag, Path(a.out))


if __name__ == "__main__":
    main()
