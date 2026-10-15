"""Per-name verdict diff between two IPD-IMGT/HLA release tags.

`docs/RELEASE_BUMP.md` step 6 wants the quarterly customer notice to cite "a
diff of every verdict that changed" rather than say none was computed. No
per-account query log is kept (requests aren't logged), so per that same
step the fallback is "a general before/after diff of the full allele table":
which names were newly assigned (verdict was `hallucinated` or a
`valid`-prefix, now `valid` as a full name) and which were removed from the
current table (verdict was `valid`, now `deleted`, with a successor name
when the release records a rename). Assigned full-resolution allele names
never retroactively change their own 2-field/G-group once published, so
those two categories are the whole diff surface.

Usage:
    python scripts/release_diff.py v3.65.0-alpha v3.66.0-alpha
    python scripts/release_diff.py v3.65.0-alpha v3.66.0-alpha --out notice.md --json diff.json

The JSON is also what hlaverify.com/releases renders (hlaverify-website,
`src/releases/<old>-to-<new>.json`, see docs/RELEASE_BUMP.md step 7): its
`removed` list carries, for every name that left the current table, the
verdict `/v1/verify` gave it under the old release and under the new one, and
the successor the new release records, so the page can say what a caller will
actually see rather than just that the name went.

Fetches both releases the same way every other reference load does (cached
under ~/.cache/sci_envs/imgt, md5-verified). No secrets, no network calls
outside the existing IMGT/HLA mirror fetch, no Stripe/Cloudflare/deploy.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter

from sci_envs.reference.imgt import ImgtReference


def diff_releases(old_tag: str, new_tag: str) -> dict:
    old = ImgtReference.load(old_tag)
    new = ImgtReference.load(new_tag)
    old_names = set(old.alleles())
    new_names = set(new.alleles())

    added = sorted(new_names - old_names)
    deleted = sorted(old_names - new_names)
    renamed = [{"name": n, "successor": new.renamed_to(n)} for n in deleted if new.is_deleted(n)]
    removed = [{"name": n, "was": verdict_of(old, n), "now": verdict_of(new, n), "successor": new.renamed_to(n)}
               for n in deleted]

    def by_locus(names: list[str]) -> dict:
        return dict(sorted(Counter(n.split("*", 1)[0] for n in names).items()))

    return {
        "old_tag": old_tag, "new_tag": new_tag,
        "old_release": old.release, "new_release": new.release,
        "added_count": len(added), "deleted_count": len(deleted),
        "renamed_count": sum(1 for r in renamed if r["successor"]),
        "added_by_locus": by_locus(added), "deleted_by_locus": by_locus(deleted),
        "removed_now": dict(sorted(Counter(r["now"] for r in removed).items())),
        "added": added, "deleted": deleted, "renamed": renamed, "removed": removed,
    }


def verdict_of(ref: ImgtReference, name: str) -> str:
    """The /v1/verify status this release gives one allele name (valid, deleted,
    hallucinated, ...), via the same classifier the service uses. A name that
    was extended to a longer one (A*01:284 -> A*01:284:01) stays `valid` as a
    prefix, so most names that leave the table do not change verdict at all."""
    for status, toks in ref.classify_tokens(name).items():
        if name in toks:
            return status
    return "hallucinated"


def render_markdown(d: dict) -> str:
    lines = [
        f"# IPD-IMGT/HLA verdict diff: {d['old_release']} -> {d['new_release']}",
        "",
        f"- **{d['added_count']}** names newly assigned (verdict was `hallucinated` or a "
        "`valid`-prefix, now `valid` as a full name).",
        f"- **{d['deleted_count']}** names removed from the current table (verdict was "
        f"`valid`, now `deleted`); **{d['renamed_count']}** of those have a recorded successor.",
        "",
        "## Added, by locus",
        "",
    ]
    lines += [f"- {locus}: {n}" for locus, n in d["added_by_locus"].items()] or ["- (none)"]
    lines += ["", "## Deleted, by locus", ""]
    lines += [f"- {locus}: {n}" for locus, n in d["deleted_by_locus"].items()] or ["- (none)"]
    renames = [r for r in d["renamed"] if r["successor"]]
    if renames:
        lines += ["", "## Renamed (deleted name -> successor)", ""]
        lines += [f"- `{r['name']}` -> `{r['successor']}`" for r in renames]
    if d.get("removed"):
        lines += ["", "## Removed names: verdict before and after", "",
                  "| Name | Was | Now | Successor recorded |", "|---|---|---|---|"]
        lines += [f"| `{r['name']}` | {r['was']} | {r['now']} | "
                  f"{('`' + r['successor'] + '`') if r['successor'] else '(none)'} |" for r in d["removed"]]
    return "\n".join(lines) + "\n"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("old_tag", help="e.g. v3.65.0-alpha")
    p.add_argument("new_tag", help="e.g. v3.66.0-alpha")
    p.add_argument("--out", help="write the markdown report here instead of stdout")
    p.add_argument("--json", help="also write the full machine-readable diff (name lists included) here")
    args = p.parse_args()

    d = diff_releases(args.old_tag, args.new_tag)
    md = render_markdown(d)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md)
    else:
        print(md)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(d, f, indent=2)


if __name__ == "__main__":
    main()
