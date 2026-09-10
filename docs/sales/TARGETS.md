# HLA-Verify target list

*Prepared 2026-09-10 for Brelsford Software LLC (hello@hlaverify.com). Every organization
below was confirmed by web search on that date: that it exists, what it does, and who owns
it where ownership has changed. Contact routes are public web forms, generic institutional
pages, or LinkedIn search hints. No personal email addresses.*

**How to read the ranking.** *Fit* is how directly the organization's daily work produces or
consumes HLA allele strings and match counts, which is exactly what `/v1/verify`,
`/v1/normalize` and `/v1/match` check. *Reach* is how easy a first technical conversation is
through public channels plus Jason's registry background. Priority 1 = contact this month,
2 = this quarter, 3 = after the first pilot closes.

Product facts used in the "why" column all come from the repo: pinned to IPD-IMGT/HLA
3.65.0 (46,652 alleles, roughly 600 added per quarter, deleted names resolved across 110
releases of history); open without a key at 60 requests/minute per IP; keyed customers get a
diff of changed verdicts before each quarterly pin move; nothing sent is stored.

## Top 10 first calls

| Rank | Organization | Why first |
|---|---|---|
| 1 | NMDP (Bioinformatics / py-ard) | Jason's home turf; the py-ard concordance study (99.3%, 14 triaged divergences) is a ready-made opening; verify and reduce are complementary jobs |
| 2 | Thermo Fisher One Lambda (HistoTrac + TypeStream Visual) | The dominant HLA LIMS plus an NGS caller; a release-pinned check at report ingest touches most US labs at once |
| 3 | Werfen (Omixon HLA Twin + Immucor MIA FORA) | Two NGS callers under one owner since Oct 2024; one product manager can gate both |
| 4 | Anthony Nolan (labs + registry) | UK registry and lab under one roof; the population-realistic slice partner the data strategy asks for |
| 5 | DKMS Life Science Lab / DKMS registry | Largest typing lab in the world (well over 1.2M samples a year); warehouse QC across releases is a batch `/v1/normalize` job |
| 6 | CareDx (AlloSeq Tx / Assign) | IVDR-certified NGS typing with its own analysis software; converted TruSight customers need release-consistent names |
| 7 | GenDx (Eurobio Scientific) | NGSengine is the most widely used independent HLA caller in Europe; sales force in Benelux, Germany, US |
| 8 | CIBMTR | Holds the HLA-Save extract of typing and match grades for every US transplant; verdict diff across releases is their data-quality problem |
| 9 | Anthropic (Claude for Life Sciences / Claude Science) | Already an MCP-connector ecosystem; the benchmark shows 0% on 2-field ambiguity expansion for Claude too |
| 10 | Fred Hutch Clinical Immunogenetics Laboratory | Large academic HCT lab in the NMDP orbit; strong first design partner for a lab pilot |

## Tier A: HLA / histocompatibility laboratories and transplant centers

Buyer roles: HLA laboratory director (PhD or MD, ASHI/EFI-accredited director), ASHI
technical supervisor or clinical scientist, laboratory IT / LIMS administrator. Openers for
this tier: paste a de-identified report into the in-browser demo, or a 20-minute rules audit
of R1-R6.

| # | Organization | Category | Why they need this | Likely buyer | Public route | Pri |
|---|---|---|---|---|---|---|
| A1 | Fred Hutch Clinical Immunogenetics Laboratory (Seattle) | Academic HCT lab, ASHI | High-volume unrelated-donor typing; reports span SSOP, RT-PCR and NGS eras, so `/v1/normalize` on ingest catches legacy names | Lab director; associate director | fredhutch.org clinical-labs page; LinkedIn "Clinical Immunogenetics Laboratory Fred Hutch" | 1 |
| A2 | Bloodworks Northwest HLA/Immunogenetics Lab (Seattle) | Blood-center HLA lab, ASHI/CLIA | Types 11 loci for Seattle HCT programs; match-report QC against `/v1/match` per pair | Lab director; technical supervisor | bloodworksnw.org/labs/contact | 2 |
| A3 | Stanford Blood Center Histocompatibility and Immunogenetics Lab | Blood-center HLA lab, ASHI/CLIA | Serves Stanford Health Care and Packard; wrote publicly about hospital-to-HLA-lab communication gaps, which is the ingest problem | Lab director | stanfordbloodcenter.org/hla-lab | 2 |
| A4 | UCLA Immunogenetics Center | Academic HLA lab, ASHI | Runs a well-known proficiency exchange; a deterministic verifier is a natural exchange-QC tool | Center director; associate directors | uclahealth.org UIC contact-us page | 2 |
| A5 | Johns Hopkins Immunogenetics Laboratory (Baltimore) | Academic HLA lab, ASHI | Supports HCT and solid organ plus kidney paired donation; every KPD offer is a match count to verify | Lab director; technical director | labs.pathology.jhu.edu/immunogenetics/contact | 2 |
| A6 | UPMC / University of Pittsburgh HLA Laboratory | Academic HLA lab, ASHI | Supports four UPMC hospitals, four external hospitals and one OPO; heavy UNOS antigen-equivalent traffic | HLA lab director | path.pitt.edu contact-us | 2 |
| A7 | MD Anderson HLA Typing Laboratory (Houston) | Cancer-center HLA lab | HCT-focused typing; shares the only ACGME HLA fellowship with Houston Methodist, so a rules-audit call has teaching value | Lab section chief | mdanderson.org Laboratory Medicine sections page | 3 |
| A8 | Houston Methodist HLA and Transplant Immunology | Academic HLA lab, ASHI | Trains future lab directors; auditable R1-R6 rules are a teaching asset | Lab director; fellowship director | houstonmethodist.org pathology HLA page | 3 |
| A9 | Memorial Sloan Kettering Histocompatibility Laboratory | Cancer-center HLA lab | Large HCT program; AI tools are entering MSK documentation workflows | Medical and scientific director | mskcc.org pathology department page | 3 |
| A10 | Penn Medicine Immunology and HLA Laboratory | Academic HLA lab | Solid organ and HCT; LIMS ingest and report QC | Lab director | pathology.med.upenn.edu immunology-and-hla | 3 |
| A11 | UW Health HLA Laboratory (Madison) | Academic HLA lab, ASHI | Does all deceased-donor typing for UW OTD; virtual crossmatch pipeline needs clean names | HLA lab director | surgery.wisc.edu HLA laboratory page (generic lab email listed there) | 2 |
| A12 | Duke Clinical Transplantation Immunology Laboratory | Academic HLA lab, ASHI/CLIA | Solid organ and HCT support; standard lab-pilot profile | Lab director | clinlabs.duke.edu | 3 |
| A13 | Mayo Clinic Laboratories (HLA test menu) | Reference lab | High-resolution typing analysed against the IMGT/HLA database per their catalog; release pinning is their exact concern | Lab director, Transplant/HLA | mayocliniclabs.com test catalog contact | 3 |
| A14 | Versiti Histocompatibility Laboratory (Milwaukee) | Blood-center HLA lab, ASHI | Chimerism and HLA LOH plus typing; central-lab clinical-trial HLA work needs audit trails | Lab director; VP diagnostic labs | versiti.org diagnostic-labs page | 2 |
| A15 | Labcorp Transplant Services | Commercial lab, ASHI/CAP | NMDP contract lab; registry-scale typing volume, warehouse QC by batch `/v1/normalize` | Medical director, transplant; LIMS product owner | labcorp.com transplant-services page | 2 |
| A16 | Eurofins VRL / Eurofins Viracor pre-transplant testing | Commercial lab, CLIA | Donor eligibility and HLA testing across many centers; report normalization at scale | Lab director; IT director | eurofins-viracor.com transplant page | 3 |
| A17 | Anthony Nolan Histocompatibility Laboratories (London) | Registry lab, EFI | 11-locus NGS typing for the UK registry and cell-therapy clients; release diff before each IPD-IMGT/HLA update | Head of laboratories; head of bioinformatics | anthonynolan.org cell-therapy-laboratory-services | 1 |
| A18 | DKMS Life Science Lab (Dresden) | Registry lab, largest in the world | Well over 1.2M swabs a year, about 6,000 novel alleles submitted; every quarterly release changes names in their warehouse | Managing director; head of bioinformatics | dkms-lab.de/about | 1 |
| A19 | NHS Blood and Transplant H&I (six-lab network) | National H&I network, EFI/UKAS | Barnsley, Birmingham, Colindale, Filton, Newcastle, Tooting; one integration covers the network | Head of H&I; consultant clinical scientist | hospital.blood.co.uk H&I page | 2 |
| A20 | Synnovis Clinical Transplantation Laboratory, Guy's (London) | Hospital H&I lab, EFI since 2008 | Busiest UK renal transplant lab (350+ per year); antibody-incompatible programme depends on exact allele names | Head of department; lead clinical scientist | synnovis.co.uk departments page | 2 |
| A21 | Leeds Teaching Hospitals H&I (Transplant Immunology) | Hospital H&I lab | Standard NHS H&I profile; user-guide-driven ordering is where report QC lives | Head of H&I | leedsth.nhs.uk pathology SLM page | 3 |
| A22 | LUMC HLA Laboratory / Eurotransplant Reference Laboratory (Leiden) | Reference lab, EFI | Runs Eurotransplant proficiency testing for every affiliated lab; a deterministic verifier is an EPT instrument | Head of ETRL; head of HLA lab | immunology.lumc.nl contact page | 1 |
| A23 | Sanquin Diagnostic Services, Immunogenetics (Amsterdam) | Blood-service HLA lab | Donor-matching typing for the Dutch blood supply and cord bank; batch normalize across releases | Head of immunogenetics | sanquin.org diagnostics services page | 3 |
| A24 | Charité Institut für Transfusionsmedizin HLA-Labor (Berlin) | University H&I lab, EFI | DSO regional lab for Berlin-Brandenburg, 130+ dialysis centers; high volume of legacy typings | Laboratory head | transfusionsmedizin.charite.de HLA-Labor page | 3 |
| A25 | Universitätsklinikum Heidelberg Transplantationsimmunologie | University H&I lab, EFI, DAkkS | Hosts a stem-cell donor register and search unit in the same department; lab and registry buyer in one place | Head of transplantation immunology | klinikum.uni-heidelberg.de immunologie HLA-Labor page | 2 |
| A26 | MHH Hannover Institut für Transfusionsmedizin und Transplantat Engineering | University H&I lab | 24/7 transplant diagnostics; their own site cites the allele count at six loci, which drifts every release | Institute head; lab diagnostics lead | mhh.de/en/itt laboratory-diagnostics contact | 3 |
| A27 | AP-HP Hôpital Saint-Louis Immunologie-Histocompatibilité (Paris) | Regional H&I platform | About 30% of French transplant activity; NGS genotyping at scale with Agence de la Biomédecine coordination | Service head; platform lead | aphp.fr Saint-Louis service page | 2 |
| A28 | Banc de Sang i Teixits Histocompatibility Laboratory (Barcelona) | Blood-and-tissue-bank HLA lab | REDMO reference center for Catalonia and cord bank; registry-registration typing is a normalize-and-verify job | Lab head | bancsang.net professionals lab-hla page | 3 |

## Tier B: LIMS and HLA software vendors

Buyer roles: VP or director of product for transplant software, bioinformatics lead,
regulatory/quality lead (IVD/IVDR). Opener for this tier: `curl` the API, read
`/openapi.json`, then a 20-minute call about where a release-pinned check sits in their
pipeline. Ownership confirmed 2026-09-10.

| # | Organization | Category | Why they need this | Likely buyer | Public route | Pri |
|---|---|---|---|---|---|---|
| B1 | Thermo Fisher Scientific, One Lambda: HistoTrac (ex-SystemLink, acquired Dec 2021) | HLA LIMS | The transplant information system most US labs run; every report and HistoTrac/TIMS export is an ingest point for `/v1/normalize` | Product manager, HistoTrac; transplant software director | thermofisher.com One Lambda contact form; LinkedIn "HistoTrac product manager" | 1 |
| B2 | Thermo Fisher Scientific, One Lambda: TypeStream Visual (AllType, HybriType) | NGS caller | Emits allele names to HistoTrac bi-directionally; a name valid in one release is deleted in the next | Product manager, NGS software | Same as B1 | 1 |
| B3 | Werfen: Omixon HLA Twin / HLA Explore (acquired Oct 2024, Budapest) | NGS caller | Twin's dual-algorithm output still needs release-pinned name checks before it reaches a report | Head of software; product director | omixon.com contact | 1 |
| B4 | Werfen: Immucor MIA FORA NGS / NGS Express | NGS caller | Three-field typing across 11 genes; same owner as B3, one gate serves both | Product manager, transfusion and transplant software | transfusionandtransplant.werfen.com contact | 1 |
| B5 | GenDx (Genome Diagnostics BV, Utrecht; owned by Eurobio Scientific since Oct 2022) | NGS caller, RUO and CE-IVD | NGSengine, NGSgo, NGS-Turbo on nanopore; every product ships an IPD-IMGT/HLA reference and needs a verdict diff on update | Head of software; bioinformatics lead | gendx.com contact; labproducts.gendx.com | 1 |
| B6 | CareDx: AlloSeq Tx, AlloSeq Assign (IVDR-certified 2025) | NGS caller | Converted TruSight users onto AlloSeq; Assign output is a name list that `/v1/verify` can gate in one call | VP product, transplant lab products | caredx.com HLA typing page; labproducts.caredx.com | 1 |
| B7 | HistoGenetics (Ossining, NY) | High-volume typing service | Millions of SBT/NGS typings for registries and cord banks; their PDF reports use G-code output, which `/v1/verify` classifies as `group` | CEO; bioinformatics director | histogenetics.com contact | 2 |
| B8 | PIRCHE AG (Berlin) | Epitope-matching software | TxPredictor consumes typings from many callers; invalid input names silently distort epitope scores | CTO; product lead | pirche.com contact | 2 |
| B9 | Cytopar | Virtual crossmatch software | Pulls donor typings via the UNOS API and attaches PDFs; a normalize-on-ingest step protects every VXM | Founder; product lead | LinkedIn company page "Cytopar" | 2 |
| B10 | Scisco Genetics (Seattle) | NGS typing kits and software | ScisGo 3-field typing with null-allele detection; the A*24:09N class of trap is where `/v1/match` adds value | CEO; bioinformatics lead | sciscogenetics.com contact | 3 |

## Tier C: registries, data holders, and AI / agent platforms

Buyer roles at registries: director of bioinformatics, head of search/match services, data
quality lead. At AI companies: head of evals, clinical safety lead, developer-platform or
MCP-partnerships lead. Opener: `curl /v1/verify` on a real model output, or a 20-minute
call about running the sealed split on their infrastructure.

| # | Organization | Category | Why they need this | Likely buyer | Public route | Pri |
|---|---|---|---|---|---|---|
| C1 | NMDP (Bioinformatics; py-ard, GRIMM, HapLogic, HML) | US registry | py-ard reduces; HLA-Verify verifies. 99.3% concordance with 14 documented divergences is a technical conversation waiting to happen; MatchSource ingest is a normalize point | Director of bioinformatics; VP technology | network.nmdp.org bioinformatics pages; GitHub nmdp-bioinformatics | 1 |
| C2 | CIBMTR (Milwaukee / Minneapolis) | Outcomes registry | HLA-Save extract holds typing and match grades for every US transplant; a verdict diff per release is the data-quality audit they already run by hand | Bioinformatics research director; data operations lead | cibmtr.org bioinformatics research page | 1 |
| C3 | WMDA Search and Match Service (Leiden) | Global registry hub | Nearly 43M donors from 130+ organizations in 57 countries; incoming typings span every era and every caller | Head of Search and Match; IT director | wmda.info contact | 2 |
| C4 | UNOS / OPTN (UNet) | Organ allocation | Molecular-to-antigen-equivalent mapping and "addressing HLA typing errors" are live policy topics; `/v1/normalize` flags `nonexistent_allele` before entry | Director of histocompatibility policy; UNet product owner | unos.org contact; OPTN public comment channel | 2 |
| C5 | DKMS (registry side) | Donor registry | Largest donor file; registry-side warehouse QC distinct from the lab (A18) | Head of registry IT; head of bioinformatics | professional.dkms.org | 1 |
| C6 | Anthony Nolan (registry side) | Donor registry | UK registry search; population-realistic evaluation slices on their infrastructure per DATA_STRATEGY.md | Director of registry operations; head of bioinformatics | anthonynolan.org clinicians-researchers hub | 1 |
| C7 | ZKRD (Ulm) | German national registry | OptiMatch matching on pseudonymized donor data; the "run on your machines" model fits German data rules | Head of IT; head of search | zkrd.de contact | 2 |
| C8 | Eurotransplant (Leiden; ENIS) | Organ allocation | ENIS stores split-antigen-level typing; the antigen framework in `/v1/match` speaks that language | IT director; medical director | eurotransplant.org contact | 2 |
| C9 | Canadian Blood Services Stem Cell Registry (Ottawa) | National registry | 61,730+ registrants with 5-locus high-resolution typing; published haplotype-redundancy work shows an active bioinformatics team | Registry director; bioinformatics lead | blood.ca hospital-services contact | 3 |
| C10 | Gift of Life Marrow Registry (Boca Raton) | NMDP-affiliated registry | Labcorp-typed donor file; smaller team, faster decision | CTO; registry operations director | giftoflife.org contact | 3 |
| C11 | Anthropic (Claude for Life Sciences, Claude Science) | Frontier AI lab | claude-sonnet-4-6 scored 0% on 2-field ambiguity expansion in HLA-Bench-A; the MCP server is a drop-in connector; model-evaluation licence | Head of life sciences; evals lead; MCP partnerships | anthropic.com contact; Claude for Life Sciences partner form | 1 |
| C12 | OpenAI (HealthBench, OpenAI for Healthcare) | Frontier AI lab | HealthBench rubrics are physician-written; HLA-Bench is executable-oracle and regenerates quarterly, a complementary evaluation class | Health evals lead; healthcare partnerships | openai.com healthcare page contact | 2 |
| C13 | Google DeepMind / Google Health (MedGemma, HAI-DEF) | Open medical models | gemma3:12b scored 0/205 on matching ("4/4" for an 8/8 framework); MedGemma is built on Gemma 3 | HAI-DEF program lead; MedGemma evals | developers.google.com HAI-DEF feedback channel | 2 |
| C14 | Microsoft (Dragon Copilot) | Clinical documentation AI | 100,000+ clinicians, Epic-integrated notes that will contain HLA strings from transplant clinics; `/v1/verify` gate before display | Clinical safety lead; Dragon Copilot product | microsoft.com healthcare contact | 2 |
| C15 | Epic (Cosmos, Curiosity, AI agents) | EHR and clinical AI | Cosmos includes genomic variants; agent-platform outputs that mention HLA need a deterministic check | AI product director; genomics product owner | epic.com contact; UGM channels | 3 |
| C16 | Abridge | Ambient documentation AI | Deployed at Mayo, Duke, Hopkins and 250+ systems, all with HLA labs; transplant-clinic notes are in scope | Clinical safety / evaluation lead | abridge.com contact | 2 |
| C17 | Ambience Healthcare | Ambient documentation and coding AI | 40+ systems including UCSF and Houston Methodist; chart summarization of transplant records | Head of clinical quality; product lead | ambiencehealthcare.com contact | 3 |
| C18 | OpenEvidence | Physician clinical search LLM | 430,000+ US physicians; answers about HLA typing and matching are exactly where fabricated names appear | Head of clinical quality; evals | openevidence.com about/contact | 2 |
| C19 | Hippocratic AI | Safety-focused healthcare LLM | Publishes real-world evaluation methodology; a deterministic external verifier fits their safety story | Head of safety research | hippocraticai.com research/contact | 3 |
| C20 | Prime Intellect (Environments Hub, verifiers) | RL environments platform | The repo already ships a `verifiers` adapter; listing HLA-Bench on the Hub is a distribution channel, custom environment families are a licence line | Environments Hub lead | primeintellect.ai; GitHub PrimeIntellect-ai/verifiers | 2 |
| C21 | UK AI Security Institute (Inspect AI, Inspect Evals) | Government evals body | The Inspect adapter is in the repo; Inspect Evals accepts community evals and is used by major labs | Inspect Evals maintainers | GitHub UKGovernmentBEIS/inspect_evals; aisi.gov.uk contact | 2 |
| C22 | Hugging Face | Model and dataset hub | Hosts the hla-bench dataset and the demo Space today; leaderboard or blog placement is reach, not revenue | Science / evals team | huggingface.co contact; existing Space | 3 |

## Notes on exclusions

- Illumina discontinued TruSight HLA in December 2021; CareDx (B6) holds the customers.
- Sirona Genomics (MIA FORA co-developer) is folded into Immucor/Werfen (B4).
- Abbott sells transplant monitoring assays, not HLA typing or matching software; excluded.
- Tempus and NVIDIA were reviewed and set aside: genomics platforms without an HLA
  typing or matching workflow. Revisit if either ships a transplant product.
