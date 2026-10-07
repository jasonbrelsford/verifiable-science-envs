"""Family B layer 2 (TASK_SPEC_FAMILY_B §7): the first graded subtypes and their grader.

The gate the issue (#99) names: the oracle — phased truth read straight from the layer-1
generator — scores 100% on every generated task, seeded and byte-reproducible.  Then the
§4 rules one by one: order-normalised exact match, ``phase_flip``, ``impossible_pair``,
blanket ``UNRESOLVABLE`` penalised as refusal, the Mendel oracle behind ``family_phase``
and ``consistency_check``, and the envelope rules inherited from family A.
"""
import json
from collections import Counter

import pytest

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.task import dumps
from sci_envs.families.phasing import (
    SUITE_REV, COUNTS, generate_suite, mendelian_phasings, grade, oracle_response, summarize,
)
from sci_envs.families.phasing.grade import GRADER_VERSION, normalize_pair, PRECEDENCE

REF = ImgtReference.load("v3.65.0-alpha")
TASKS, MANIFEST = generate_suite(REF)
BY = {s: [t for t in TASKS if t.subtype == s] for s in COUNTS}


def _resp(answer, confidence="high", flags=(), reasoning=""):
    return {"answer": answer, "confidence": confidence, "flags": list(flags), "reasoning": reasoning}


def _truth(task):
    return task.full()["answer"]["canonical"]["haplotypes"]


# ------------------------------------------------------------------ the suite itself
def test_suite_shape_and_counts():
    assert MANIFEST["total"] == len(TASKS) == sum(n for _, n in COUNTS.values()) == 90
    for s, (tier, n) in COUNTS.items():
        assert len(BY[s]) == n and all(t.tier == tier for t in BY[s])
        assert all(t.task_id.startswith(f"hla_phasing.{SUITE_REV}.T{tier}.{s}.") for t in BY[s])
    assert MANIFEST["split"]["dev"] + MANIFEST["split"]["test"] == 90 and MANIFEST["split"]["dev"] > 0
    assert MANIFEST["by_subtype"] == {s: n for s, (_, n) in COUNTS.items()}
    assert MANIFEST["dataset_parameters"]["loci"] == ["A", "B", "DRB1"]     # §6 Q1 as settled by #86
    assert len({t.task_id for t in TASKS}) == 90 and len({t.key() for t in TASKS}) == 90


def test_fixed_seed_is_byte_identical():
    again, manifest = generate_suite(REF)
    assert dumps([t.full() for t in again]) == dumps([t.full() for t in TASKS])
    assert dumps(manifest) == dumps(MANIFEST)
    other, _ = generate_suite(REF, base_seed=7)
    assert [t.input for t in other] != [t.input for t in TASKS]


def test_oracle_scores_100_percent():
    for t in TASKS:
        s = grade(t.full(), oracle_response(t.full()), REF)
        assert s.correct and s.calibrated and s.failure_modes == ["clean_correct"], (t.task_id, s.failure_modes)
        assert s.grader_version == GRADER_VERSION and s.hallucinated_names == []
    rep = summarize([grade(t.full(), oracle_response(t.full()), REF) for t in TASKS])
    assert rep["overall"]["acc"] == 1.0 and set(rep["by_subtype"]) == set(COUNTS)


def test_agent_view_hides_the_answer_and_the_plant():
    for t in TASKS:
        a = t.agent()
        assert "answer" not in a and "scorer_notes" not in a
        assert set(a["input"]) >= {"loci", "genotype", "population"}
        for l in a["input"]["loci"]:
            pair = a["input"]["genotype"][l]
            assert len(pair) == 2 and pair == sorted(pair)            # unphased: no positional phase
            assert all(REF.exists(x) for x in pair), pair               # every name is a real release name
        text = json.dumps(a)
        assert "UNRESOLVABLE" not in a["subtype"] and "planted" not in text and "truth" not in text
    # consistency_check and family_phase read identically to the agent, bar the data
    fam, chk = BY["family_phase"][0], BY["consistency_check"][0]
    assert fam.instructions == chk.instructions


# ------------------------------------------------------------- subtype construction
def test_phase_trivial_is_two_loci_one_heterozygous_and_forced():
    for t in BY["phase_trivial"]:
        loci, g = t.input["loci"], t.input["genotype"]
        assert len(loci) == 2 and "relatives" not in t.input
        assert sum(g[l][0] != g[l][1] for l in loci) == 1
        h1, h2 = _truth(t)
        assert [h1, h2] == sorted([h1, h2])
        for i, l in enumerate(loci):
            assert sorted([h1[i], h2[i]]) == g[l]
        assert t.full()["answer"]["expected_flags"] == []


def test_family_phase_is_decidable_by_mendel_alone():
    for t in BY["family_phase"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert set(rel) == {"father", "mother"} and len(loci) == 3
        assert sum(g[l][0] != g[l][1] for l in loci) >= 2            # not trivial by homozygosity
        allowed = mendelian_phasings(g, rel["father"], rel["mother"], loci)
        h1, h2 = _truth(t)
        assert allowed == {(tuple(h1), tuple(h2))}
        for who in rel.values():
            for l in loci:
                assert who[l] == sorted(who[l])                      # parents are unphased too


def test_consistency_check_is_mendel_impossible_with_real_names():
    variants = Counter()
    for t in BY["consistency_check"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert mendelian_phasings(g, rel["father"], rel["mother"], loci) == set()
        assert t.full()["answer"]["canonical"] == "UNRESOLVABLE"
        assert t.full()["answer"]["expected_flags"] == ["inconsistent_genotype"]
        assert all(REF.exists(a) for l in loci for a in g[l])        # Mendelian, not nomenclature
        variants[t.slices[0]] += 1
    assert set(variants) == {"foreign_allele", "impossible_combination"} and min(variants.values()) >= 5


def test_mendelian_phasings_enumerates_and_detects():
    loci = ["A", "B"]
    father = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"]}
    mother = {"A": ["A*03:01", "A*11:01"], "B": ["B*35:01", "B*44:02"]}
    child = {"A": ["A*01:01", "A*03:01"], "B": ["B*08:01", "B*35:01"]}
    assert mendelian_phasings(child, father, mother, loci) == {
        (("A*01:01", "B*08:01"), ("A*03:01", "B*35:01"))}
    # both parents carry both alleles at both loci: two heterozygous loci -> two pairings
    same = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"]}
    assert len(mendelian_phasings(same, same, same, loci)) == 2
    # an allele neither parent carries
    assert mendelian_phasings({"A": ["A*01:01", "A*24:02"], "B": child["B"]}, father, mother, loci) == set()
    # both alleles from the father while the mother carries neither
    assert mendelian_phasings({"A": ["A*01:01", "A*02:01"], "B": child["B"]}, father, mother, loci) == set()


# ------------------------------------------------------------------------ the grader
def _three_locus_het():
    return BY["family_phase"][0]


def test_haplotype_order_prefix_and_object_form_are_forgiven():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    loci = t.input["loci"]
    assert grade(t.full(), _resp({"haplotypes": [h2, h1]}), REF).correct
    assert grade(t.full(), _resp([h1, h2]), REF).correct
    assert grade(t.full(), _resp({"haplotypes": [["HLA-" + a for a in h1], h2]}), REF).correct
    as_obj = [dict(zip(loci, h1)), {f"hla-{l}": a for l, a in zip(loci, h2)}]
    assert grade(t.full(), _resp({"haplotypes": as_obj}), REF).correct
    assert normalize_pair({"haplotypes": [h2, h1]}, loci) == (tuple(h1), tuple(h2))


def test_phase_flip_is_right_alleles_wrong_pairing():
    t = _three_locus_het()
    h1, h2 = (list(h) for h in _truth(t))
    loci = t.input["loci"]
    i = next(i for i, l in enumerate(loci) if h1[i] != h2[i])
    h1[i], h2[i] = h2[i], h1[i]                                       # swap one heterozygous locus
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert not s.correct and s.primary_failure_mode == "phase_flip"
    assert "wrong_but_overconfident" in s.failure_modes and s.hallucinated_names == []
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, confidence="low"), REF)
    assert s.primary_failure_mode == "phase_flip" and "wrong_calibrated" in s.failure_modes


def test_impossible_pair_is_an_allele_the_individual_does_not_carry():
    t = _three_locus_het()
    h1, h2 = (list(h) for h in _truth(t))
    h1[0] = "A*01:01:01:01" if h1[0] != "A*01:01:01:01" else "A*02:01:01:01"   # real name, not carried
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert not s.correct and s.primary_failure_mode == "impossible_pair" and s.hallucinated_names == []
    # a fabricated name in the answer outranks it
    h1[0] = "A*99:999"
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert s.primary_failure_mode == "hallucinated_answer" and s.hallucinated_names == ["A*99:999"]
    assert "impossible_pair" in s.failure_modes


def test_blanket_unresolvable_scores_only_the_inconsistent_tasks():
    scores = [grade(t.full(), _resp("UNRESOLVABLE", flags=["inconsistent_genotype"]), REF) for t in TASKS]
    assert sum(s.correct for s in scores) == COUNTS["consistency_check"][1]
    for s in scores:
        if s.subtype == "consistency_check":
            assert s.failure_modes == ["clean_correct"]
        else:
            assert s.primary_failure_mode == "refused" and not s.correct
    # and the lower-case / prefixed spellings of the sentinel are the same answer
    t = BY["consistency_check"][0]
    assert grade(t.full(), _resp(" unresolvable ", flags=["inconsistent_genotype"]), REF).correct


def test_inconsistent_task_answered_with_a_pair_is_wrong_and_missed_the_flag():
    t = BY["consistency_check"][0]
    loci, g = t.input["loci"], t.input["genotype"]
    pair = [[g[l][0] for l in loci], [g[l][1] for l in loci]]        # reproduces the (impossible) genotype
    s = grade(t.full(), _resp({"haplotypes": pair}), REF)
    assert not s.correct and "missed_ambiguity" in s.failure_modes and s.flags_missed == ["inconsistent_genotype"]
    assert "phase_flip" not in s.failure_modes and "impossible_pair" not in s.failure_modes
    assert s.primary_failure_mode == "wrong_but_overconfident"


def test_flags_are_soft_and_confidence_is_one_sided():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, flags=["phase_ambiguous", "not_a_flag"]), REF)
    assert s.correct and s.flags_spurious == ["phase_ambiguous"]
    assert s.failure_modes == ["false_positive_flag"] and s.primary_failure_mode == "false_positive_flag"
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, confidence="low"), REF)
    assert s.correct and s.calibrated and s.failure_modes == ["clean_correct"]     # under-confidence tolerated
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, reasoning="recalls A*98:765 from memory"), REF)
    assert s.correct and s.primary_failure_mode == "correct_with_hallucinated_reasoning"
    assert s.hallucinated_names == ["A*98:765"]


@pytest.mark.parametrize("answer", [
    "not json at all", {"answer": {"haplotypes": [["A*01:01"]]}}, {"answer": {"haplotypes": "x"}},
    {"answer": None}, {"answer": {"haplotypes": [["A*01:01", "B*07:02", "DRB1*01:01"]] * 3}},
    {"answer": {"haplotypes": [["A*01:01", "B*07:02"], ["A*01:01", "B*07:02"]]}},   # two loci where three asked
    {"nope": 1},
])
def test_malformed_answers(answer):
    t = _three_locus_het()
    s = grade(t.full(), answer, REF)
    assert not s.correct and s.failure_modes == ["malformed_response"]


def test_response_parsed_out_of_prose():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    text = "Here you go:\n" + json.dumps(_resp({"haplotypes": [h1, h2]})) + "\nDone."
    assert grade(t.full(), text, REF).failure_modes == ["clean_correct"]


def test_precedence_is_total_over_every_mode_the_grader_emits():
    emitted = set()
    for t in TASKS[:3]:
        h = _truth(t)
        for r in (_resp("UNRESOLVABLE"), _resp({"haplotypes": h}, flags=["rare_haplotype"]),
                  _resp({"haplotypes": [h[1], h[0]]}, confidence="medium")):
            emitted |= set(grade(t.full(), r, REF).failure_modes)
    assert emitted <= set(PRECEDENCE)
    assert PRECEDENCE.index("impossible_pair") < PRECEDENCE.index("phase_flip") < PRECEDENCE.index("refused")
    assert PRECEDENCE.index("false_positive_flag") < PRECEDENCE.index("clean_correct")
