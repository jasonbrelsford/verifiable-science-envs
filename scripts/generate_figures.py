"""Render the preprint's Figure 1 (Family A accuracy by model) as a static SVG.

The preprint draft (`docs/paper/hla-bench-draft.md`) has a "no figures" gap
(see its TODO list). Its committed results already answer this one: the
headline table in `bench/HLA-Bench-A.md` (`Split == all`). No plotting
dependency is added for one chart — this writes SVG `<rect>`/`<text>`
elements by hand, deterministic from the committed markdown table, so the
figure regenerates identically whenever the table does.

Usage:
    python scripts/generate_figures.py
    python scripts/generate_figures.py --bench bench/HLA-Bench-A.md --out docs/paper/figures/family-a-accuracy-by-model.svg
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROW_RE = re.compile(
    r"^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)%\s"
)

BASELINE_PREFIX = "baseline-"
ORACLE_PREFIX = "oracle-"


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
        m = ROW_RE.match(line)
        if not m:
            continue
        model, split, n, acc = m.groups()
        if split != "all":
            continue
        rows.append({"model": model, "n": int(n), "accuracy": float(acc)})
    rows.sort(key=lambda r: r["accuracy"], reverse=True)
    return rows


def bar_color(model: str) -> str:
    if model.startswith(ORACLE_PREFIX):
        return "#6b7280"  # neutral gray: validates the harness, not a model result
    if model.startswith(BASELINE_PREFIX):
        return "#94a3b8"  # muted slate: non-LLM baselines
    return "#2563eb"  # blue: evaluated models


def render_svg(rows: list[dict]) -> str:
    row_h = 28
    pad = 8
    label_w = 220
    chart_w = 420
    top = 40
    width = label_w + chart_w + 60
    height = top + row_h * len(rows) + pad
    max_acc = 100.0

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" font-family="Helvetica, Arial, sans-serif" font-size="12">',
        f'<text x="{label_w}" y="20" font-size="13" font-weight="bold">'
        f'Family A accuracy by model (all 550 tasks)</text>',
    ]
    for i, row in enumerate(rows):
        y = top + i * row_h
        bar_w = chart_w * (row["accuracy"] / max_acc)
        color = bar_color(row["model"])
        parts.append(
            f'<text x="{label_w - 6}" y="{y + row_h * 0.65:.0f}" text-anchor="end">{row["model"]}</text>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y + 4}" width="{bar_w:.1f}" height="{row_h - 10}" fill="{color}" />'
        )
        parts.append(
            f'<text x="{label_w + bar_w + 6:.1f}" y="{y + row_h * 0.65:.0f}">{row["accuracy"]:.0f}%</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bench", default="bench/HLA-Bench-A.md")
    ap.add_argument("--out", default="docs/paper/figures/family-a-accuracy-by-model.svg")
    args = ap.parse_args()

    text = Path(args.bench).read_text()
    rows = parse_headline(text)
    if not rows:
        raise SystemExit(f"no 'all'-split rows parsed from {args.bench}'s Headline table")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_svg(rows) + "\n")
    print(f"wrote {out_path} ({len(rows)} models)")


if __name__ == "__main__":
    main()
