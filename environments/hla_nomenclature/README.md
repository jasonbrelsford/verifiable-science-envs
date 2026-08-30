# hla-nomenclature (HLA-Bench-A) — verifiers environment

Single-turn environment: resolve HLA allele names against IPD-IMGT/HLA 3.65.0 (truncation with the expression-suffix rule, G/P groups, serology, rename history, null-allele and near-miss traps). 550 generated tasks; the dev split is public, the sealed split is held server-side.

Reward = 1.0·correct + 0.25·no_fabrication + 0.10·calibrated + 0.10·flags_right — all computed by a deterministic grader against the pinned reference files (fetched at runtime, never redistributed; CC-BY-ND, Barker DJ et al. NAR 2025).

```bash
uv run vf-install hla-nomenclature --from-repo   # or: pip install -e environments/hla_nomenclature
uv run vf-eval hla-nomenclature -m <model> -n 112 -a '{"split": "dev"}'
```
Scope: human clinical-genomics informatics only. No sequences, no pathogens, no wet-lab protocols.
