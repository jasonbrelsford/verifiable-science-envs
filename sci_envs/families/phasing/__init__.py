"""Family B — haplotype phasing & imputation (HLA-Bench-B). See docs/TASK_SPEC_FAMILY_B.md.

Only layer 1 of the §5 data hierarchy exists so far: the seeded synthetic-Mendelian-truth
generator in ``mendelian.py``. Grading, subtypes and the bench split are later sub-steps.
"""
from .mendelian import (
    FAMILY, BASE_SEED, DEFAULT_FOUNDERS, DEFAULT_LOCI, DEFAULT_POPULATION,
    FounderPool, Individual, Family, PhasingError, draw_founder_pool, simulate_family, unphase,
    check_mendelian, normalize_loci,
    generate_dataset, dumps,
)
