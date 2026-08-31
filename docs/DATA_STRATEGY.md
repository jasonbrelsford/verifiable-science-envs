# Data strategy — public data, executable truth, and partners

*How this project grounds every graded answer in data anyone can check, why that is a
feature rather than a compromise, and where partners fit. 2026-08-31.*

## The principle

Every verdict this project grades is computed from **public, versioned reference data**
by rules a lab director can read (`sci_envs/families/matching/rules.py`, the family-A
normalizer). No human labels, no expert panels, no licensed tables sit between an
answer and its justification. Anyone can regenerate the suite from the pinned release
and reproduce every number on our benchmark pages. That is what "validated with public
data" means here: not that we claim accuracy, but that **nothing prevents you from
checking it**.

## The data sources, and what each buys

**1. IPD-IMGT/HLA (the pinned release) — the graded core.**
The authoritative allele database, fetched at runtime and md5-verified against the
release's own checksums (CC-BY-ND: we attribute, and never redistribute copies).
Benefit: ground truth for nomenclature and matching that is *authoritative by
definition* — the database IS the standard the field reports against. Because releases
are versioned quarterly, sealed splits regenerate on every release, giving
contamination resistance no static benchmark has: a model cannot have memorized
alleles named after its training cutoff. Families A and C run entirely on this source.

**2. Synthetic Mendelian truth — the imputation core (family B).**
Phased parental haplotypes generated under Mendel's rules, unphased, and posed as
reconstruction tasks. Benefit: ground truth known **by construction** — the generator
holds the answer key, so grading requires no registry data at all, at any scale, with
per-task difficulty control. Simulation-validated phasing/imputation is standard
methodology in statistical genetics; we apply it to make an unlimited, licence-free
eval.

**3. Open population data — the realism layer.**
HLA calls derived from 1000 Genomes-class open resources (and open published
frequency tables where their licences allow) weight synthetic populations toward
realistic allele distributions. Benefit: population plausibility from data that is
open to everyone, including commercial users. Building and validating HLA tools on
1000 Genomes-class panels is accepted practice in the field's own journals — the same
public-data pattern used by multi-ethnic HLA imputation reference panels.

**4. Customer- and partner-held data — the restricted layer, held by its owners.**
Registry frequency data and outcome datasets (NMDP, CIBMTR) are licensed to a small
number of organizations and stay with them. Our tools run **on the data holder's
machines**: environments and graders ship to the data, results come back as
aggregates, and the restricted data never touches us. Benefit: the organizations that
hold these licences can evaluate models against their own data with our machinery —
their licence stays theirs, our code stays ours, and no data agreement between us is
required for them to start.

## Why this design is the credibility story

- **Auditable:** every rule cited to public documents; every score reproducible from a
  public release + a seed.
- **Contamination-resistant:** truth regenerates with each database release; post-cutoff
  tasks are new to every model by construction.
- **Licence-clean:** nothing we ship depends on data we are not permitted to ship. A
  buyer's diligence finds no encumbered data in the product.
- **Scales to restricted data without holding it:** the sealed-split, run-where-the-
  data-lives architecture extends from our machines to any registry's.

## Seeking partners

We are actively seeking partners who hold licensed registry data (haplotype
frequencies, outcome datasets) or accredited lab expertise and want a rigorous,
deterministic evaluation layer for AI in immunogenetics:

- **Registries / data holders** — run population-realistic and outcome-linked slices on
  your infrastructure with your data; co-author the validation.
- **HLA / transplant labs** — audit the rules encoding, contribute edge cases from
  practice, pilot HLA-Verify as a QC gate.
- **Model developers** — evaluate against the sealed split; train against a disjoint
  generated split.

Contact: **hello@hlaverify.com** (Brelsford Software LLC).

## Where this sits relative to prior work

Existing LLM benchmarks in genomics are curated question sets scored by hand or by
static answer keys (e.g. GeneTuring's 1,600 curated questions), or biology research
task suites (LAB-Bench, BixBench); rare-disease benchmarking has shown LLMs still
trail deterministic bioinformatics tools (the Monarch/Exomiser comparison). None
cover clinical immunogenetics, and none regenerate their ground truth from a
versioned authoritative database with executable rules. HLA imputation panels have
long been validated on public 1000 Genomes-class data — we follow that established
pattern and extend it to evaluating language models and agents. References in the
benchmark paper (in preparation).
