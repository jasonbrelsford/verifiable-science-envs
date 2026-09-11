# Trademark Memo: HLA-Verify and HLA-Bench

*Prepared 2026-09-11 for Brelsford Software LLC (Jason Brelsford, hello@hlaverify.com).
Research memo, not legal advice - see disclaimer at the end. This is a knockout search
(quick screen for obvious blockers), not a full clearance search or opinion.*

## Method and limitations

USPTO's tmsearch.uspto.gov, EUIPO TMview, and WIPO Global Brand Database (gated by an
ALTCHA CAPTCHA) are JavaScript apps this session's fetch tool could not render or pass, so
none could be queried directly. Findings below come from web search, third-party USPTO
mirrors (Justia, Trademarkia, uspto.report - which also 403'd on direct fetch), and direct
RDAP domain lookups (`rdap.org`, which did work). **A trademark attorney should re-run the
USPTO/EUIPO/WIPO searches directly before filing** - this memo cannot certify a negative
result on those three systems of record.

## Knockout search results

| Mark searched | Owner if found | Status / classes | Risk | Why |
|---|---|---|---|---|
| HLA-Verify / HLAVerify | none found | n/a | **none found** | No trademark, repo, package, or org uses this string on USPTO mirrors, GitHub, PyPI, npm, or Hugging Face. |
| HLA-Bench / HLABench | none found | n/a | **none found** | Same result; string does not appear as a project/package name anywhere searched. |
| HLA (standalone) | HLA Brand Management Co. | registered, leather goods | low | Word overlap only; unrelated goods (fashion, not software). |
| HLA RESULTS | modeling-and-simulation vendor | registered, Class 9 | low | "HLA" = defense High Level Architecture standard here, not the gene system - different field. |
| HLA Fusion | Thermo Fisher / One Lambda | in commercial use (™), typing-instrument software | medium | Same HLA-genomics domain, adjacent function (assay data reduction, not free-text verification), different core word. |
| HLA Twin | Omixon (acq. Werfen 2024) | in commercial use (™), NGS genotyping software | medium | Same domain; genotyping from sequencer reads, not verifying already-typed names. |
| HLA Explore | Omixon | in commercial use, NGS analysis software | low-medium | Same domain, unrelated core word. |
| HLA Assign / Olerup Assign / TruSight Assign | Illumina / CareDx / Werfen | in commercial use (™), typing-call software, multiple vendors | low-medium | "Assign" used descriptively by several vendors - crowded, weak individual claims; different function. |
| HLAMatchmaker | R. Duquesnoy / academic-commercial | no registration found | low | Matching-adjacent, but unrelated word; nothing to search against. |
| DonorCheck | Univ. of Minnesota (OSS) | none found | low | Closest functional neighbor per `docs/PRIOR_ART.md`, unrelated name. |
| Generic "Verify" marks, Nice 42/44, medical/genomic scope | not identified | n/a | **unresolved** | Could not query TESS/tmsearch, TMview, or WIPO branddb directly - needs a professional full search. |

**Bottom line:** no identical or confusingly similar registered mark surfaced for
"HLA-Verify" or "HLA-Bench" in anything this session could query. The nearest neighbors
(HLA Fusion, HLA Twin, HLA Explore, HLA Assign) share the domain but pair "HLA" with a
different core word and a different function (typing/genotyping vs. verification), the
usual basis for distinguishing marks that share a generic first element. The open gap is
the class 42/44 "Verify" screen, which needs a direct USPTO/TMview/WIPO query a human or a
JS-capable browser session can run.

## Domain names (RDAP, checked 2026-09-11)

**hlaverify.com** - registered, Cloudflare Inc., created 2026-08-30 (matches Jason's
ownership). All of **hla-verify.com, hlaverify.org/.net, hlabench.com/.org/.net,
hla-bench.com/.org/.net are available** (no registrant). `.io` variants of both marks
returned no RDAP service at the registry - unconfirmed either way, check the registrar
directly. No conflicting registration found for either mark. Recommend defensively
registering hlaverify.org and hlabench.com/.org regardless of the trademark decision -
cheap, and blocks confusion given the live commercial API.

## Recommendation

**File HLA-VERIFY as a standard-character word mark with the USPTO now.** It is the mark
doing commercial work (the paid API, hlaverify.com). Treat HLA-BENCH as lower priority -
rely on the git history's defensive-publication timestamp (`docs/PRIOR_ART.md`) for now and
register it only once it carries its own commercial offering (e.g., a paid leaderboard).

- **Classes:** Nice **42** (SaaS; scientific/technological verification services - covers
  the API, MCP server, demo) and Nice **44** (medical laboratory information services) if
  marketing leans on "used by transplant labs." Class 9 (downloadable software) is not
  needed - today's product is a hosted API and browser demo, a service, not packaged software.
- **Filing basis: 1(a), use in commerce.** api.hlaverify.com has been live since 2026-08-30
  with public specimens (`/docs` OpenAPI page, `hlaverify.com/demo`, the README `curl`
  example) predating any filing - no need for the slower 1(b) intent-to-use track.
- **Fees:** the USPTO merged "TEAS Plus"/"TEAS Standard" into one system in January 2025;
  base fee is **$350/class** using ID-Manual language under 1,000 characters, with
  surcharges otherwise (+$100 incomplete filing, +$200 custom description, +$200 per extra
  1,000 characters) per
  [tmarkmetric.com's 2026 fee schedule](https://tmarkmetric.com/insights/uspto-trademark-fees-2026),
  cross-checked against
  [Stinson LLP's summary](https://www.stinson.com/newsroom-publications-usptos-new-trademark-fees-expected-to-impact-filing-costs).
  **Verify on uspto.gov/trademarks/apply/filing-fees before paying** - that page 404'd on
  direct fetch this session, so the figure above is second-hand. "TEAS Plus vs Standard" is
  now moot: one system, and completeness just decides base fee vs. surcharge.
- **Estimated cost:** 2 classes × $350 = **$700** in USPTO fees; add $500–$1,500 in attorney
  time if using counsel. Budget **$700–$2,200** for the US filing alone.
- **Specimens/first use already in hand:** the live API + OpenAPI docs, the demo page, the
  public commit history (first commit 2026-08-29), and the documented 60 req/min public
  tier - together supporting a 2026-08-30 to 2026-09 first-use date.
- **Descriptiveness risk (the central issue):** "HLA" is the generic name of the biological
  system; "Verify" merely describes the function. A composite of two descriptive/generic
  terms risks refusal as merely descriptive under Lanham Act §2(e)(1). Mitigations, in order
  of strength: (1) **§2(f) acquired distinctiveness** needs ~5 years of substantially
  exclusive use - not available yet; (2) **Supplemental Register**, available immediately,
  allows ® and a later move to the Principal Register once 5 years accrue, but grants no
  incontestability and a weaker infringement posture; (3) **file Principal Register first
  and let the examiner decide** - the hyphenated composite is more distinctive than either
  word alone, and comparable composites (HLA Fusion, HLA Twin) trade without evident
  refusal. Recommended path: Principal Register first, Supplemental as fallback if refused.
- **Madrid/EUIPO extension: not worth it yet.** Madrid costs a **$600/class USPTO
  certification fee** plus WIPO's own schedule (~650–900 CHF base plus per-country fees); a
  standalone EUIPO Class-42 filing is **€850 for one class, +€50 for a second**
  ([Marqvision](https://www.marqvision.com/blog/international-trademark-registration-fees)).
  With no EU customer or lab partner signed (`STATUS.md` still lists partnerships as
  sought), spend that ~$1,000–$1,500 on the US filing now and file internationally once a
  specific EU/UK partner or revenue signal exists - trademark rights are territorial, so
  waiting costs nothing except the risk of a same-name filer abroad.
- **Total rough cost today:** US-only, two classes: **~$700–$2,200.** Add Madrid/EUIPO
  (~$1,500–$2,500) only on a concrete non-US commercial trigger.

## Pre-filing checklist

1. Re-run USPTO TESS/tmsearch, EUIPO TMview, and WIPO branddb directly (human or a
   JS-capable browser) for HLA-VERIFY and close misspellings - not completed here.
2. Decide standard-character vs. stylized logo mark (a logo is a separate filing).
3. Confirm the current USPTO base fee and surcharge rules directly on uspto.gov before paying.
4. Gather dated specimens: api.hlaverify.com/docs, hlaverify.com/demo, the commit history.
5. Have counsel confirm the Principal-vs-Supplemental Register call given the §2(e)(1) risk.
6. File HLA-BENCH's clearance as a fast follow when it earns its own revenue line.

## Owner/entity checklist

1. **Applicant name** "Brelsford Software LLC" - confirm exact legal name on file, not a DBA.
2. **State of formation: unconfirmed.** Web search found only an apparently unrelated
   "Brelsford, LLC" (Pennsylvania, different name, residential address) - do not assume
   Pennsylvania; confirm from Jason's own filing records or a state business-entity search.
3. **Registered address** - confirm it matches the entity's current record for USPTO mail.
4. **Signatory authority** - confirm who signs the declaration (Jason, presumably sole
   member/manager - confirm title).
5. **Good standing** - confirm the LLC is currently active in its state of formation.
6. **Filing route** - decide pro se via USPTO.gov account vs. retained trademark counsel.

## Disclaimer

Prepared by an AI coding assistant using public web search and direct RDAP lookups. **Not**
a legal opinion, **not** a clearance or registrability opinion. USPTO, EUIPO, and WIPO's own
search systems could not be queried directly this session, so this knockout search is
materially incomplete on the systems that matter most. A registered trademark attorney
should run a full clearance search (including phonetic equivalents and design marks) and
confirm the descriptiveness strategy before any application is filed.
