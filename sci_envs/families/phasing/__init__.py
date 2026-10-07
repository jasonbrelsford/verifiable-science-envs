"""Family B — haplotype phasing & imputation (HLA-Bench-B). See docs/TASK_SPEC_FAMILY_B.md.

Layer 1 of the §5 data hierarchy (``mendelian.py``: seeded synthetic Mendelian truth) and,
on top of it, the first graded slice (``tasks.py``: ``phase_trivial``, ``consistency_check``
and ``family_phase`` — the subtypes that need no LD or frequency model; ``grade.py``: the
§4 grader with ``phase_flip`` / ``impossible_pair`` and refusal penalised as family A does).
The frequency-dependent subtypes, the harness/CLI wiring and GRIMM validation are later
sub-steps (§7).
"""
from .mendelian import (
    FAMILY, BASE_SEED, DEFAULT_FOUNDERS, DEFAULT_LOCI, DEFAULT_POPULATION,
    FounderPool, Individual, Family, PhasingError, draw_founder_pool, simulate_family, unphase,
    check_mendelian, normalize_loci,
    generate_dataset, dumps,
)
from .tasks import SUITE_REV, COUNTS, generate_suite, write_suite, mendelian_phasings
from .grade import grade, oracle_response, summarize
