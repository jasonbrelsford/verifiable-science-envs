# HLA-Verify cold outreach sequences

*Prepared 2026-09-10. Three tiers, three touches each, plus a LinkedIn DM per tier. All
numbers are from `STATUS.md`, `README.md`, `docs/launch/posts.md`, `assets/landing.html`
and `edge/src/docs.js` at that date; re-check the headline table before sending if a newer
run has landed. Send from hello@hlaverify.com. Replace `[Name]`, `[Lab]`, `[Product]`,
`[Org]`. Cadence: day 0, day 5, day 12. Stop the sequence the moment anyone replies.*

Zero-friction first steps used below:
- Demo: paste a de-identified report into https://hlaverify.com/demo (runs in the browser,
  nothing leaves the machine).
- curl: one `curl` against https://api.hlaverify.com, open without a key at 60 requests/minute.
- Rules audit: a 20-minute call walking rules R1-R6 in `rules.py`.

---

## Tier A: HLA laboratories and transplant centers

### A1. Day 0

**Subject:** Your typing reports, checked against IPD-IMGT/HLA 3.65.0

Hi [Name],

I spent years writing donor-recipient matching code for the registry world. This year I
went back and measured whether language models can do that work. Not yet: on 205
donor-recipient pairs, open models scored 0 to 14%, mostly because they count matched
loci instead of chromosomes, and none ever said "this typing is too coarse to call."

The same rules engine now runs as HLA-Verify. Paste a typing report and every
allele-shaped token is checked against a pinned release (3.65.0, 46,652 alleles).
Deleted names resolve to successors, 1990s colon-less strings normalize, fabricated
names are flagged. Nothing is stored.

First step, no account: paste one de-identified report into hlaverify.com/demo. It runs
in your browser. If it flags anything you did not expect, I would like to hear about it.

Jason Brelsford
Brelsford Software LLC, hello@hlaverify.com

### A2. Day 5

**Subject:** The A*24:09N trap, in one curl

Hi [Name],

One finding from the matching benchmark that I think matters to [Lab]: the best open
model (mistral:7b, 13.7%) gets the denominator right and then over-credits, answering
"8/8" when the truth is 6/8. A missed mismatch is the dangerous direction. On the
null-allele trap it scored 8%.

HLA-Verify counts per chromosome, reports GvH and HvG separately, and raises
`null_allele_mismatch` when a null hides inside a serologic match. The docs page has a
donor carrying A*24:09N against a recipient with A*24:02; the verdict comes back "7/8"
with the flag set.

Try it from a terminal, no key needed:
curl -s https://api.hlaverify.com/docs

If your lab's count would differ on any pair, that is exactly the conversation I want.

Jason

### A3. Day 12

**Subject:** 20 minutes on rules R1-R6

Hi [Name],

Last note from me. The matching rules behind HLA-Verify are six documented rules in one
Python file, written so a lab director can audit them line by line. We cross-checked the
nomenclature side against NMDP's py-ard: 99.3% agreement on 2,000 sampled reductions,
all 14 divergences triaged in the repo.

I am asking a small number of accredited labs to audit the encoding and contribute edge
cases from practice. That is a 20-minute call, your calendar, no slides. If it turns into
a six-week pilot on your own reports, the fee is credited to a first-year licence; if it
does not, you still get a findings letter on the cases we discussed.

Would a 20-minute rules audit be worth your time this month?

Jason

### LinkedIn DM, Tier A

Hi [Name], ex-registry matching engineer here. I built a deterministic checker for HLA
allele names and match counts, pinned to IPD-IMGT/HLA 3.65.0.
Every LLM we tested scored 0% on 2-field ambiguity expansion, so we built a guard instead.
Paste one de-identified report into hlaverify.com/demo; nothing leaves your browser.
If it flags something odd, or nothing at all, I would like 20 minutes to compare notes.

---

## Tier B: LIMS and HLA software vendors

### B1. Day 0

**Subject:** A release-pinned check behind [Product]

Hi [Name],

I wrote matching software for the registry world for years, so I know what [Product]
already does well. This is about one thing it probably does not do: verify, not reduce.

We benchmarked models on HLA nomenclature and found they fabricate allele names at 0.05
to 0.14 per task: invented fourth fields, made-up G groups, legacy colon-less forms.
Then we fed a fabricated name to py-ard. It reduced DQB1*05:03:26:99 to DQB1*05:03,
correctly for a reduction library, wrong for a guard.

HLA-Verify is the guard: POST /v1/verify classifies every allele-shaped token as valid,
group, deleted with successor, fabricated group, or hallucinated, against a pinned
release. No LLM, nothing stored, OpenAPI at api.hlaverify.com/openapi.json.

Simplest first step, one curl, no key:
curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' -d '{"text":"A*0101, DQB1*05:03:26:99"}'

Jason Brelsford, Brelsford Software LLC

### B2. Day 5

**Subject:** Verdict diff before each quarterly release

Hi [Name],

IPD-IMGT/HLA adds roughly 600 alleles a quarter and 3.65.0 carries 46,652. Every
release, some names your customers reported become deleted-with-successor, and some
lower-resolution names start spanning more G groups.

Keyed HLA-Verify customers receive a diff of changed verdicts before the pin moves, and
can hold an older release on request. For a LIMS or caller vendor that means a
release-upgrade note you can hand to labs with the exact names that changed, instead of
a changelog link.

The pipeline table on api.hlaverify.com/docs shows the four insertion points: report
ingest, LLM output gating, match-report QC, warehouse QC in batches of up to 5,000.

Would a 20-minute call with your product owner for [Product] be useful? I will bring the
diff format and you can tell me where it does not fit.

Jason

### B3. Day 12

**Subject:** Closing the loop on HLA-Verify

Hi [Name],

Last message. One more finding, because it is about parsing rather than knowledge:
phi4-mini scored 0 of 205 on matching, and 139 of those were schema failures. It
returned "8/8" or the word "match" instead of the per-locus verdict object the task
required, sometimes with the right number. A verdict a pipeline cannot parse is not a
verdict.

HLA-Verify returns the same JSON every time for the same input and release. If hosted is
not an option, the engine is pip-installable and runs on your infrastructure; the
service code is PolyForm Noncommercial, so commercial use is a licence from us, from
$15k per year. A $12k six-week pilot on your own outputs is credited to that licence.

If the timing is wrong, a one-line reply saying so is welcome.

Jason

### LinkedIn DM, Tier B

Hi [Name], I build deterministic verification for HLA names and match counts (ex-registry
matching engineer).
Models fabricate allele names at 0.05 to 0.14 per task; reduction libraries quietly fix them.
HLA-Verify flags them instead, pinned to 3.65.0, and diffs verdicts before each release.
One curl, no key: api.hlaverify.com/docs.
Happy to do 20 minutes with whoever owns [Product]'s reference-data updates.

---

## Tier C: registries, data holders, and AI / agent platforms

### C1. Day 0

**Subject:** 0% on 2-field ambiguity expansion, every model family

Hi [Name],

I spent years on registry matching software. This year I built a benchmark where the
grader is the IPD-IMGT/HLA release itself: 550 nomenclature tasks and 205
donor-recipient pairs, regenerated deterministically each quarter, so 32.7% of the
harder allele tasks are post-training-cutoff by construction.

Across Claude, Qwen, Mistral, Llama, Phi and Gemma, every family scored 0% on expanding
a 2-field name like A*02:01 into the full-resolution alleles it covers (true counts 2 to
389). That is the core clinical ambiguity trap, and it is not a scale problem.

The graders run as a verifier too. If [Org] has any pipeline where a model's output
mentions HLA, this is the smallest possible test:
curl -s https://api.hlaverify.com/v1/verify -H 'content-type: application/json' -d '{"text":"<paste one model answer>"}'

`clean: false` means something in it is fabricated, deleted, or a made-up group.

Jason Brelsford, Brelsford Software LLC

### C2. Day 5

**Subject:** Run the sealed split on your infrastructure

Hi [Name],

The benchmark's sealed scored split never leaves the machine that grades it, and the
same architecture extends to your data: environments and graders ship to you, results
come back as aggregates, and licensed registry or outcome data never touches us. No
data agreement is needed to start.

What that buys a registry or model developer: population-realistic and outcome-linked
evaluation slices on your own infrastructure, with Inspect AI and `verifiers` adapters
already in the repo, and a deterministic reward for training on a disjoint generated
split.

One number for context: qwen2.5:14b answered 181 of 205 matching pairs wrong but
overconfident and never once emitted a `potential` verdict. That is the behaviour a
registry cannot ship.

20 minutes to scope a slice? Your calendar, no deck.

Jason

### C3. Day 12

**Subject:** One line for your agent config

Hi [Name],

Last note. If a call is not the right shape, here is the smallest integration: HLA-Verify
ships an MCP server with three tools, `verify_text`, `normalize_allele`, `match_score`.

pip install -e ".[mcp]"
{"command": "python", "args": ["-m", "sci_envs.mcp_server"]}

An agent that calls `verify_text` before presenting HLA content stops fabricated names
at the boundary; nothing is stored and there is no LLM in the loop. Model-evaluation
licences and custom environment families for AI labs start at $15k per year; the
benchmark, generators, graders and harness are Apache-2.0.

Details, including llms.txt for agents, at hlaverify.com. Reply "not now" and I will
close the file.

Jason

### LinkedIn DM, Tier C

Hi [Name], ex-registry matching engineer. I built an executable-oracle HLA benchmark
that regenerates each quarter from the IPD-IMGT/HLA release.
Every model family we tested scored 0% on 2-field ambiguity expansion; open models got
0 to 14% on donor-recipient matching.
The graders also run as a verifier and an MCP server; sealed splits can run on your
infrastructure with your data staying yours.
20 minutes to scope a slice, or one curl at api.hlaverify.com/docs.
