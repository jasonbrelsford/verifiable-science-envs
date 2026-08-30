"""Render the HLA-Bench-A results page from results/*.json (summaries only)."""
from __future__ import annotations

import json
from pathlib import Path

TIERS = {1: "T1 syntax", 2: "T2 groups", 3: "T3 history", 4: "T4 adversarial"}
SLICES_SHOWN = ["null_allele", "unconfirmed", "partial_sequence", "post_cutoff", "deleted_name",
                "class_II_secondary_locus", "expression_suffix", "serology_uncertain"]


def _pct(cell: dict | None) -> str:
    if not cell or cell.get("acc") is None:
        return "—"
    lo, hi = cell["ci95"]
    return f"{100*cell['acc']:.0f}% <sub>[{max(0.0, 100*lo):.0f}–{min(100.0, 100*hi):.0f}]</sub>"


def render(suite_dir: Path, out: Path) -> Path:
    manifest = json.loads((suite_dir / "manifest.json").read_text())
    results = []
    for f in sorted((suite_dir / "results").glob("*.json")):
        results.append(json.loads(f.read_text()))
    results.sort(key=lambda r: (r["split"] != "test", -(r["overall"]["acc"] or 0)))
    bench = manifest["benchmark"]
    rel = manifest["reference"]["release"]

    L = []
    L.append(f"# {bench}\n")
    L.append("**Can a model resolve HLA allele names the way a clinical immunogenetics lab must?** "
             f"{manifest['total']} generated tasks, 20 subtypes in 4 tiers, graded by exact match against "
             f"IPD-IMGT/HLA release {rel} ({manifest['reference']['tag']}). No fuzzy credit. Fabricated allele names are the headline metric.\n")
    L.append(f"Dev split: {manifest['split']['dev']} tasks (public, `runs/hla-bench-a/dev/`). Sealed split: {manifest['split']['test']} tasks "
             f"(server-side). {100*manifest['cutoff_assumption']['post_cutoff_share_T3T4_allele_tasks']:.0f}% of Tier 3/4 allele tasks concern names "
             f"that did not exist at IMGT {manifest['cutoff_assumption']['release']} (assumed model cutoff). Regenerated every IPD release; this page is versioned.\n")

    L.append("## Headline\n")
    L.append("| Model | Split | n | Accuracy | Tasks with fabricated names | Fabricated / task | Calibrated | Most common outcome |")
    L.append("|---|---|---:|---:|---:|---:|---:|---|")
    for r in results:
        h = r["hallucination"]; top = max(r["primary_failure_modes"], key=r["primary_failure_modes"].get, default="—")
        L.append(f"| `{r['model']}` | {r['split']} | {r['n']} | {_pct(r['overall'])} | {h['tasks_with_hallucinated_names']} | "
                 f"{h['rate_per_task']:.2f} | {100*r['calibration']['calibrated_fraction']:.0f}% | `{top}` |")
    L.append("")

    L.append("## By tier\n")
    L.append("| Model | Split | " + " | ".join(TIERS.values()) + " |")
    L.append("|---|---|" + "---:|" * len(TIERS))
    for r in results:
        L.append(f"| `{r['model']}` | {r['split']} | " + " | ".join(_pct(r["by_tier"].get(str(t)) or r["by_tier"].get(t)) for t in TIERS) + " |")
    L.append("")

    L.append("## By slice (where clinical risk concentrates)\n")
    L.append("| Model | Split | " + " | ".join(f"`{s}`" for s in SLICES_SHOWN) + " | contamination-resistant |")
    L.append("|---|---|" + "---:|" * (len(SLICES_SHOWN) + 1))
    for r in results:
        L.append(f"| `{r['model']}` | {r['split']} | " + " | ".join(_pct(r["by_slice"].get(s)) for s in SLICES_SHOWN) + f" | {_pct(r['contamination_resistant'])} |")
    L.append("")

    L.append("## By subtype\n")
    subtypes = list(results[0]["by_subtype"]) if results else []
    L.append("| Subtype | " + " | ".join(f"`{r['model']}` ({r['split']})" for r in results) + " |")
    L.append("|---|" + "---:|" * len(results))
    for st in subtypes:
        L.append(f"| `{st}` | " + " | ".join(_pct(r["by_subtype"].get(st)) for r in results) + " |")
    L.append("")

    L.append("## Fabricated names (top 10 per model)\n")
    for r in results:
        top = r["hallucination"]["top20"][:10]
        if top:
            L.append(f"- `{r['model']}` ({r['split']}): " + ", ".join(f"`{n}`×{c}" for n, c in top))
        else:
            L.append(f"- `{r['model']}` ({r['split']}): none")
    L.append("")

    L.append("## Failure modes (primary, per task)\n")
    L.append("| Model | Split | " + " | ".join(f"`{m}`" for m in _all_modes(results)) + " |")
    L.append("|---|---|" + "---:|" * len(_all_modes(results)))
    for r in results:
        L.append(f"| `{r['model']}` | {r['split']} | " + " | ".join(str(r["primary_failure_modes"].get(m, 0)) for m in _all_modes(results)) + " |")
    L.append("")

    L.append("## Method\n")
    L.append("Tasks are generated from the pinned IPD-IMGT/HLA release (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, "
             "`Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`), stratified so "
             "unconfirmed and rare alleles are over-represented. The grader (`sci_envs/families/nomenclature/grade.py`) is deterministic: exact match "
             "after minimal normalization, legacy colon-less names count as wrong, a P group assigned to a null allele is `fabricated_group`, and every "
             "allele-like token in the answer and reasoning is checked against the release. Confidence intervals are Wilson 95%. "
             "The generator's own answers pass the grader at 100% (oracle test in CI).\n")
    L.append("Reference data: IPD-IMGT/HLA, Barker DJ et al., *Nucleic Acids Research* 2025 (CC-BY-ND; fetched at runtime, never redistributed). "
             "Scope: human clinical-genomics informatics only — no pathogen sequences, no wet-lab protocols.\n")
    L.append("Run your own model: `pip install -e . && hla-bench auto` (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY), or implement "
             "`answer(task) -> json` and pass it to `sci_envs.harness.run.run_model`.\n")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L))
    return out


def _all_modes(results: list[dict]) -> list[str]:
    seen = []
    for r in results:
        for m in r["primary_failure_modes"]:
            if m not in seen:
                seen.append(m)
    return seen
