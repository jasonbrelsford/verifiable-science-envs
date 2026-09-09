---
title: HLA-Verify
emoji: 🧬
colorFrom: green
colorTo: gray
sdk: static
pinned: false
license: other
short_description: Deterministic HLA allele verification in your browser
---

# HLA-Verify

Paste a typing report or an AI answer; every allele-shaped token is checked
**deterministically** against a pinned IPD-IMGT/HLA release — fabricated names, deleted
names (with successors), legacy formats, G/P groups, clinical flags. No LLM anywhere.
The page runs entirely in your browser (Pyodide); nothing you paste leaves the tab.

Same engine as [hlaverify.com/demo](https://hlaverify.com/demo) and the graders behind
[HLA-Bench](https://huggingface.co/datasets/jason-brelsford/hla-bench), where every
model family tested scores 0% on two-field ambiguity expansion. Source (Apache-2.0):
[verifiable-science-envs](https://github.com/jasonbrelsford/verifiable-science-envs).
Reference data are fetched at load time from the ANHIG/IMGTHLA mirror under CC-BY-ND
(Barker DJ et al., NAR 2025) and never redistributed. Research tool, not a medical device.
