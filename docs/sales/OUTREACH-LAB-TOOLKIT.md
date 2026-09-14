# Lab Toolkit angle — outreach openers (draft)

*Prepared 2026-09-14. Supplements `docs/sales/OUTREACH.md` (unchanged) — this file is
additive, not a replacement. Lab Toolkit endpoints (`/v1/typing/check`, `/v1/compat`,
`/v1/glstring`) are **not yet built or deployed**; they exist on `feature/lab-toolkit`
against `docs/LAB-TOOLKIT-SPEC.md`. Do not send anything from this file that says or
implies the toolkit is live — describe it as in development / coming soon. Jason sends,
never an agent. HLA-Verify is decision support only; not a medical device.*

Each opener below is ~120 words, ties to one concrete pain, and ends with a
low-friction next step. Three alternatives per persona so Jason can pick the one that
fits the specific recipient.

---

## Persona: HLA lab director / technical supervisor

### Opener 1 — the DRB3/4/5 gap

Hi [Name],

A question before the pitch: does anything in your LIMS catch a DRB1*15 result that is
missing its expected DRB5 companion, or flags a DRB4 result reported where the DRB1
family does not normally carry one? That rule lives in people's heads at most labs I have
talked to, not in software.

We are building that check into HLA-Verify — one call that runs a full typing against
the pinned IPD-IMGT/HLA release and returns every QC flag, DRB3/4/5 consistency
included, across all loci the release names. Not live yet; targeting next quarter.

Worth 15 minutes to tell me what your current QC pass actually checks, so we build the
right flags first?

Jason

### Opener 2 — the release-bump problem

Hi [Name],

IPD-IMGT/HLA adds roughly 600 alleles a quarter and renames some existing ones. A name
your LIMS validated against last release can be outdated this release, with nothing
prompting anyone to re-check it.

HLA-Verify already resolves any name to its current form against the full rename
history back to release 1.05.0. We are extending that into a one-call typing QC pass —
outdated names, wrong-locus entries, missing or extra alleles per locus — across every
locus in the database, not just the common ones. In development now, not yet live.

Before we finalize the flag list: what does your lab's current pre-release QC actually
catch that a name-only check would miss?

Jason

### Opener 3 — donor-selection review, not decision

Hi [Name],

The HLA-B -21 leader dimorphism (Petersdorf et al., Blood 2020, PMID 32483623) and KIR
ligand class (C1/C2/Bw4) both come from sequence positions inside an allele, not from
its name — so getting them by hand means looking up specific residues per allele, every
time.

We are building a computed leader/KIR-ligand profile into HLA-Verify, from the same
pinned release, no LLM, nothing stored. It reports the profile for review by your team;
it does not make a selection call, and every response says so. Not yet live — in
development against a published spec.

If useful, I would like 15 minutes on what a same-day, reproducible version of that
lookup would need to look like to actually get used in your review.

Jason

---

## Persona: LIMS / NGS-caller vendor product owner

### Opener 1 — ingest gate across every locus

Hi [Name],

A release-pinned name check at ingest is one thing; a check that covers every locus your
callers emit — not just A/B/C/DRB1/DQB1 — is another. HLA-Verify already resolves names
across all loci assigned in IPD-IMGT/HLA (46,652 alleles in 3.65.0, DRB3/4/5, DQA1,
DPA1/DPB1, MICA and the rest included).

We are adding a one-call typing QC endpoint aimed at exactly the ingest-gate use case:
outdated names, locus-mismatched entries, DRB3/4/5 consistency, in one response. Not
live yet, targeted for next quarter, spec is written.

Would 20 minutes with whoever owns your reference-data update process be useful, before
we lock the response shape?

Jason

### Opener 2 — GL String structure errors

Hi [Name],

GL Strings that fail downstream in HML or registry exchange almost never fail at the
point they were built — a mixed-locus allele list or a haplotype that repeats a locus
produces a string that looks fine until it hits something else's parser.

We are building `/v1/glstring` into HLA-Verify: parses the full `^|+~/` grammar, flags
every structural problem with the exact substring it concerns, resolves and normalizes
every allele token against the pinned release. Not deployed yet — in development, spec
is public in our repo.

If [Product] emits or ingests GL Strings, I would like your read on which structural
errors actually cost you support time before we finalize the flag list.

Jason

### Opener 3 — release-diff as a customer-facing artifact

Hi [Name],

When your reference data moves to a new IPD-IMGT/HLA release, some fraction of names
your customers reported become outdated overnight. Right now that is a changelog link;
it could be a list of the exact names that changed.

We are extending HLA-Verify's release-pinning into a typing-level QC pass so a
release-upgrade note can name the specific alleles affected, across every locus, not a
curated subset. Still in development — nothing to integrate yet, but the response shape
is close to final.

Worth a short call to see whether that shape fits how [Product] currently communicates
release upgrades to labs?

Jason

---

## Persona: transplant program coordinator / H&I scientist supporting donor selection

### Opener 1 — same-day leader/KIR-ligand summary

Hi [Name],

Petersdorf et al. (Blood 2020, PMID 32483623) reported that in HLA-B-mismatched
unrelated donor HCT, whether the mismatched alleles share the -21 leader residue tracks
with acute GVHD risk. Getting that residue, plus KIR ligand class (C1/C2/Bw4), requires
looking up specific sequence positions per allele — not something a typing report shows
directly.

We are building a computed profile into HLA-Verify that reports both, from the pinned
release, reproducibly, for your team's review — decision support only, never a
recommendation. Not yet live; in development.

Would it help to see the exact response shape before it ships, so it fits how your
program's review actually uses this information?

Jason

### Opener 2 — recipient/donor pair comparison

Hi [Name],

Comparing a recipient and donor typing for HLA-B mismatch count, leader match, and which
KIR ligand classes are present on only one side is currently several separate lookups.

`/v1/compat`, in development for HLA-Verify, runs both typings against the pinned
release in one call and returns that comparison as a reviewable summary — with the
literature citation and "decision support only, not a medical device" in the response
itself, not just a terms page. Not deployed yet.

If useful, I would like 15 minutes to walk through the response shape against a case
your program has already reviewed, to check it actually matches how you use this data.

Jason

### Opener 3 — reproducibility across the release pin

Hi [Name],

A leader-match or KIR-ligand call made by hand this month and re-derived next month,
after IPD-IMGT/HLA moves to a new release, is not guaranteed to reproduce the same
inputs unless someone pins the release used.

The HLA-Verify computation we are building carries the exact release tag in every
response, so a value your program used in a case review can be recomputed identically
later if it is ever questioned. Still in development, not live — the underlying naming
engine already ships this way.

Worth a short conversation about what a reproducible, review-ready summary would need to
include for your program specifically?

Jason
