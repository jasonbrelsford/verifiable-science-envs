"""Family C rules engine — hand-verified cases (the audit trail for rules.py R1–R6)."""
import pytest

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.matching.rules import (
    FRAMEWORKS, NULL, UNCERTAIN, antigen_of, flat_answer, locus_verdict, score, two_field,
)

REF = ImgtReference.load("v3.65.0-alpha")

TYPED = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"],
         "C": ["C*07:01", "C*07:02"], "DRB1": ["DRB1*15:01", "DRB1*03:01"],
         "DQB1": ["DQB1*06:02", "DQB1*02:01"], "DPB1": ["DPB1*04:01", "DPB1*02:01"]}


def test_antigen_mapping_known_values():
    assert antigen_of(REF, "A*01:01") == "1"
    assert antigen_of(REF, "A*24:02") == "2402"
    assert antigen_of(REF, "A*23:01") == "2301"
    assert antigen_of(REF, "B*15:01") == "1501"
    assert antigen_of(REF, "A*24:09N") == NULL
    assert antigen_of(REF, "A*0101") == "1"          # legacy era resolves first
    assert antigen_of(REF, "B*9999") == UNCERTAIN    # fabricated


def test_identical_pair_is_perfect_everywhere():
    for fw in FRAMEWORKS:
        s = score(REF, fw, TYPED, TYPED)
        assert s["count"].split("/")[0] == s["count"].split("/")[1]
        assert set(s["verdicts"].values()) == {"match"}
        assert s["hvg_mismatches"] == s["gvh_mismatches"] == 0


def test_single_allele_mismatch_is_7_of_8():
    donor = dict(TYPED, A=["A*01:01", "A*03:01"])
    s = score(REF, "8/8", TYPED, donor)
    assert s["count"] == "7/8" and s["verdicts"]["A"] == "mismatch"
    assert s["hvg_mismatches"] == 1 and s["gvh_mismatches"] == 1


def test_legacy_era_typing_matches_modern_equivalent():
    donor = {"A": ["A*0101", "A*0201"], "B": ["B*0702", "B*0801"], "DRB1": ["DRB1*1501", "DRB1*0301"]}
    s = score(REF, "6/6", {k: TYPED[k] for k in ("A", "B", "DRB1")}, donor)
    assert s["count"] == "6/6" and s["flags"] == []


def test_homozygous_recipient_directionality():
    recip = dict(TYPED, A=["A*01:01", "A*01:01"])
    s = score(REF, "8/8", recip, TYPED)
    assert s["count"] == "7/8"
    assert s["hvg_mismatches"] == 1 and s["gvh_mismatches"] == 0  # graft carries the foreign A*02:01


def test_null_allele_is_an_antigen_mismatch_not_a_match():
    # Naive serologic comparison calls A*24:09N "A24" and declares a match with A*24:02.
    lv = locus_verdict(REF, "A", "antigen", ["A*24:09N", "A*02:01"], ["A*24:02", "A*02:01"])
    assert lv.verdict == "mismatch" and "null_allele" in lv.flags
    # At allele level the 2-field names differ outright.
    lv = locus_verdict(REF, "A", "allele", ["A*24:09N", "A*02:01"], ["A*24:02", "A*02:01"])
    assert lv.verdict == "mismatch"


def test_broad_split_antigens_are_distinct():
    lv = locus_verdict(REF, "A", "antigen", ["A*23:01", "A*02:01"], ["A*24:02", "A*02:01"])
    assert lv.verdict == "mismatch"  # A23 vs A24 are splits of A9 but distinct antigens


def test_unresolvable_typing_yields_potential_and_excludes_locus():
    recip = dict(TYPED, C=["C*99:99", "C*07:02"])
    s = score(REF, "8/8", recip, TYPED)
    assert s["verdicts"]["C"] == "potential"
    assert "resolution_insufficient" in s["flags"]
    assert s["count"] == "6/6"  # C excluded from the denominator (R6)


def test_deleted_name_resolves_before_comparison():
    recip = dict(TYPED, A=["A*01:34N", "A*02:01"])   # deleted → A*01:01:38L
    s = score(REF, "8/8", recip, TYPED)
    assert s["verdicts"]["A"] in ("match", "mismatch")  # resolved, not potential
    assert "resolution_insufficient" not in [f for f in s["flags"]]


def test_flat_answer_shape():
    fa = flat_answer(score(REF, "8/8", TYPED, TYPED))
    assert fa["count"] == "8/8" and fa["verdict_DRB1"] == "match"
    assert all(isinstance(v, str) for v in fa.values())
