# Normalize a legacy HLA typing report to the current IPD-IMGT/HLA release

A transplant immunogenetics laboratory has exported 200 HLA typing results for 200 samples (one locus per sample) from systems of different eras. The file `/root/data/typing_reports.csv` has columns `sample_id`, `locus`, `typing_as_reported`. The reported strings are a mixture of:

- current colon-delimited names at 2-, 3- or 4-field resolution (`A*02:01`, `C*01:02:93`, `DRB1*07:01:01:03`), possibly with an expression suffix (`A*33:282N`);
- pre-2010 colon-less names (`A*0201`, `Cw*0702`);
- names that have since been deleted or renamed by the IPD-IMGT/HLA database;
- a few strings that are not, and never were, assigned allele names.

The official nomenclature files for IPD-IMGT/HLA release **3.65.0** are in `/root/imgt/` (`Allelelist.txt`, `Allelelist_history.txt`, `Deleted_alleles.txt`, `Allele_status.txt`, `wmda/hla_nom_g.txt`, `wmda/hla_nom_p.txt`, `wmda/rel_dna_ser.txt`, `wmda/rel_ser_ser.txt`). Use only these files as ground truth; there is no internet access.

Write `/root/normalized.csv` with exactly these columns, one row per input row, in the input order:

`sample_id,locus,allele_2field,g_group,flags`

- `allele_2field`: the reported allele expressed as its **current** 2-field name in release 3.65.0. Resolve legacy and deleted names to their current successor first (a string listed in `Deleted_alleles.txt` counts as deleted even if the same string is also usable as a lower-resolution name today; the deletion note names its successor). Keep an expression suffix on the 2-field name only if **every** full allele under that 2-field name carries the same suffix (e.g. `A*33:282N` stays `A*33:282N`; `A*01:01:01:02N` becomes `A*01:01`). If the reported string is not an assigned name in 3.65.0 and has no successor, write `UNRESOLVABLE`.
- `g_group`: the G group of the reported allele in 3.65.0, with locus prefix (e.g. `A*02:01:01G`). If the reported name identifies a single full allele, use that allele's G group. If it is a lower-resolution name covering several full alleles, use their common G group when all of them share one; write `AMBIGUOUS` when they fall in different G groups (or some are in no group). Write `NONE` when the allele(s) belong to no G group. Write `UNRESOLVABLE` when `allele_2field` is `UNRESOLVABLE`.
- `flags`: a `;`-joined, alphabetically sorted subset of `deprecated_name` (the reported string used legacy colon-less or deleted/renamed nomenclature), `null_allele` (the resolved allele is a null allele, suffix `N`), `nonexistent_allele` (unresolvable). Empty when none apply.

Matching is exact and case-sensitive. Do not invent allele names.

You have 3600 seconds to complete this task. Do not cheat by using online solutions or hints specific to this task.
