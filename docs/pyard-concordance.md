# py-ard concordance report

*Generated 2026-09-07 05:21 UTC · IPD-IMGT/HLA v3.65.0-alpha · py-ard 2.4.0 (db 3650) · script: `scripts/pyard_concordance.py`*

py-ard is NMDP's reduction library for valid typing — the right tool inside a
matching pipeline. HLA-Verify is a verifier for arbitrary (including AI-
generated) text. This report shows both facts: we agree with py-ard where
py-ard applies, and we return structured verdicts where it cannot.

## 1. Overlap slice: 2-field reduction of valid full-resolution names

**1986/2000 identical (99.30%)** on a deterministic random sample of 2000 alleles across A, B, C, DRB1, DQB1, DPB1.

Divergences (each triaged as our bug → test, or documented semantic difference):

| allele | ours | py-ard U2 |
|---|---|---|
| `C*02:02:02:74Q` | `C*02:02` | `C*02:02Q` |
| `C*12:03:01:77Q` | `C*12:03` | `C*12:03Q` |
| `C*12:436` | `C*12:436` | `C*12:03` |
| `C*12:02:02:26Q` | `C*12:02` | `C*12:02Q` |
| `C*06:110` | `C*06:110` | `C*06:02` |
| `B*38:01:01:03Q` | `B*38:01` | `B*38:01Q` |
| `B*49:38` | `B*49:38` | `B*49:01` |
| `DQB1*06:258` | `DQB1*06:258` | `DQB1*06:01` |
| `B*13:224` | `B*13:224` | `B*13:01` |
| `C*05:01:01:81Q` | `C*05:01` | `C*05:01Q` |
| `B*51:01:01:97Q` | `B*51:01` | `B*51:01Q` |
| `C*16:01:01:42Q` | `C*16:01` | `C*16:01Q` |
| `C*03:669` | `C*03:669` | `C*03:04` |
| `C*02:225` | `C*02:225` | `C*02:35` |

## 2. Where py-ard has no opinion (and a verifier must)

| class | input | HLA-Verify | py-ard |
|---|---|---|---|
| legacy colon-less (A*0101) | `A*0101` | `A*01:01` | `A*01:01` |
| legacy colon-less (A*0101) | `B*0702` | `B*07:02` | `B*07:02` |
| legacy colon-less (A*0101) | `DRB1*1501` | `DRB1*15:01` | `DRB1*15:01` |
| legacy colon-less (A*0101) | `Cw*0702` | `C*07:02` | `<InvalidAlleleError>` |
| deleted-with-successor | `A*0105N` | `A*01:04N` | `A*01:04N` |
| deleted-with-successor | `A*01:34N` | `A*01:01` | `<InvalidAlleleError>` |
| deleted-with-successor | `A*02:01:08` | `A*02:1040` | `A*02:01` |
| deleted-with-successor | `A*020116` | `A*02:134` | `<InvalidAlleleError>` |
| deleted-with-successor | `A*020120` | `A*02:01` | `<InvalidAlleleError>` |
| deleted-with-successor | `A*02:01:82` | `A*02:01` | `A*02:01` |
| fabricated | `DQB1*05:03:26:99` | `UNRESOLVABLE` | `DQB1*05:03` |
| fabricated | `P*1801` | `UNRESOLVABLE` | `<InvalidAlleleError>` |
| fabricated | `B*9999` | `UNRESOLVABLE` | `<InvalidAlleleError>` |
| fabricated | `A*99:999` | `UNRESOLVABLE` | `<InvalidAlleleError>` |

A library exception is correct behaviour for a library — and no verdict at
all for a safety gate. HLA-Verify classifies *what kind of wrong* an input
is (fabricated / deleted-with-successor / legacy-era / valid), with the
successor resolution and release version attached.

## 3. Triage of the 14 divergences (2026-09-07)

They fall into exactly two families, both semantic differences rather than bugs:

**Q-suffix on 4-field expression variants (6 cases, e.g. `C*02:02:02:74Q`).**
Our rule (family-A spec R1) names the 2-field *group*: a suffix is kept only
when every full-resolution allele under the 2-field name shares it, so
`C*02:02:02:74Q` → `C*02:02`. py-ard annotates the *reported allele* and keeps
its own suffix (`C*02:02Q`). Different questions, both answerable; our
benchmark's oracle and tasks are self-consistent on the group semantics.

**ARD-equivalence rollups (8 cases, e.g. `C*12:436` → py-ard `C*12:03`).**
py-ard maps ARD-identical alleles onto a group exemplar — exactly right for
matching, where the antigen recognition domain is what matters. As a *name*
normalizer we preserve the distinct allele identity (`C*12:436` is a real,
distinct allele). Reduction answers "functionally which group?"; verification
answers "which name is this, and is it real?".

**Notable from section 2:** given the fabricated `DQB1*05:03:26:99`, py-ard
returns `DQB1*05:03` — a reduction library doing its job, but as a guard it
would launder a fabricated allele into a plausible one. Likewise the deleted
`A*02:01:08` reduces to `A*02:01` where the database's successor is
`A*02:1040`. This is the entire case for a verifier in front of AI output:
**verification and reduction are different jobs.** Use py-ard for reduction
(we do); use a verifier for anything an AI wrote.
