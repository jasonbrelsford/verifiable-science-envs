# HLA-Verify Lab Toolkit — capability brief

*Draft, 2026-09-14. Not yet built or deployed — engineering is building it on
`feature/lab-toolkit` against `docs/LAB-TOOLKIT-SPEC.md`. Nothing described here is live.
For HLA laboratory directors, LIMS/NGS-caller vendors, and transplant program
coordinators. HLA-Verify is decision support only; it is not a medical device, and
nothing here should be read as a claim of clinical efficacy or a recommendation about a
specific patient or donor.*

## The one-line pitch

Four checks a histocompatibility lab or transplant program runs by hand today, computed
in one API call from a pinned IPD-IMGT/HLA release, across **every locus in the
database** — no LLM, nothing stored.

## What each endpoint removes

### `POST /v1/typing/check` — one typing, every QC check before it leaves the building

**Problem it removes:** the last-look QC pass on a finished typing — catching a name that
was current when it was assigned but has since been renamed, a locus that only has one
allele listed when two are expected, a null allele hiding inside what looks like a
routine result — is manual, and it is easy to skip under deadline pressure. Every
release, IPD-IMGT/HLA adds roughly 600 alleles and renames or retires others; a name that
was correct last quarter can be an outdated one this quarter without anyone in the lab
having done anything wrong.

**What it does:** takes one typing (any subset of loci) and returns, per reported
allele, whether it resolves, whether it is a current or outdated name, its 2-field
reduction and G group, and issue flags — outdated name, wrong locus for the field it was
entered under, null allele, too many or too few alleles reported, homozygous. It also
rolls up DRB3/4/5 consistency (below) and a KIR-ligand/leader profile (below) when the
relevant loci are present.

### DRB3/4/5 consistency — catching the locus nobody remembers to check

**Problem it removes:** whether a typing should carry a DRB3, DRB4, or DRB5 result is
determined by which DRB1 allele family is present, and it is a rule people carry in their
heads rather than software enforces. A DRB1*15 or *16 result that is missing its expected
DRB5 companion, or a DRB4 result reported alongside a DRB1 family that does not carry
one, is a data-entry gap that a downstream match calculation will not catch on its own.

**What it does:** from the DRB1 alleles in a typing, computes which of DRB3/4/5 are
expected to be present, compares that against what was actually reported, and flags
either direction — an unexpected locus reported, or an expected locus missing.

### Outdated names after a release bump — the LIMS warehouse problem

**Problem it removes:** a name valid in the release your LIMS was validated against can
become an outdated name (superseded by a rename) in the next quarterly release, and nothing
in a typical LIMS surfaces that automatically. Historical typings accumulate names from
whichever release was current when each one was entered, so a warehouse spanning several
years spans several releases' worth of naming.

**What it does:** every name HLA-Verify resolves is checked against the full rename
history of the pinned release, not just its current table, so a name from any era
resolves to its current form with the fact of the rename flagged rather than silently
substituted.

### KIR ligand (C1/C2/Bw4) and HLA-B -21 leader (M/T) — for donor selection review, not for making the selection

**Problem it removes:** two donor-selection inputs that hematopoietic transplant programs
increasingly weigh — the KIR ligand class a typing carries (C1, C2, Bw4 and its Bw4-80I /
Bw4-80T subtypes) and the HLA-B leader dimorphism at position -21 (methionine or
threonine) — are computed from residues inside the allele sequence itself, not from the
allele name. Getting them by hand means looking up each expressed allele's sequence at
specific positions, correctly, for every allele in the typing.

**What it does:** for HLA-A, -B and -C alleles, computes the expressed KIR ligand class
and (for HLA-B) the -21 leader residue directly from the pinned release's protein
alignments, and reports a leader-match / KIR-ligand-completeness profile for a typing.
`POST /v1/compat` runs the same computation on a recipient/donor pair and reports the
number of HLA-B mismatches, whether a single mismatch is leader-matched, and which KIR
ligand classes are present in one party and absent in the other. Two published findings
motivate these fields specifically:

- Petersdorf et al., *HLA-B leader and survivorship after HLA-mismatched unrelated donor
  transplantation*, **Blood** 2020 (PMID [32483623](https://pubmed.ncbi.nlm.nih.gov/32483623/)):
  in HLA-B-mismatched unrelated donor HCT, whether the mismatched recipient and donor
  HLA-B alleles share the -21 leader residue is associated with acute GVHD risk. The
  API's `rule` string for this field quotes that association and states plainly:
  "decision support only; not a medical device."
- KIR ligand mismatch (C1/C2/Bw4) has a body of published association with HCT outcomes
  that is more variable by transplant type and prophylaxis than the leader finding above
  — see e.g. Willemze et al., *Leukemia* 2009 and the umbilical-cord-blood analysis at
  PMC [5507950](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5507950/), and the
  post-transplant-cyclophosphamide haploidentical analysis at PMC
  [11683009](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11683009/). HLA-Verify reports
  which KIR ligand classes are present or missing on each side; it does not compute or
  imply a risk score, and its `rule` string says so explicitly.

HLA-Verify computes these fields the same way every time from the same pinned sequence
data. It does not weigh them against each other, against other donor-selection criteria,
or against a specific patient's history — that judgment belongs to the transplant program
and its clinicians, which is exactly why every leader- and KIR-ligand-bearing response
carries "decision support only; not a medical device" in the payload itself, not just in
a terms page.

### `POST /v1/glstring` — GL String validation for HML/LIMS exchange

**Problem it removes:** GL Strings (the `^ | + ~ /` genotype-list grammar used in HML and
increasingly in registry and LIMS exchange) are easy to construct incorrectly — a locus
split across two `^` blocks, a haplotype that repeats a locus, an allele list that mixes
loci, an outdated allele name buried inside an otherwise well-formed string. A malformed
GL String usually fails downstream, far from where it was produced, with an error message
that does not point back at the malformed token.

**What it does:** parses a GL String at every grammar level, resolves and flags every
allele token inside it (outdated name, unresolvable name), flags structural problems
(mixed-locus lists, repeated loci in a haplotype, mismatched loci across a genotype's two
haplotypes, differing loci across `|` alternatives, a locus split across `^` blocks) with
the exact substring each issue concerns, and returns a normalized string with outdated
names rewritten to current ones.

## Coverage: every locus in the release

`/v1/verify`, `/v1/allele/{name}` and the toolkit endpoints above resolve names against
**all 46,652 alleles in IPD-IMGT/HLA 3.65.0, across every locus the database assigns
names in** — HLA-A, -B, -C, -DRB1, -DRB3, -DRB4, -DRB5, -DQA1, -DQB1, -DPA1, -DPB1, -E,
-F, -G, -H, -J, -K, -L, -MICA, -MICB, -TAP1, -TAP2, and the rest of the assigned-name
list, not a curated subset of "the common ones." KIR ligand and leader computation is
scoped to HLA-A, -B and -C specifically, because that is what the underlying biology
covers — not because other loci are unsupported for naming and typing QC.

## Determinism and auditability

- **Pinned release.** Every response carries the exact release tag (`3.65.0`) it was
  computed against. Nothing moves under a customer without their decision.
- **No LLM anywhere in the computation.** Every field is read from the release's own
  files or computed from them by fixed, published rules — the same engine, the same
  input, the same release, the same output, reproducible during an audit months later.
- **Nothing stored.** Typing and GL String content is processed in memory and discarded.
  Metering counts requests and reported alleles, never content.
- **No sequences returned.** Leader and KIR-ligand computation reads sequence residues
  internally; only the derived classification (a single letter or a named class) is ever
  in a response.
- **No IPD-IMGT/HLA redistribution.** Reference data are fetched from the official
  source and never redistributed in any response or export.

## Explicit limits — what this is not

- **Not a medical device.** No output from HLA-Verify is a clinical decision, a donor
  selection, or a recommendation for a specific patient. It supports the humans who make
  those calls; it does not make them.
- **No MAC (multiple allele code) expansion or resolution.**
- **No DPB1 T-cell epitope (TCE) group classification.**
- **No eplet or antibody-epitope analysis (PIRCHE or otherwise).**
- **No allele-frequency, CIWD, or haplotype-frequency data of any kind.**
- **No ARD (allele reduction to a defined resolution) of GL Strings** — `/v1/glstring`
  validates and normalizes structure and names; it does not reduce resolution.

## Who each piece is for

- **HLA lab directors / technical supervisors:** `/v1/typing/check` as a pre-release QC
  pass; the DRB3/4/5 flags catch the locus most often missed by habit rather than rule.
- **LIMS and NGS-caller vendors:** `/v1/typing/check` and `/v1/glstring` as an ingest or
  export gate, so a customer's warehouse of names stays reconcilable across release
  bumps without a manual audit.
- **Transplant program coordinators and H&I lab scientists supporting donor selection:**
  `/v1/compat` as a same-day, reproducible summary of leader-match and KIR-ligand status
  to bring into the multidisciplinary review that already exists — not to replace it.
