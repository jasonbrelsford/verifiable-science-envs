"""4-digit "associated antigen" serology values (IPD-IMGT/HLA 3.64.0+).

Starting with 3.64.0, wmda/rel_dna_ser.txt's Unambiguous/Possible/Assumed/
Expert columns can hold a 4-digit associated-antigen code (e.g. '0201')
instead of the classic 1-2 digit broad/split code ('2') those columns used to
hold. See docs/research-rel_dna_ser-3.65.md for the format-change research and
the derivation of the mapping rule exercised here
(`ImgtReference.classic_antigen`, used by `antigen_of` per rules.py R3).
"""
from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.matching.rules import UNCERTAIN, antigen_of, locus_verdict, score

REF = ImgtReference.load("v3.65.0-alpha")


def test_associated_antigen_collapses_to_classic_code():
    # Raw Unambiguous values straight from rel_dna_ser.txt, for reference:
    assert REF.serology("A*02:01:01:01").unambiguous == ("0201",)
    assert REF.serology("A*02:05:01:01").unambiguous == ("2",)
    # classic_antigen() collapses the 4-digit form; a value already <=2 digits
    # passes through unchanged.
    assert REF.classic_antigen("A", "0201") == "2"
    assert REF.classic_antigen("A", "2") == "2"


def test_a0201_vs_a0205_is_an_antigen_level_match():
    # This is the live bug: A*02:01's raw Unambiguous value is now '0201' (was
    # '2' pre-3.64.0) while A*02:05's is still '2'. Comparing the raw strings
    # makes these look like different antigens; both are A2.
    assert antigen_of(REF, "A*02:01") == "2"
    assert antigen_of(REF, "A*02:05") == "2"
    lv = locus_verdict(REF, "A", "antigen", ["A*02:01", "A*01:01"], ["A*02:05", "A*01:01"])
    assert lv.verdict == "match"


def test_b4016_maps_to_its_split_b60_not_broad_b40():
    # rel_ser_ser.txt: B;60;;4001/4016/4021/4023/4047 (split row) vs
    # B;40;60/61; (broad row, no associated-antigen list of its own) — the
    # associated-antigen list lives on the split's row, so the lookup lands on
    # B60, matching WMDA antigen-level matching convention (splits, not the
    # broad they're nested under).
    assert REF.classic_antigen("B", "4016") == "60"
    assert antigen_of(REF, "B*40:16") == "60"


def test_drb1_1501_maps_to_15():
    assert antigen_of(REF, "DRB1*15:01") == "15"


def test_unmapped_associated_antigen_is_uncertain():
    # B*07:13's associated antigen '0713' is not (yet) listed in 3.65.0's
    # rel_ser_ser.txt (docs/research-rel_dna_ser-3.65.md §2 flags this as one
    # of the six known IMGT cross-referencing gaps) -> UNCERTAIN, not a
    # silent pass-through of the raw 4-digit code.
    assert REF.serology("B*07:13").unambiguous == ("0713",)
    assert REF.classic_antigen("B", "0713") is None
    assert antigen_of(REF, "B*07:13") == UNCERTAIN


def test_dpb1_four_digit_value_has_no_classic_collapse():
    # DPB1 has no broad/split hierarchy in rel_ser_ser.txt; a 4-digit value
    # there is just the allele's own number, passed through as-is.
    s = REF.serology("DPB1*04:01:01:01") or REF.serology("DPB1*04:01:01")
    assert s is not None
    assert REF.classic_antigen("DPB1", s.unambiguous[0] if s.unambiguous else s.best[0]) == (
        s.unambiguous[0] if s.unambiguous else s.best[0]
    )


def test_6_6_framework_pair_wrong_before_right_now():
    # Before this fix: A*02:01 (raw '0201') vs A*02:05 (raw '2') compared as
    # literal strings -> spurious antigen mismatch, dragging the framework
    # down to 4/6 even though both typings are A2 at B and DRB1 identical.
    recipient = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"],
                 "DRB1": ["DRB1*15:01", "DRB1*03:01"]}
    donor = dict(recipient, A=["A*01:01", "A*02:05"])
    s = score(REF, "6/6", recipient, donor)
    assert s["verdicts"]["A"] == "match"
    assert s["count"] == "6/6"
    assert s["hvg_mismatches"] == 0 and s["gvh_mismatches"] == 0
