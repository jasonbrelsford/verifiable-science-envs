---
license: apache-2.0
task_categories: [question-answering]
tags: [biology, medical, hla, immunogenetics, benchmark, evaluation, clinical-genomics]
pretty_name: HLA-Bench (public dev splits)
---

# HLA-Bench — contamination-resistant evaluation of LLMs on clinical immunogenetics

**Every model family tested — Claude, Qwen, Mistral, Llama, Phi, Gemma — scores 0% on
two-field ambiguity expansion**, the core clinical trap in HLA typing (a 2-field
name like `A*02:01` denotes 2–389 full-resolution alleles). Models fabricate
allele names at 0.05–0.14 per task. On donor–recipient matching, naive string
manipulation collapses to 0% and open models reach 0–12% — they count matched
loci instead of chromosomes.

HLA-Bench grades every answer with an **executable oracle** computed from the
pinned IPD-IMGT/HLA release itself — no human labels, no LLM judges. Ground
truth regenerates deterministically from each quarterly database release, so a
versioned share of tasks is post-training-cutoff **by construction**.

## What's in this dataset

The **public dev splits** only:
- `family_a_dev/` — 112 nomenclature tasks (of 550; truncation, G/P groups,
  serology, rename history, ambiguity, near-miss traps)
- `family_c_dev/` — 43 donor–recipient matching pairs (of 205; 6/6–12/12
  frameworks, null-allele traps, GvH/HvG directionality)

The **scored splits are sealed** and regenerate per release from `(tag, seed)` —
that's the contamination-resistance design. Run them yourself from the source:

```bash
git clone https://github.com/jasonbrelsford/verifiable-science-envs
pip install -e ".[dev]"
hla-bench generate && hla-bench run ollama/qwen2.5:7b --suite runs/hla-bench-a --split dev
```

## Links

- **Code, graders, full results with CIs:** https://github.com/jasonbrelsford/verifiable-science-envs
- **In-browser verifier demo** (nothing leaves your machine): https://hlaverify.com/demo
- **For AI agents:** https://hlaverify.com/llms.txt
- Evaluation/training licensing & partnerships: hello@hlaverify.com (Brelsford Software LLC)

Tasks are Apache-2.0. Reference data are **not** included: graders fetch
IPD-IMGT/HLA at runtime (CC-BY-ND, Barker DJ et al., *NAR* 2025) and never
redistribute it. This card is maintained by Claude on behalf of Jason Brelsford.
