# Preprint Checklist: HLA-Bench

*Prepared 2026-09-11. Goal: post `docs/paper/hla-bench-draft.md` as a dated preprint for a
DOI-timestamped disclosure (defensive publication, complementing the git-history argument
in `docs/PRIOR_ART.md`) and to support sales conversations.*

## Readiness assessment of the draft

The draft (v0.1, dated 2026-08-31) has Abstract, Introduction, Related Work, Benchmark
Design, Results (4.1–4.5), Discussion, and Data/Code Availability - a complete skeleton.
Numbers checked against `STATUS.md` (2026-09-11): the Family A and Family C headline tables
in the draft **match** STATUS.md's tables exactly, including the qwen2.5:14b row added
2026-09-09 and phi4-mini's family C schema-failure finding. What is missing or explicitly
flagged incomplete in the draft itself:

- **§4.3 Training-environment demonstration - [PENDING].** No GRPO results yet; this is a
  named contribution (item vi in §1) with no data behind it.
- **claude-sonnet-4-6 row is a lower bound**, marked with an asterisk in both STATUS.md and
  the draft, pending a clean 1600-token re-run.
- **No figures** - the draft is table-only; a preprint benefits from at least one plot
  (per-subtype accuracy, or the wrong-but-overconfident rate by model) for scannability, though
  it is not blocking.
- **No author affiliation, ORCID, funding statement, or competing-interests statement** -
  required by every venue below before submission.
- **Data and code availability (§6)** already names the GitHub repo, licence split, the
  IPD-IMGT/HLA CC-BY-ND citation, and the Hugging Face dataset is live at
  [huggingface.co/datasets/jason-brelsford/hla-bench](https://huggingface.co/datasets/jason-brelsford/hla-bench)
  - good, this section is close to submission-ready as written.
- **TODO list in the draft** (6 items) is itself the punch list; the GRPO run and the
  Claude re-run are the two that change reported numbers, the rest are polish.

**Decision point for Jason:** the two pending numeric results (GRPO, clean Claude re-run)
can either (a) block posting until done, or (b) be posted now as v1 with `[PENDING]`
honestly marked (current draft already does this) and a v2 posted later citing the new DOI
version. Given the defensive-publication goal is time-sensitive and the pending items are
weeks out, **recommend (b): post now, mark pending items explicitly, version later.**

## Venue comparison

| Venue | DOI timing | Screening | Licence options | Google Scholar | Cost |
|---|---|---|---|---|---|
| **bioRxiv** | DOI minted on posting, ~1-2 business days after submission (up to 72h incl. weekends) [FAQ](https://www.biorxiv.org/about/FAQ) | Basic screen (plagiarism, non-scientific/biosecurity content), 1-2 business days | CC-BY, CC-BY-NC, **CC-BY-ND**, CC-BY-NC-ND, CC0, or all-rights-reserved - author's choice [licensing changes](https://openrxiv.org/preprint-licensing-updates/) | Yes, within ~48h of posting | Free |
| **medRxiv** | Same infrastructure as bioRxiv, similar timing | Same screening, plus explicit clinical/health-relevance check; explicitly **welcomes computational papers with full methods and results**, but not "resource/tool announcements without detailed methods" [FAQ](https://www.medrxiv.org/about/FAQ) | Same CC options as bioRxiv | Yes | Free |
| **arXiv (q-bio.GN or cs.CL/cs.AI)** | DOI-like arXiv ID assigned same day; a real DOI is only minted if arXiv's own DataCite integration is used (varies by category) | Moderation queue, typically same-to-next-day; **first-time submitters now need both an academic-institution email AND prior co-authorship on an accepted arXiv paper for automatic endorsement** - as of the Jan 2026 policy update, a from-scratch first submission likely needs a human endorser in the target category [arXiv blog](https://blog.arxiv.org/2026/01/21/attention-authors-updated-endorsement-policy/) | CC-BY, CC-BY-NC-SA, CC0, or arXiv's default non-exclusive licence | Yes | Free |
| **Zenodo** | DOI registered with DataCite **immediately** on upload, no screening | None - no peer review, no scope gate | CC-BY (default), CC0, or others | Indexed via Google (not curated the way bioRxiv is), OK but slower/thinner discovery | Free |
| **Research Square** | DOI on posting, typically **within 72 hours** | Screens for author completeness, declarations, human-health risk | Author-selected CC licence | Yes | Free for standalone preprints |
| **SSRN** | DOI/handle on posting | Editorial screen, days | Author-selected | Yes, but SSRN is a social-science/economics/law venue - wrong field fit | Free |

**Licence note:** IPD-IMGT/HLA reference data are CC-BY-ND (Barker DJ et al., *NAR* 2025,
doi:[10.1093/nar/gkaf1218](https://doi.org/10.1093/nar/gkaf1218)) and per README/STATUS are
never redistributed - the paper only *cites* that source and reports statistics computed
from it, so this is a citation-and-computation relationship, not redistribution, and does
not force the paper itself onto CC-BY-ND. Recommend the **paper** use plain **CC-BY** (most
permissive, best for citation counts and reuse in sales material) rather than CC-BY-ND for
the paper text itself; just do not attach any IPD-IMGT/HLA data files as supplementary
material under CC-BY, since that actually would redistribute CC-BY-ND-licensed content.

## Recommendation: bioRxiv primary, Zenodo same-day backup

**Primary: bioRxiv, Bioinformatics category.** It already hosts closely comparable
LLM-bioinformatics benchmark papers (e.g., "Bioinfo-Bench," "A benchmark for large language
models in bioinformatics" - both indexed on bioRxiv), confirming the venue accepts this
paper's genre; it is free, fast (~1-2 days), gives a real DOI, and indexes into Google
Scholar within about 48 hours. It is the venue readers and grant reviewers in genomics
expect a benchmark-paper preprint to live.

**Same-day backup/supplement: Zenodo.** Because Zenodo mints a DOI instantly with no
screening queue, post there **the same day** as an extra, independent timestamp - belt and
suspenders for the defensive-publication goal, in case bioRxiv's screening flags anything
or takes longer than expected. Zenodo is not a substitute audience-wise (thinner discovery,
no scholarly-preprint prestige), but it is the fastest possible dated, DOI'd public record,
and it costs nothing to also do.

**Not recommended as primary:** medRxiv (wrong scope - this is bioinformatics tooling, not
clinical/health research, and medRxiv explicitly discourages tool announcements without
clinical results); arXiv (the January 2026 endorsement-policy tightening makes a first-time
submission genuinely uncertain without a pre-existing arXiv co-author or an academic-email
endorser lined up - a real risk of delay right when speed matters); SSRN (wrong field).

## Submission checklist - bioRxiv

1. **Account:** create a bioRxiv account with Jason's own email (jason.brelsford@gmail.com
   or hello@hlaverify.com) directly on biorxiv.org - no password manager/agent involvement;
   Jason creates and verifies this account himself.
2. **Convert the draft to PDF.** bioRxiv accepts a manuscript PDF plus separate figure files.
   From the repo root:
   ```bash
   pandoc docs/paper/hla-bench-draft.md -o docs/paper/hla-bench-draft.pdf \
     --pdf-engine=xelatex -V geometry:margin=1in --toc=false
   ```
   (If `xelatex` is unavailable, `--pdf-engine=pdflatex` works for pure-ASCII text; the
   draft's tables and URLs are plain enough for either. Install a TeX distribution - e.g.
   MiKTeX on Windows - if `pandoc` reports a missing engine.)
3. **Figures:** bioRxiv wants figures as separate TIFF/EPS/PDF/PNG files, not embedded only
   in the manuscript PDF, if any are added (see "no figures" gap above) - at least 300 DPI.
4. **Required metadata at submission:** title, abstract, all author names with affiliations,
   corresponding-author email, subject category (**Bioinformatics**), 3-5 keywords, and a
   competing-interests statement.
5. **Competing-interests wording** (given the commercial HLA-Verify service): state it
   plainly rather than omit it -
   > "J.B. is the founder of Brelsford Software LLC, which operates the HLA-Verify API
   > (hlaverify.com) described in this manuscript as a commercial service under the
   > PolyForm Noncommercial 1.0.0 licence for the verification component; the benchmark,
   > generators, and graders themselves are released under Apache-2.0."
6. **Licence choice:** select **CC-BY** for the manuscript (see licence note above); do not
   upload any IPD-IMGT/HLA-derived data tables as supplementary files.
7. **Cite the exact provenance:** in the manuscript (Data and Code Availability, §6) and in
   the bioRxiv submission's "data availability" field, cite the git commit hash
   `05d73f548b72f8548e3bc0ccd5ba99eea2f9ce9b` (current HEAD) or a tagged release, plus the
   Hugging Face dataset URL, so the preprint is bound to a specific, reproducible snapshot
   rather than a moving `main` branch.
8. **ORCID:** bioRxiv strongly prefers an ORCID iD for each author; if Jason does not have
   one, register free at orcid.org before submitting (2 minutes, no cost) - this blocks on Jason.
9. **Submit, then wait for screening** (1-2 business days) - a bioRxiv moderator may email
   back with minor requests (e.g., a clearer competing-interests line); respond promptly.
10. **Same day: post the identical PDF to Zenodo** (upload directly, select "Preprint" as
    resource type, CC-BY licence, link the GitHub repo and Hugging Face dataset in the
    "Related identifiers" field) for the instant independent DOI.

## Post-posting steps

- Add both DOIs (bioRxiv + Zenodo) to `README.md`, `STATUS.md`, the hlaverify.com landing
  page, and `hlaverify.com/llms.txt`.
- Add the bioRxiv DOI to Jason's Google Scholar profile (Scholar auto-indexes bioRxiv within
  ~48h, but a manual "My Citations" add speeds attribution).
- Post the DOI link as a reply/update to the existing launch threads in
  `docs/launch/posts.md` (HN, r/bioinformatics, LinkedIn, X, r/MachineLearning,
  r/LocalLLaMA) rather than new posts - "now with a citable preprint" is a good
  low-effort follow-up trigger for the same audience.
- When the GRPO result and the clean Claude re-run land, post a **v2** to bioRxiv (same
  submission, new version - bioRxiv supports versioning under one DOI) and a new dated
  Zenodo record.

## Timeline

- **Today (2026-09-11):** convert draft to PDF, write competing-interests statement, confirm
  CC-BY choice, gather commit hash/dataset URL - all doable without Jason.
- **This week:** Jason creates bioRxiv account, confirms/creates ORCID, does a final read of
  the draft, and submits; same-day Zenodo upload once the bioRxiv PDF exists.
- **Blocked on Jason specifically:** ORCID creation/confirmation, final author-list and
  affiliation decision, the actual account creation and submit-click (per this session's
  no-password/no-account-creation-by-agent constraint), and any competing-interests wording
  he wants to adjust.
- **Later (not blocking initial posting):** GRPO fine-tune run and the clean
  claude-sonnet-4-6 1600-token re-run, each triggering a v2 preprint version per above.
