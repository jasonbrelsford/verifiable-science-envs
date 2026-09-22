"""Render the preprint's Family A figures (accuracy and wrong-but-overconfident
rate, both by model) as static SVGs.

The preprint draft (`docs/paper/hla-bench-draft.md`) has a "no figures" gap
(see its TODO list). Its committed results already answer this one: the
headline and failure-modes tables in `bench/HLA-Bench-A.md` (`Split == all`).
No plotting dependency is added for two charts — this writes SVG
`<rect>`/`<text>` elements by hand, deterministic from the committed markdown
tables, so the figures regenerate identically whenever the tables do.

Usage:
    python scripts/generate_figures.py
    python scripts/generate_figures.py --bench bench/HLA-Bench-A.md --out-dir docs/paper/figures
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

HEADLINE_ROW_RE = re.compile(
    r"^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)%\s"
)

FAILURE_MODES_ROW_RE = re.compile(
    r"^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|" + r"\s*(\d+)\s*\|" * 11
)

BASELINE_PREFIX = "baseline-"
ORACLE_PREFIX = "oracle-"


def _strip_footnote_markers(line: str) -> str:
    """Drop markdown's escaped `\\*` footnote markers (e.g. the claude-sonnet-4-6
    lower-bound caveat) so they don't break the fixed-column row regexes."""
    return line.replace("\\*", "")


def parse_headline(text: str) -> list[dict]:
    rows = []
    in_headline = False
    for line in text.splitlines():
        if line.startswith("## Headline"):
            in_headline = True
            continue
        if in_headline and line.startswith("## "):
            break
        if not in_headline:
            continue
        m = HEADLINE_ROW_RE.match(_strip_footnote_markers(line))
        if not m:
            continue
        model, split, n, acc = m.groups()
        if split != "all":
            continue
        rows.append({"model": model, "n": int(n), "accuracy": float(acc)})
    rows.sort(key=lambda r: r["accuracy"], reverse=True)
    return rows


def parse_wrong_but_overconfident_rate(text: str, n_by_model: dict[str, int]) -> list[dict]:
    """`wrong_but_overconfident` count (9th failure-mode column) / n, all split."""
    rows = []
    in_section = False
    for line in text.splitlines():
        if line.startswith("## Failure modes"):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if not in_section:
            continue
        m = FAILURE_MODES_ROW_RE.match(_strip_footnote_markers(line))
        if not m:
            continue
        model, split = m.group(1), m.group(2)
        if split != "all":
            continue
        wrong_but_overconfident = int(m.group(11))
        n = n_by_model.get(model)
        if n is None:
            continue
        rows.append({"model": model, "n": n, "rate": 100.0 * wrong_but_overconfident / n})
    rows.sort(key=lambda r: r["rate"], reverse=True)
    return rows


def bar_color(model: str) -> str:
    if model.startswith(ORACLE_PREFIX):
        return "#6b7280"  # neutral gray: validates the harness, not a model result
    if model.startswith(BASELINE_PREFIX):
        return "#94a3b8"  # muted slate: non-LLM baselines
    return "#2563eb"  # blue: evaluated models


def render_svg(rows: list[dict], title: str, value_key: str = "accuracy") -> str:
    row_h = 28
    pad = 8
    label_w = 220
    chart_w = 420
    top = 40
    width = label_w + chart_w + 60
    height = top + row_h * len(rows) + pad
    max_val = 100.0

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" font-family="Helvetica, Arial, sans-serif" font-size="12">',
        f'<text x="{label_w}" y="20" font-size="13" font-weight="bold">{title}</text>',
    ]
    for i, row in enumerate(rows):
        y = top + i * row_h
        bar_w = chart_w * (row[value_key] / max_val)
        color = bar_color(row["model"])
        parts.append(
            f'<text x="{label_w - 6}" y="{y + row_h * 0.65:.0f}" text-anchor="end">{row["model"]}</text>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y + 4}" width="{bar_w:.1f}" height="{row_h - 10}" fill="{color}" />'
        )
        parts.append(
            f'<text x="{label_w + bar_w + 6:.1f}" y="{y + row_h * 0.65:.0f}">{row[value_key]:.0f}%</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bench", default="bench/HLA-Bench-A.md")
    ap.add_argument("--out-dir", default="docs/paper/figures")
    args = ap.parse_args()

    text = Path(args.bench).read_text()
    headline_rows = parse_headline(text)
    if not headline_rows:
        raise SystemExit(f"no 'all'-split rows parsed from {args.bench}'s Headline table")
    n_by_model = {r["model"]: r["n"] for r in headline_rows}
    overconfident_rows = parse_wrong_but_overconfident_rate(text, n_by_model)
    if not overconfident_rows:
        raise SystemExit(f"no 'all'-split rows parsed from {args.bench}'s Failure modes table")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    accuracy_svg = render_svg(
        headline_rows, "Family A accuracy by model (all 550 tasks)", "accuracy"
    )
    (out_dir / "family-a-accuracy-by-model.svg").write_text(accuracy_svg + "\n")
    print(f"wrote {out_dir / 'family-a-accuracy-by-model.svg'} ({len(headline_rows)} models)")

    overconfident_svg = render_svg(
        overconfident_rows,
        "Family A wrong-but-overconfident rate by model (all 550 tasks)",
        "rate",
    )
    (out_dir / "family-a-wrong-but-overconfident-by-model.svg").write_text(overconfident_svg + "\n")
    print(
        f"wrote {out_dir / 'family-a-wrong-but-overconfident-by-model.svg'} "
        f"({len(overconfident_rows)} models)"
    )


if __name__ == "__main__":
    main()
