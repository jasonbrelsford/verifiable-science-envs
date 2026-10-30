---
license: apache-2.0
task_categories: [question-answering]
tags: [biology, medical, hla, immunogenetics, benchmark, evaluation, clinical-genomics]
pretty_name: HLA-Bench (public dev splits)
---

# HLA-Bench — contamination-resistant evaluation of LLMs on clinical immunogenetics

**Every model family tested — Claude, Qwen, Mistral, Llama, Phi, Gemma — scores 0% on
two-field ambiguity expansion**, the core clinical trap in HLA typing (a 2-field
name like `A*02:01` denotes 2–389 full-resolution alleles): 0 of 30 tasks for
every model. Models fabricate allele names at 0.06–0.20 per task across the nine
models run on the full 550-task suite. The `claude-sonnet-4-6` rate is 0.11 per
task, on all 550 tasks answered — it is the most accurate model tested, and is
calibrated on only 77% of its answers. On donor–recipient matching, naive string
manipulation collapses to 0% and open models reach 0–14% — they count matched
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

## Check model outputs with HLA-Verify

HLA-Bench's graders and the HLA-Verify API share one engine, so the same allele-name check can
score any model's HLA answers, not only these tasks. Try it without code in the
**[HLA-Verify Space](https://huggingface.co/spaces/jason-brelsford/hla-verify)**: paste an
answer and every allele name is highlighted as valid, fabricated, deleted (with its successor) or
a legacy form, checked against the pinned IPD-IMGT/HLA release.

From a script, one call per answer:

```python
import os, requests

KEY = os.environ.get("HLAVERIFY_API_KEY")  # optional; see below

def allele_check(answer: str) -> dict:
    r = requests.post("https://api.hlaverify.com/v1/verify", json={"text": answer},
                      headers={"x-api-key": KEY} if KEY else {})
    r.raise_for_status()
    d = r.json()  # d["tokens"]: one verdict per distinct allele name; d["release"]: IPD-IMGT/HLA version
    c = d["counts"]
    return {"fabricated": c["hallucinated"] + c["fabricated_group"], "deleted": c["deleted"],
            "clean": d["clean"], "release": d["release"]}

allele_check("Exclude B*57:01 and B*57:01:99 before abacavir.")
# -> {'fabricated': 1, 'deleted': 0, 'clean': False, 'release': '3.66.0'}
```

- **Free API key for academic research:** apply at https://hlaverify.com/research. HLA-Verify is
  free during early access; without a key the API allows 100 calls a day, enough to try it but not
  to score a full run.
- **Agents:** the same checks are an MCP server at `https://api.hlaverify.com/mcp`.
- **Reference:** https://api.hlaverify.com/docs. Every response names the release it was computed
  against, so put that version in your methods.

## Links

- **Code, graders, full results with CIs:** https://github.com/jasonbrelsford/verifiable-science-envs
- **Interactive verifier (Hugging Face Space):** https://huggingface.co/spaces/jason-brelsford/hla-verify
- **In-browser verifier demo** (nothing leaves your machine): https://hlaverify.com/demo
- **For AI agents:** https://hlaverify.com/llms.txt
- Evaluation/training licensing & partnerships: hello@hlaverify.com (Brelsford Software LLC)

Tasks are Apache-2.0. Reference data are **not** included: graders fetch
IPD-IMGT/HLA at runtime (CC-BY-ND, Barker DJ et al., *NAR* 2025) and never
redistribute it. This card is maintained by Claude on behalf of Jason Brelsford.
