# Research: `wmda/rel_dna_ser.txt` format change (IPD-IMGT/HLA 3.64.0 / 3.65.0)

Originally read-only research; sections 1-3 below are unchanged. Sources are
GitHub raw files fetched from `github.com/ANHIG/IMGTHLA` (tags `v3.60.0-alpha`
… `v3.65.0-alpha`) plus the local cache at
`~/.cache/sci_envs/imgt/v3.65.0-alpha/wmda/`.

**Implementation note (added when the fix landed):** §2's rule is implemented
almost verbatim as `ImgtReference.classic_antigen()` in
`sci_envs/reference/imgt.py`, used by `antigen_of()` in
`sci_envs/families/matching/rules.py` (R3). One refinement from the "which
target field" question §2 leaves open: the code does **not** unconditionally
return the row's Antigen (broad) field — it returns whatever antigen field the
matching `rel_ser_ser.txt` row carries, which is the **split** whenever a split
exists (the AssociatedAntigen list lives on the split's own row, e.g.
`A;24;;2402/2403/...`, not on the broad row that lists it as a split,
`A;9;23/24;`) and only the broad when IMGT itself can't resolve finer than
broad (the one observed 3.65.0 case: `B;21;49/50;4005` — B*40:05 is only
known to be broad B21, not split B49 or B50). So the rule already matches
WMDA antigen-level matching convention (compare splits, e.g. A24 not A9)
without needing a separate "prefer split" special case — see the docstring on
`ImgtReference._associated_antigen_index` for the row-level reasoning and the
"Impact on HLA-Bench-C" section below for what changed in the benchmark.

## 1. Which release introduced the change, and what it means

**Correction to the problem statement: the format changed in release 3.64.0, not 3.65.0.**
Field-count check across every tag in the range:

| tag | version | date | fields/line |
|---|---|---|---|
| v3.60.0-alpha | 3.60.0 | 2025-04-09 | 6 |
| v3.61.0-alpha | 3.61.0 | 2025-07-14 | 6 |
| v3.62.0-alpha | 3.62.0 | 2025-10-08 | 6 |
| v3.63.0-alpha | 3.63.0 | 2026-01-14 | 6 |
| v3.63.1-alpha | 3.63.1 | — | 6 |
| **v3.64.0-alpha** | **3.64.0** | **2026-04-16** | **7** |
| v3.65.0-alpha | 3.65.0 | 2026-07-14 | 7 |

3.65.0 (the release the local cache has) simply carries the 3.64.0 change forward.

**What changed and why**: `wmda/README.md` (present starting at v3.64.0-alpha; diffed
against the v3.63.0-alpha copy) documents this explicitly under the heading
"HLA Nomenclature Report 2026", citing the new WHO report:
https://onlinelibrary.wiley.com/doi/10.1111/tan.70595. Quoting the relevant parts:

> "Changes to the `rel_dna_ser.txt` file include: The addition of an additional
> column to provide information assigned by the HATS algorithm
> (https://github.com/kosoegawa/HATS). This column will include either an
> associated antigen, split, broad or be left blank as determined by the
> algorithm. Any existing three digit associated antigen designations will be
> extended to four digits by adding a leading zero e.g. 203 to 0203. The values
> in the third to sixth fields representing Unambiguous, Possible, Assumed or
> Expert assigned antigens associated with the allele may be updated to reflect
> any new assignment."

So:
- **7th field** = HATS-algorithm-assigned specificity (associated antigen / split /
  broad / blank), new in 3.64.0. It is a machine-computed cross-check column, not
  simply a copy of the Unambiguous field (see §2 below — the two agree on only
  15,231 of 46,652 rows).
- **4-digit values in fields 3–6** (Unambiguous/Possible/Assumed/Expert) are the
  new, finer-grained "associated antigen" designations introduced by the 2026 WHO
  Nomenclature Report, zero-padded to 4 digits (old 3-digit codes like `203`
  become `0203`). Per the README, these are not purely cosmetic — the Report also
  reassigned real serology values for many alleles (confirmed empirically, §2).
- `wmda/rel_ser_ser.txt` grew from 31 to 79 content rows (+48, close to the
  README's stated "forty-nine new lines") because broad specificities that
  previously had no associated-antigen breakout (e.g. `A;3`, `A;29`, `A;30`…) now
  do, and existing associated-antigen lists were extended (e.g. `A;2` grew from
  `203/210` to `0201/0202/0203/0208/0210/0211/0216/0218/0219/0220/0244/0246/
  0256/0265/0285`).
- A new `wmda/pre2026/` sub-folder ships frozen pre-2026-report copies of
  `hla_nom.txt`, `rel_ser_ser.txt`, `rel_dna_ser.txt` "for testing/comparison
  purposes ... not intended for long term or clinical usage."
- `hla_nom.txt` also gained lines for new antigen specificities (not otherwise
  reformatted).

Also checked: IMGTHLA GitHub release notes / `change_log.txt` at the repo root —
`change_log.txt` just points to GitHub's own commit history and has no
release-specific content; the `wmda/README.md` above is the authoritative,
IMGT-published description of this change.

## 2. Deterministic mapping from the 3.65.0 file to the classic antigen (A2, A24, B7, DR15, DQ6…)

**Rule**: for locus `L*` in `{A*, B*, C*, DRB1*, DRB3*, DRB4*, DRB5*, DQB1*}`,
map its rel_dna_ser locus prefix to the rel_ser_ser locus label
(`A*→A, B*→B, C*→Cw, DRB1*/DRB3*/DRB4*/DRB5*→DR, DQB1*→DQ`). For any serology
value `v` in fields 3–7 of a 3.65.0 row:

- if `v` is empty, `0`, `?`, or 1–2 digits → pass through unchanged (already the
  classic broad/split code, e.g. `2`, `24`, `15`).
- if `v` is a 4-digit numeric string → look it up as an **Associated Antigen**
  entry in `wmda/rel_ser_ser.txt` (`Locus;Antigen;Split;AssociatedAntigenList`,
  values in the 4th field split on `/`); the antigen returned in that row's 2nd
  field is the classic broad/split serology (e.g. `0201→2` i.e. **A2**,
  `2402→24` i.e. **A24**, `0702→7` i.e. **B7**, `1501→15` i.e. **DR15**).
- `DPB1*`/`DPA1*`/`DQA1*`/`DRA*` and all non-classically-serotyped loci: their
  4-digit values (e.g. `DPB1*02:01:...;0201;...`) are just the allele's own
  2-field number passed through by HATS — DP/DQA/DRA have no broad/split/
  associated hierarchy in `rel_ser_ser.txt`, so there is no classic-antigen
  collapse to do; treat as "no classic serology" / pass-through as-is.

This is **not** simply "first field of the allele + two digits" — the collapse
must go through `rel_ser_ser.txt`; dropping digits mechanically is wrong because
associated-antigen numbers do not always share their allele's own two-field
number (e.g. `A*24:10` allele has associated antigen `2410`, but a related
formerly-lumped allele can map to `2403`; `B*40:16` → associated antigen `4016`
→ classic **B60**, not B40; `B*48:02` → `4802` → classic **B72**, not B48).

**Lookup coverage (whole 3.65.0 file, all 5 serology-bearing fields, A/B/C/DR/DQ
loci only)**: 33,023 occurrences of a 4-digit code; 33,017 resolved via
`rel_ser_ser.txt` (**99.98%**). The only 6 failures (3 unique allele/field pairs)
are codes not yet listed in 3.65.0's `rel_ser_ser.txt`:
`B*07:13` → `0713`, `B*67:02:01:01`/`B*67:02:01:02` → `6702`. These look like a
small upstream lag in IMGT's own cross-referencing, not a bug in this mapping.

**Empirical validation against 3.60.0** (comparing the classic value the mapping
rule produces from 3.65.0 against the literal old-file value, for the 42,412
alleles present in both releases):

| field | rows with a value | mapping reproduces old value exactly | % |
|---|---|---|---|
| Unambiguous | 22,418 | 19,085 | 85.13% |
| Possible | 35 | 16 | 45.71% (tiny n) |
| Assumed | 21,479 | 19,923 | 92.76% |
| Expert | 302 | 299 | 99.01% |

**Every Unambiguous exception characterized** (3,333 of 22,418):
- **87 rows**: old value was blank (no serology known pre-2026); 2026 report
  newly assigned one. Not a mapping error — genuinely new information.
- **147 rows**: old value, when itself collapsed to broad/split via 3.60.0's
  `rel_ser_ser.txt`, agrees with the new mapped value — the only difference is
  that the *old* file already stored a fine-grained associated-antigen code
  (e.g. `203`) rather than the broad code, so exact string match fails, but the
  classic antigen is the same. 26 of these are pure zero-pad cases
  (`203→0203`, `2403→2403` etc. with no digit change beyond the leading zero).
- **3,099 rows**: genuine reclassification — the classic broad/split antigen
  itself changed between 3.60.0 and 3.65.0 as part of the 2026 WHO Nomenclature
  Report update. Examples: `A*68:10` A28→**A68**, `B*15:37` B70→**B71**,
  `B*15:52` B15→**B71**, `B*38:03` B16→**B38**, `B*40:16:01:01` B61→**B60**,
  `B*40:47` B40→**B60**, `B*48:02:01` B48→**B72**, `B*56:03` B22→**B56**,
  `C*03:07:01:01` Cw3→**Cw10**, `C*12:02:01` `?`→**Cw12**. These are real
  scientific reassignments, not a formatting artifact — any code that cached or
  hard-coded classic antigens from pre-3.64.0 `rel_dna_ser.txt` snapshots will be
  wrong for ~3,100 alleles (roughly 7% of alleles with an old Unambiguous value)
  until it re-derives from 3.65.0+.

Assumed-field exceptions follow the same two patterns (new assignment where
previously blank, and genuine reassignment); Expert-field exceptions are only 3
rows total (too few to characterize a pattern; spot-checked, all are cases IMGT
removed/changed a registry-specific exception).

**Bottom line rule for HLA-Verify**: use 3.65.0 (or later) `rel_dna_ser.txt` +
`rel_ser_ser.txt` together, not `rel_dna_ser.txt` alone and not a cached
antigen table from pre-3.64.0. The `rel_ser_ser.txt` reverse-lookup is
deterministic and correct 99.98% of the time it's invoked (6 known gaps, both
on locus B, both already flagged above); treat those 2 codes as
"unmapped — needs IMGT rel_ser_ser.txt update" rather than guessing.

## 3. Other wmda-folder format changes, 3.60.0 → 3.65.0

- `hla_nom_g.txt`, `hla_nom_p.txt`: **field count unchanged** (3 fields each,
  `Locus;AlleleList;GroupName` / `;PName`). Only the header's `date`/`version`
  lines changed, plus normal growth in the number of grouped alleles
  (25,751→27,522 lines in `hla_nom_g.txt`; 18,165→19,292 in `hla_nom_p.txt`) as
  new alleles were named — not a schema change.
- `rel_ser_ser.txt`: **field count unchanged** (4 fields:
  `Locus;Antigen;Split;AssociatedAntigen`), but content grew from 31 to 79 rows
  (+48) as described in §1 — new associated-antigen breakouts and expanded
  associated-antigen lists per the 2026 report.
- `rel_dna_ser.txt` header: `author` line changed from
  `WHO, Steven G. E. Marsh (the IPD-IMGT/HLA curator contact listed on the ANHIG/IMGTHLA repository)` to
  `IPD Team (ipdsubs@anthonynolan.org)` starting at 3.64.0-alpha (all files'
  header `date`/`version` lines change every release as expected).
- New `wmda/README.md` file (didn't exist, or wasn't versioned per-tag, before
  3.64.0-alpha) and new `wmda/pre2026/` sub-folder shipping frozen
  pre-2026-report copies of `hla_nom.txt`, `rel_ser_ser.txt`, `rel_dna_ser.txt`.
- No other wmda file (`hla_nom.txt` schema, `md5checksum.txt`) changed field
  layout.

## Sources

- https://github.com/ANHIG/IMGTHLA (tags v3.60.0-alpha … v3.65.0-alpha)
- https://raw.githubusercontent.com/ANHIG/IMGTHLA/v3.64.0-alpha/wmda/README.md
  (primary source for the HATS column and 4-digit associated-antigen change)
- https://raw.githubusercontent.com/ANHIG/IMGTHLA/v3.63.0-alpha/wmda/README.md
  (baseline, for diffing — this file did not exist/was unchanged in this form
  before 3.64.0-alpha)
- 2026 WHO Nomenclature Report (cited by the README):
  https://onlinelibrary.wiley.com/doi/10.1111/tan.70595
- HATS algorithm: https://github.com/kosoegawa/HATS
- Local cache: `~/.cache/sci_envs/imgt/v3.65.0-alpha/wmda/{rel_dna_ser.txt,
  rel_ser_ser.txt,hla_nom_g.txt,hla_nom_p.txt}`
- Raw fetches for 3.60.0–3.64.0: `https://raw.githubusercontent.com/ANHIG/IMGTHLA/<tag>/wmda/<file>`

## Impact on HLA-Bench-C

Methodology: the bug only matters where `rules.score()` compares two
*different* alleles at antigen level (frameworks `6/6` and `antigen`; the
allele-level frameworks `8/8`/`10/10`/`12/12` never call `antigen_of()` at
all). For each task I recomputed `score()` on the task's exact, unmodified
`input` (recipient/donor typings + framework) twice — once against the code as
it stood at `HEAD` before this fix (a full copy of `sci_envs/` with only
`reference/imgt.py` and `families/matching/rules.py` swapped back in, run from
a separate `sys.path` entry so both versions could be imported in the same
process) and once against the fixed code — and compared `flat_answer()` plus
`expected_flags`. This isolates exactly the antigen-collapse change; nothing
else in the pipeline differs between the two runs.

**The 43 committed `runs/hla-bench-c/dev/*.json` tasks, as committed: 0/43
change.** Not because the bug is inert — the 4-digit associated-antigen codes
are genuinely present in this dev set's raw serology (e.g. `A*02:02` → raw
`0202`, `B*48:01` → raw `4801`, 47 raw-4-digit occurrences across the 43
tasks' 270 distinct alleles) — but because of two compounding sampling
effects: (1) the generator's `Pools` draws mostly land on obscure,
high-suffix-number alleles (`A*68:86`, `C*02:101`, `DQB1*05:315`, …) whose
`rel_dna_ser.txt` Unambiguous value is *already* a short classic code —
IMGT/HATS only assigns 4-digit associated-antigen codes to a curated few
hundred well-characterized alleles (`rel_ser_ser.txt`'s AssociatedAntigen
lists), not to the long tail; and (2) where a 4-digit-coded allele **is**
drawn, it happens to appear identically on both the recipient's and the
donor's side of every affected dev task — comparing a (wrong, pre-fix) raw
code to itself still "matches", so the bug stays invisible. The
`antigen_vs_allele` subtype (designed to pick two *different* alleles sharing
one antigen) is structurally biased against ever exposing this bug in the
committed set: its own generation-time filter, `antigen_of(a) == antigen_of(b)`,
ran under the *pre-fix* `antigen_of`, so it could only ever select pairs whose
raw literal strings were already equal — exactly the cases the fix doesn't
change. Cases like `A*02:01` (raw `0201`) vs `A*02:05` (raw `2`), which the
fix newly recognizes as the same antigen, were invisible to that filter and
so could never have been drawn into this dev set pre-fix either. In short,
the committed dev split under-samples this bug by construction, not by luck.

**A freshly regenerated suite (`python -m sci_envs.harness.run generate
--family c`, same tag/seed/`SUITE_REV`, run to a scratch directory — not
committed, and the committed `dev/*.json` files were left untouched): 1/205
tasks change** (43 "dev" + 162 "test"/sealed-shaped; the regenerated dev set
is *not* byte-identical to the committed one — `Pools` selection itself now
runs through the fixed `antigen_of`, so re-running the generator draws a
different, though same-sized, sample — which is exactly the mechanism in the
paragraph above). The one flip:

- `hla_matching.r3.T2.antigen_vs_allele.0026` (test split, framework
  `antigen`): recipient carries `DRB1*14:17` (raw Unambiguous `1402`) where
  the donor carries `DRB1*14:121` (raw Assumed `14`, no 4-digit form). Old
  code compared the literal strings `'1402' != '14'` → `verdict_DRB1
  = mismatch`, `count = 9/10`. Fixed code collapses `1402` → `14` via
  `rel_ser_ser.txt` (`DR;14;;1401/1402/1403/...`) → `verdict_DRB1 = match`,
  `count = 10/10`. This is the textbook case the fix targets, and it is the
  only case among 205 regenerated tasks where the two alleles being compared
  at antigen level were both drawn from the small pool of well-characterized,
  4-digit-coded alleles *and* differ in whether they got the 4-digit form.

**Bottom line for the COO:** this benchmark's antigen-level coverage of the
3.64.0 bug is thin — about 1 in 200 generated tasks currently exercises it,
and 0 of the 43 committed dev tasks do, purely from how `Pools` samples
alleles and (for `antigen_vs_allele`) how its own pre-fix filter avoided the
bug. If HLA-Bench-C is meant to catch or regression-test this class of bug
going forward, the generator's allele pools should be biased toward
alleles that carry a 4-digit associated-antigen code in `rel_dna_ser.txt`
(there are a few hundred, enumerable from `rel_ser_ser.txt`'s
AssociatedAntigen columns) rather than relying on incidental draws from the
full allele list — a follow-up task, not done here per the "don't rewrite
committed dev tasks or published bench results" instruction.
