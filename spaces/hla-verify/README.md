---
title: HLA-Verify
emoji: 🧬
colorFrom: green
colorTo: gray
sdk: static
pinned: false
license: apache-2.0
short_description: Catch fabricated HLA allele names in LLM output and reports
tags:
  - hla
  - immunogenetics
  - transplant
  - bioinformatics
  - llm-evaluation
  - hallucination-detection
  - ipd-imgt-hla
datasets:
  - jason-brelsford/hla-bench
---

# HLA-Verify

Paste an LLM answer, a typing report or a GL string; every allele-shaped name is checked
**deterministically** against a pinned IPD-IMGT/HLA release: fabricated names, deleted names
(with successors), legacy formats, G/P groups, MAC codes. No LLM anywhere.

Tabs:

- **Check text**: finds every allele name in free text and highlights fabricated, deleted and
  legacy ones (`POST /v1/verify`)
- **Normalize names**: legacy and renamed names to current form (`POST /v1/normalize`)
- **Allele lookup**: status, G/P group, serology, KIR ligands, and how many full-resolution
  alleles a two-field name stands for (`GET /v1/allele/{name}`)
- **Donor–recipient match**: 6/6 to 12/12 counts with HvG/GvH direction (`POST /v1/match`), plus
  optional HLA-B leader and KIR-ligand checks (`POST /v1/compat`)
- **GL string**: validation and normalization (`POST /v1/glstring`)
- **API & MCP**: copy-paste setup for scripts and agents

**Free API key for academic research:** apply at [hlaverify.com/research](https://hlaverify.com/research).
HLA-Verify is free during early access; without a key the API allows 100 calls a day.
API reference: [api.hlaverify.com/docs](https://api.hlaverify.com/docs). MCP server for Claude,
Cursor and other agents: `https://api.hlaverify.com/mcp`.

The page calls the public API at `api.hlaverify.com` directly from your browser, so your calls
count against your own daily allowance and a key you paste goes only to the API. Prefer nothing to
leave your machine? The **offline checker** (`offline.html`, linked in the footer) runs the
nomenclature engine in the tab with Pyodide. **Don't paste patient identifiers**: allele names
and typing strings only.

Same engine as the graders behind
[HLA-Bench](https://huggingface.co/datasets/jason-brelsford/hla-bench), where every model family
tested scores 0% on two-field ambiguity expansion (0 of 30 tasks per model) and fabricates allele
names at 0.06–0.20 per task. Source:
[verifiable-science-envs](https://github.com/jasonbrelsford/verifiable-science-envs) (this page is
Apache-2.0). Reference data: IPD-IMGT/HLA (Barker DJ et al., NAR 2025), CC-BY-ND, never
redistributed. Research tool, not a medical device.
