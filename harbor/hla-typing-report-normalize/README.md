# hla-typing-report-normalize

Normalize 200 HLA typing strings exported from lab systems of different eras (2/3/4-field names, null alleles, pre-2010 colon-less names, deleted/renamed names, and a few never-assigned strings) to their current IPD-IMGT/HLA 3.65.0 two-field names, G groups and quality flags — offline, from the raw nomenclature files only. Exact-match verification on all 200 rows; the verifier rebuilds the ground truth from the same files at build time.
