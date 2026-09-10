# Statement of Work: HLA-Verify six-week pilot

**Template v1, 2026-09-10.** Bracketed fields are completed per customer.

| | |
|---|---|
| Provider | Brelsford Software LLC ("Provider"), hello@hlaverify.com |
| Customer | [Legal name, address] ("Customer") |
| Pilot | HLA-Verify verification pilot, six weeks |
| Fee | USD 12,000, credited in full to a first-year licence signed within 90 days of pilot end |
| Reference release | IPD-IMGT/HLA [3.65.0] (the "Pinned Release"), fixed for the pilot |
| Deployment | [Hosted API at api.hlaverify.com with a Customer key] or [Self-hosted Python engine on Customer infrastructure] |

## 1. Background

HLA-Verify is a deterministic verification engine for HLA nomenclature and
donor-recipient match claims. Every verdict is computed from the Pinned Release's own
files by documented rules (nomenclature normalizer; matching rules R1-R6 published in
`sci_envs/families/matching/rules.py`). There is no language model in the loop. The
hosted service processes requests in memory and stores nothing; metering records counts
per key, never content.

## 2. Scope

Provider will verify a corpus supplied by Customer against the Pinned Release and report
the findings. The corpus is one or both of:

- **Reports:** up to [N] de-identified typing reports, match reports, or LIMS/warehouse
  exports (any nomenclature era).
- **Model outputs:** up to [N] outputs from Customer's AI or agent system that mention HLA.

Verification covers: allele-name status (`valid`, `group`, `deleted` with successor,
`fabricated_group`, `hallucinated`); normalization to the Pinned Release (`current_name`,
2-field name, G group, flags such as `deprecated_name`, `null_allele`,
`nonexistent_allele`); and, for donor-recipient pairs, match verdicts under the 6/6, 8/8,
10/10, 12/12 or antigen framework with per-chromosome counts, GvH/HvG mismatches,
`potential` verdicts with `resolution_insufficient`, and `null_allele_mismatch` flags.

## 3. Deliverables

1. **Findings letter** (PDF, signed by Provider): counts by verdict class, every
   non-clean token or pair with its rule citation, and Customer-specific
   recommendations for ingest, gating, or QC.
2. **Audit trail** (JSON or CSV): one row per token and per pair, with input, verdict,
   flags, rule identifiers, engine version, and Pinned Release, sufficient for Customer's
   own quality review.
3. **Verdict diff across releases:** the same corpus re-run against [the release
   preceding the Pinned Release] and, if published during the pilot, the next release;
   a table of every verdict that changed and why.
4. **Rules-audit session:** one 60-minute walkthrough of R1-R6 and the normalizer with
   Customer's laboratory director or technical lead; edge cases raised are added to the
   audit trail with their resolution.
5. **Integration notes:** where the checks sit in Customer's pipeline (see
   `docs/sales/INTEGRATION_BRIEF.md`), with request and response examples using
   Customer's own data shapes.

## 4. Data handling

- **Self-hosted option:** Provider delivers the engine (pip-installable) and it runs on
  Customer machines. Customer data never leaves Customer infrastructure. Provider
  receives only the aggregate counts and the anonymized non-clean rows Customer chooses
  to share for the findings letter.
- **Hosted option:** requests to api.hlaverify.com are processed in memory and
  discarded. Nothing sent is stored. Metering records request counts per key only.
  Transport is TLS. Customer supplies de-identified data only.
- Reference data are fetched from the official IPD-IMGT/HLA source under CC-BY-ND and
  are never redistributed by Provider.
- Provider does not receive, request, or retain protected health information. Customer is
  responsible for de-identification before submission.
- On pilot end, Provider deletes any pilot working files within 30 days on written
  request, retaining only the signed findings letter.

## 5. Acceptance criteria

The pilot is accepted when all of the following hold:

1. Deliverables 1 through 5 have been delivered by the end of week 6.
2. Every token in the corpus received exactly one verdict class, and every pair received
   a verdict under the agreed framework or an explicit `potential` with
   `resolution_insufficient`.
3. Re-running the corpus against the Pinned Release reproduces the audit trail
   byte-for-byte (determinism check, witnessed by Customer).
4. Every disagreement Customer raises during the rules-audit session is resolved in the
   audit trail as either a documented rule outcome or a logged defect; open defects at
   week 6 are listed in the findings letter with a fix date.

Acceptance is not conditioned on the corpus being clean. A corpus with many flagged rows
is a successful pilot.

## 6. Timeline

| Week | Activity | Owner |
|---|---|---|
| 1 | Kickoff (45 min). Agree corpus, framework(s), deployment option. Issue API key or deliver engine. Customer submits first batch. | Both |
| 2 | Full corpus run against the Pinned Release. First-pass verdict counts shared. | Provider |
| 3 | Rules-audit session. Customer raises edge cases; Provider logs and resolves. | Both |
| 4 | Verdict diff across releases. Integration notes drafted with Customer's data shapes. | Provider |
| 5 | Re-run with any rule clarifications. Determinism check witnessed by Customer. | Both |
| 6 | Findings letter, audit trail, and diff delivered. Close-out call (30 min). | Provider |

## 7. Out of scope

- Clinical decision support of any kind. HLA-Verify is a research-and-evaluation tool and
  is not a medical device; its output supports and does not replace clinical judgement.
- Any verdict on transplant suitability, donor selection, or patient care.
- Antibody, crossmatch, epitope, or haplotype-frequency analysis.
- Modification of Customer's LIMS, EHR, or reporting systems; Provider supplies notes and
  examples, Customer's team performs integration.
- Processing of identifiable patient data.
- Support for releases other than the Pinned Release and the two comparison releases in
  Deliverable 3.

## 8. Fee, credit, and licence

- Fee: USD 12,000, invoiced at signature, net 30.
- Credit: the full fee is credited to a first-year HLA-Verify licence (from USD 15,000
  per year) if the licence is signed within 90 days of pilot end.
- The engine's service code is licensed under PolyForm Noncommercial 1.0.0; the pilot
  grants Customer an evaluation licence for the pilot term only. Commercial or production
  use requires the separate licence. The benchmark, generators, graders, and harness are
  Apache-2.0.
- Deliverables are Customer's to keep and share internally. Provider may state that
  Customer ran a pilot only with Customer's written consent.

## 9. Assumptions and Customer responsibilities

- Customer names one technical contact and one laboratory or clinical contact available
  for the kickoff, rules-audit session, and close-out.
- Customer supplies the corpus by the end of week 1 in text, JSON, CSV, or PDF-to-text form.
- For the self-hosted option, Customer provides a Python 3 environment with outbound
  access to the official IPD-IMGT/HLA download source for the one-time reference fetch.

## 10. Signatures

| Brelsford Software LLC | [Customer] |
|---|---|
| Name: Jason Brelsford | Name: |
| Title: Owner | Title: |
| Date: | Date: |
| Signature: | Signature: |
