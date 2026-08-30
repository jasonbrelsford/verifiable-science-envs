---
title: HLA-Verify
emoji: 🧬
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: other
short_description: Deterministic HLA nomenclature verification — no LLM
---

# HLA-Verify

Paste a typing report or an AI answer; every allele-shaped token is checked **deterministically** against a pinned IPD-IMGT/HLA release — fabricated names, deleted names (with successors), legacy formats, G/P groups, clinical flags. No LLM anywhere; nothing you paste is stored.

Built from [verifiable-science-envs](https://github.com/jasonbrelsford/verifiable-science-envs) — the engine behind HLA-Bench-A. Reference data are fetched at build/run time from the ANHIG/IMGTHLA mirror under CC-BY-ND (Barker DJ et al., NAR 2025) and never redistributed.
