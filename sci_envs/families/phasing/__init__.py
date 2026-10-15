"""Family B — haplotype phasing & imputation (HLA-Bench-B). See docs/TASK_SPEC_FAMILY_B.md.

Layer 1 of the §5 data hierarchy (``mendelian.py``: seeded synthetic Mendelian truth,
with the §8.1 pool parameters and the Mendel, phased-parent and pedigree oracles) and, on
top of it, the graded subtypes that need no LD or frequency model (``tasks.py``: the three
of §7.1 plus the five of §8.2 — ``impute_missing_locus``, ``resolution_lift``,
``phase_ambiguous``, ``pedigree_phase``, ``null_in_haplotype``; ``grade.py``: the §4 grader
with the §7.2 and §8.3 modes, the ``ranked`` answer form and the probability-sum rule,
refusal penalised as family A does).  The frequency-dependent subtypes and GRIMM
validation are later layers (§8.4).  ``hla-bench generate --family b`` writes the suite.
"""
from .mendelian import (
    FAMILY, BASE_SEED, DEFAULT_FOUNDERS, DEFAULT_LOCI, DEFAULT_POPULATION,
    FounderPool, Individual, Family, PhasingError, draw_founder_pool, simulate_family, unphase,
    check_mendelian, normalize_loci,
    generate_dataset, dumps,
    mendelian_phasings, phased_pairs, pedigree_phasings, order_normalise,
)
from .tasks import SUITE_REV, COUNTS, DATASETS, generate_suite, write_suite, lifted_phasings, split_key
from .grade import grade, oracle_response, summarize
