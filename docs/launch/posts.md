# Launch posts — copy-ready

*Prepared 2026-09-08. Every number below is from `STATUS.md` / `bench/` at that date;
re-check the headline table before posting if a newer tower run has landed. Post from
Jason's own accounts. Links: repo https://github.com/jasonbrelsford/verifiable-science-envs ·
dataset https://huggingface.co/datasets/jason-brelsford/hla-bench · demo https://hlaverify.com/demo*

Suggested order (each post links the previous discussion, so momentum compounds):
1. Hacker News (Tue–Thu, 8–10am ET) → 2. r/bioinformatics same morning → 3. LinkedIn
that afternoon → 4. X thread → 5. r/MachineLearning two days later with any HN discussion
linked → 6. r/LocalLLaMA (the "7B counts loci, not chromosomes" angle).

---

## 1. Hacker News — Show HN

**Title (≤80 chars):**
Show HN: HLA-Bench – every LLM we tested scores 0% on the core HLA ambiguity trap

**URL:** https://github.com/jasonbrelsford/verifiable-science-envs

**First comment (post immediately after submitting):**

I spent years building HLA matching software for the marrow-donor registry world. HLA
nomenclature is the one domain in genomics where correctness is *computable*: there is a
single authoritative, versioned database (IPD-IMGT/HLA, 46,652 named alleles, quarterly
releases), and every question about an allele name has an exact answer derivable from
the release's own files.

So I built a benchmark where the grader is an executable oracle, not a human panel and not
an LLM judge. 550 nomenclature tasks and 205 donor–recipient matching pairs, regenerated
deterministically from (release tag, seed). Because ground truth regenerates every
quarter, a share of tasks is post-training-cutoff by construction — contamination
resistance you can't get from a static question set.

What we found across Claude, Qwen, Mistral, Llama and Phi:

- Every model family scores **0% on two-field ambiguity expansion** — none knows that a
  name like A*02:01 denotes anywhere from 2 to 389 full-resolution alleles. That's the core
  clinical trap in HLA typing.
- On nomenclature, models land between 15% and 35% against a 28% *string-manipulation
  baseline*. A 3B model scores below it.
- On donor–recipient matching, string manipulation collapses to 0% and the best open 7B
  reaches 6% — it counts matched loci instead of chromosomes and never says "this typing
  is too coarse to call".
- Models fabricate allele names at 0.05–0.14 per task (invented 4th fields, made-up G
  groups, legacy colon-less forms). The grader checks every emitted name against the
  release.

The graders also run as a verification service (HLA-Verify): paste text, get a verdict
per allele name — fabricated / deleted-with-successor / legacy-era / valid, with the
release version. In-browser demo, nothing leaves your tab: https://hlaverify.com/demo.
There's an MCP server so agents can verify before they present.

We cross-checked against NMDP's py-ard on the slice where both apply: 99.3% agreement,
all 14 divergences triaged in the repo. The interesting bit: fed a fabricated allele,
py-ard (correctly, for a reduction library) reduces it to a plausible real one. A
verifier has to do the opposite. Reduction and verification are different jobs.

Apache-2.0 for the benchmark, generators, graders and harness. Happy to answer anything
about the rules encoding — it's written to be auditable by a lab director.

---

## 2. r/bioinformatics

**Title:** I built a contamination-resistant LLM benchmark for HLA nomenclature and
matching. Every model tested scores 0% on 2-field ambiguity expansion.

**Body:**

Background: ex-registry software engineer (NMDP-era matching tooling). HLA is unusual in
that the ground truth is a versioned, machine-readable database (IPD-IMGT/HLA), so I
built an evaluation where every answer is computed by an executable oracle from the pinned
release — no curated answer keys, no LLM-as-judge.

Two suites:
- **HLA-Bench-A**, 550 tasks: truncation and expression suffixes, G/P groups, serologic
  equivalents, rename/deletion history, ambiguity expansion, typing-report normalization,
  near-miss discrimination.
- **HLA-Bench-C**, 205 donor–recipient pairs: 6/6 through 12/12 and antigen-level
  frameworks, null alleles hiding inside serologic matches (A*24:09N), legacy-era typing,
  GvH/HvG directionality, and resolution-insufficient cases where a confident count is
  itself the error. Rules R1–R6 are in one Python file written for lab-director audit.

Results (Wilson 95% CIs on the bench pages):
- Nomenclature: qwen2.5:7b 31%, mistral:7b 29%, naive-string baseline 28%, qwen2.5:3b
  28%, phi4-mini 24%, llama3.1:8b 21%, llama3.2:3b 15%; claude-sonnet-4-6 34.7% (lower
  bound, token-truncated re-run pending).
- **0% on `expand_ambiguity` for every family** — Claude, Qwen, Mistral, Llama, Phi.
- Matching: naive baseline 0%, qwen2.5:7b 6.3% [3.7–10.6]; dominant error is counting
  matched loci instead of chromosomes, plus self-contradiction between per-locus verdicts
  and the total.
- Fabricated allele names: 0.05–0.14 per task.

Validation against py-ard 2.4.0: 99.3% concordance on 2,000 sampled 2-field reductions;
the 14 divergences are Q-suffix semantics and ARD rollups, documented. Notably py-ard
reduces the fabricated `DQB1*05:03:26:99` to `DQB1*05:03` — right for a reduction
library, wrong for a guard in front of AI output.

Everything is public and Apache-2.0: generators, graders, harness, Inspect AI and
`verifiers` adapters. Dev splits on HF; sealed splits regenerate every release and never
leave the grading machine. The graders also run as a verifier (in-browser demo linked
in the repo).

I'd genuinely like edge cases from people who do this clinically — the rules encoding
is the thing I most want audited.

Repo: https://github.com/jasonbrelsford/verifiable-science-envs
Dataset: https://huggingface.co/datasets/jason-brelsford/hla-bench

---

## 3. LinkedIn

Ten years ago I was writing HLA matching code for the donor-registry world. This year I
went back to the same problem with a different question: **can a language model do this
safely?**

The answer, measured rather than guessed: not yet — and the failure is specific.

I built HLA-Bench: 550 nomenclature tasks and 205 donor–recipient matching pairs where
every answer is computed from the IPD-IMGT/HLA release itself by auditable rules. No
human answer key, no AI judge. Because the database ships quarterly, the benchmark
regenerates with it, so models can't have memorized the newest tasks.

What we found across Claude, Qwen, Mistral, Llama and Phi:

→ Every model family scores 0% on two-field ambiguity expansion — the core clinical trap
in HLA typing.
→ On matching, string manipulation gets 0% and the best open 7B model gets 6%, because it
counts matched loci instead of chromosomes.
→ Models invent allele names at 0.05–0.14 per task.

The same graders now run as HLA-Verify: a deterministic check of every allele name in a
report or an AI's output, pinned to a database release, with an in-browser demo where
nothing leaves your machine. We validated it against NMDP's py-ard at 99.3% concordance.

If you run a histocompatibility lab, a registry, or build AI tooling that touches
transplant data, I'd like to talk — especially about running the population-realistic
slices on your infrastructure, with your data staying yours.

Benchmark and code (Apache-2.0): github.com/jasonbrelsford/verifiable-science-envs
Demo: hlaverify.com/demo

#immunogenetics #HLA #transplant #LLM #AIsafety #bioinformatics

---

## 4. X / Twitter thread

1/ We built a benchmark where the ground truth for LLMs is *computed*, not labeled.
Domain: HLA typing and transplant matching. Result: every model family we tested — Claude,
Qwen, Mistral, Llama, Phi — scores 0% on the core clinical trap. 🧵

2/ HLA nomenclature has one authoritative versioned database (IPD-IMGT/HLA, 46k alleles,
quarterly releases). Every question about an allele name has an exact answer derivable
from the release's own files. So the grader is an executable oracle. No LLM judge.

3/ Because the DB ships quarterly, the benchmark regenerates with it. A slice of tasks is
post-training-cutoff by construction. That's contamination resistance a static question
set can't have.

4/ Nomenclature (550 tasks): models score 15–35%. The naive string-manipulation baseline
scores 28%. A 3B model lands below the string baseline.

5/ The universal failure: `expand_ambiguity`. A 2-field name like A*02:01 covers 2–389
full-resolution alleles. 0% across every model family. Same failure at 3B, 7B, and
frontier scale — a representational gap, not a size problem.

6/ Matching (205 donor–recipient pairs): string manipulation collapses to 0%. Best open
7B: 6.3%. It counts matched loci instead of chromosomes, contradicts its own per-locus
verdicts, and never says "this typing is too coarse to call".

7/ Models fabricate allele names at 0.05–0.14 per task. Invented 4th fields. Made-up G
groups. Legacy colon-less forms. The grader checks every emitted name against the release.

8/ The graders run as a verifier too: hlaverify.com/demo — paste text, get a verdict per
allele (fabricated / deleted-with-successor / legacy / valid). Runs in your browser.
There's an MCP server so agents can verify before they present.

9/ Cross-checked against NMDP's py-ard: 99.3% agreement where both apply. Fun finding:
give py-ard a fabricated allele and it reduces it to a plausible real one. Right for a
reduction library. Wrong for a guard. Verification ≠ reduction.

10/ Everything's Apache-2.0: generators, graders, harness, Inspect AI + verifiers
adapters. Dev splits on HF. Sealed splits regenerate every release.
github.com/jasonbrelsford/verifiable-science-envs

---

## 5. r/MachineLearning — [R]

**Title:** [R] HLA-Bench: executable-oracle, contamination-resistant evaluation of LLMs
on clinical immunogenetics — 0% on the core ambiguity task across all model families

**Body:**

Sharing a benchmark with two properties I haven't seen combined elsewhere:

1. **Executable oracle.** Ground truth is computed from a pinned release of the
   authoritative HLA database by documented rules. Oracle scores 100% by construction;
   no human labels, no LLM judge, no licensed data.
2. **Release-keyed regeneration.** Suites regenerate deterministically from (release
   tag, seed). The database ships quarterly, so a versioned share of tasks (32.7% of
   tier-3/4 allele tasks at 3.65.0) is post-cutoff for any model trained before that
   release. Sealed scored splits never leave the grading machine; dev splits are public.

Findings (7 models, Wilson CIs in the repo):
- Nomenclature (550 tasks): 15–35% vs a 28% naive string baseline. **0% on 2-field
  ambiguity expansion for every family tested (Claude, Qwen, Mistral, Llama, Phi)** —
  identical failure at 3B, 7B and frontier scale.
- Matching (205 pairs): naive baseline 0%; best open 7B 6.3%. Systematic error: counts
  matched loci rather than chromosomes; never emits the "unresolvable" verdict.
- Fabrication rate 0.05–0.14 allele names per task; every emitted name is checked.
- Harness note: reasoning models under forced JSON burn the whole budget thinking
  (deepseek-r1:8b excluded for this reason).

Also in the repo: adapters for `verifiers` (Prime Intellect) and Inspect AI, a GRPO
training script that uses the deterministic grader as reward on a disjoint generated
split (results pending), and a 99.3% concordance study against the field-standard
reduction library.

Repo (Apache-2.0): https://github.com/jasonbrelsford/verifiable-science-envs
Dataset: https://huggingface.co/datasets/jason-brelsford/hla-bench

---

## 6. r/LocalLLaMA

**Title:** Tested 6 local models (3B–8B) on transplant-matching logic with a deterministic
grader. Best result: 6%. Here's exactly how they fail.

**Body:**

Ran qwen2.5 (3B/7B), llama3.1:8b, llama3.2:3b, mistral:7b and phi4-mini through Ollama at
temp 0, JSON-forced, against two suites where the answer key is computed from the HLA
database itself (no human labels).

Nomenclature (550 tasks): qwen2.5:7b 31%, mistral 29%, qwen2.5:3b 28%, phi4-mini 24%,
llama3.1:8b 21%, llama3.2:3b 15%. A dumb string-manipulation baseline gets 28%. Qwen
beats Llama at every size.

Donor–recipient matching (205 pairs): every baseline 0%, qwen2.5:7b 6.3%. It answers
"4/8" when four *loci* match (should count chromosomes), and contradicts its own
per-locus verdicts in the same response. 190/205 answers wrong-and-overconfident.

Every model fails the same task at 0%: expanding a 2-field allele name into the
full-resolution alleles it covers. Same for Claude Sonnet when we ran it. Not a scale
thing.

Reasoning models: deepseek-r1:8b under `format: json` spends the entire token budget in
`<think>` and returns nothing. Excluded; a think-then-parse client is on the list.

Everything runs free locally with Ollama: `hla-bench run ollama/<model>`. If you want to
try a 14B/32B and send me the results file, I'll add the row with your credit.

https://github.com/jasonbrelsford/verifiable-science-envs
