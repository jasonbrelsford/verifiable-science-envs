"""Tests for the pinned IPD-IMGT/HLA reference loader.

These run against the real 3.65.0 files (fetched once into the cache). Facts
asserted here were checked by hand against the ANHIG/IMGTHLA mirror on
2026-08-30; if a later tag is pinned, update the TAG and the numeric facts.
"""
import pytest

from sci_envs.reference import (
    ImgtReference, ImgtError, ReleaseMismatch, split_allele, truncate, is_legacy_name,
    locus_of, is_class_I,
)
from sci_envs.reference.imgt import release_code_to_str, release_str_to_code

TAG = "v3.65.0-alpha"


@pytest.fixture(scope="session")
def ref() -> ImgtReference:
    return ImgtReference.load(TAG)


# ---------------------------------------------------------------- pure helpers
def test_release_codes():
    assert release_code_to_str("3650") == "3.65.0"
    assert release_code_to_str("3631") == "3.63.1"
    assert release_code_to_str("1050") == "1.05.0"
    assert release_str_to_code("3.65.0") == "3650"


def test_split_and_truncate():
    assert split_allele("A*01:01:01:02N") == ("A", ["01", "01", "01", "02"], "N")
    assert split_allele("HLA-DRB1*15:01") == ("DRB1", ["15", "01"], "")
    assert truncate("A*01:01:01:02N", 2) == "A*01:01"
    assert truncate("A*01:01:01:02N", 4) == "A*01:01:01:02N"
    with pytest.raises(ImgtError):
        split_allele("A*0101")           # legacy form is not a current name
    with pytest.raises(ImgtError):
        split_allele("A*1:01")           # leading-zero error
    with pytest.raises(ImgtError):
        truncate("A*01:01", 3)


def test_legacy_detection():
    assert is_legacy_name("A*0101")
    assert is_legacy_name("Cw*0702")
    assert not is_legacy_name("A*01:01")


def test_locus_helpers():
    assert locus_of("DQB1*02:01:01") == "DQB1"
    assert is_class_I("C") and not is_class_I("DRB1")


# ---------------------------------------------------------------- loading
def test_release_and_manifest(ref):
    assert ref.release == "3.65.0"
    m = ref.manifest
    assert m["tag"] == TAG and m["release"] == "3.65.0"
    assert set(m["md5"]) >= {"Allelelist.txt", "wmda/hla_nom_g.txt"}
    assert "CC-BY-ND" in m["attribution"]


def test_md5_verification_passes(ref):
    actual = ref.verify()
    assert actual["Allelelist.txt"] == ref.expected_md5s["Allelelist.txt"]


def test_allele_universe_size(ref):
    assert len(ref.alleles()) == 46652
    assert len(ref.deleted) == 288
    assert ref.exists("A*01:01:01:01")
    assert ref.hla_id("A*01:01:01:01") == "HLA00001"
    assert not ref.exists("A*0101")
    assert not ref.exists("A*01:01:01:999")


def test_assert_release(ref):
    ref.assert_release("3.65.0")
    with pytest.raises(ReleaseMismatch):
        ref.assert_release("3.64.0")


# ---------------------------------------------------------------- expand / reduce
def test_expand_respects_field_boundaries(ref):
    under = ref.expand("A*01:01")
    assert "A*01:01:01:01" in under and "A*01:01:01:02N" in under
    assert all(a == "A*01:01" or a.startswith("A*01:01:") or a[len("A*01:01"):] in "NLSCAQ" for a in under)
    assert not any(a.startswith("A*01:010") for a in under)
    assert len(ref.expand("A*01:01:01")) < len(under)


def test_reduce_suffix_rule(ref):
    # A*01:01 has expressed members, so the N does not survive 2-field reduction
    assert ref.reduce("A*01:01:01:02N", 2) == "A*01:01"
    # A*01:04:01:01N: every allele under A*01:04 is null -> suffix survives
    assert all(split_allele(a)[2] == "N" for a in ref.expand("A*01:04"))
    assert ref.reduce("A*01:04:01:01N", 2) == "A*01:04N"
    assert ref.reduce("A*01:01:01:01", 3) == "A*01:01:01"


# ---------------------------------------------------------------- history
def test_history_basic(ref):
    assert ref.releases[0] == "3.65.0"
    assert "3.27.0" in ref.releases
    assert ref.name_at("HLA00001", "3.65.0") == "A*01:01:01:01"
    assert ref.name_at("HLA00001", "3.27.0") == "A*01:01:01:01"
    assert ref.exists_at("A*01:01:01:01", "3.27.0")


def test_deleted_allele_absent_now_present_before(ref):
    # HLA00965 was A*0105N (legacy era), deleted July 2001 -> NA in all modern columns
    assert ref.name_at("HLA00965", "3.65.0") is None
    d = ref.deleted["A*0105N"]
    assert d.hla_id == "HLA00965"
    assert d.successor == "A*01:04:01:01N"
    assert d.reason == "identical_sequence"
    assert ref.renamed_to("A*0105N") == "A*01:04:01:01N"


def test_renamed_extended(ref):
    # HLA33848 A*02:01:08 "Sequence extended and renamed A*02:1040:01 (January 2022)"
    d = ref.deleted["A*02:01:08"]
    assert d.reason == "renamed_extended"
    assert ref.renamed_to("A*02:01:08") == "A*02:1040:01"
    assert ref.exists("A*02:1040:01")
    assert not ref.exists("A*02:01:08")


def test_low_expression_rename(ref):
    d = ref.deleted["A*01:34N"]
    assert d.reason == "low_expression_renamed"
    assert ref.renamed_to("A*01:34N") == "A*01:01:38L"


def test_first_release_is_earliest(ref):
    fr = ref.first_release("A*01:01:01:01")
    assert fr == "3.00.0"  # colon nomenclature began at 3.0.0; earlier columns hold A*01010101
    assert ref.name_at("HLA00001", "2.28.0") == "A*01010101"
    assert ref.first_release("A*01:01:01:999") is None


def test_added_between_counts_positive(ref):
    n = ref.added_between("3.64.0", "3.65.0")
    assert n > 0
    assert ref.added_between("3.64.0", "3.65.0", locus="A") <= n


# ---------------------------------------------------------------- groups
def test_g_and_p_groups(ref):
    assert ref.g_group("A*01:01:01:01") == "A*01:01:01G"
    assert ref.g_group("A*01:01:01:02N") == "A*01:01:01G"   # null alleles ARE in G groups
    assert ref.p_group("A*01:01:01:01") == "A*01:01P"
    assert ref.p_group("A*01:01:01:02N") is None             # ...but NOT in P groups (the null trap)
    assert "A*01:01:01:01" in ref.g_members("A*01:01:01G")
    assert ref.is_group_name("A*01:01:01G") and ref.is_group_name("A*01:01P")
    assert not ref.is_group_name("A*01:01:01:01")


def test_group_under_prefix(ref):
    gs = ref.g_groups_under("A*01:01:01")
    assert gs == {"A*01:01:01G"}
    ps = ref.p_groups_under("A*01:01:01")
    assert "A*01:01P" in ps and None in ps  # mixes expressed and null members


def test_allele_in_no_g_group(ref):
    # hla_nom_g lists 'A*;01:01:02;' with an empty group -> stands alone
    assert ref.exists("A*01:01:02")
    assert ref.g_group("A*01:01:02") is None


# ---------------------------------------------------------------- serology
def test_serology(ref):
    s = ref.serology("A*01:01:01:01")
    assert s.unambiguous == ("1",) and s.certain
    s2 = ref.serology("A*01:01:01:02N")
    assert s2 is not None and s2.unambiguous == ("0",) and s2.certain  # '0' = null, no antigen
    s3 = ref.serology("A*01:01:38L")
    assert not s3.certain and s3.possible == ("0", "1")
    d = ref.serology("DRB1*01:01:01:01")
    assert d.unambiguous == ("0101",)


def test_serology_relations(ref):
    rel = {(l, b): (s, a) for l, b, s, a in ref.serology_relations}
    assert rel[("A", "9")][0] == ("23", "24")   # A9 splits into A23/A24


# ---------------------------------------------------------------- status
def test_status(ref):
    assert ref.confirmed("A*01:01:01:01")
    st = ref.status["A*01:01:01:02N"]
    assert not st.confirmed and st.type == "gDNA" and not st.partial


# ---------------------------------------------------------------- hallucination
def test_classify_tokens(ref):
    text = ("The allele HLA-A*01:01:01:01 belongs to A*01:01:01G; A*0105N was deleted; "
            "A*02:9999 does not exist and neither does B*99:99:99.")
    c = ref.classify_tokens(text)
    assert c["valid"] == ["A*01:01:01:01"]
    assert c["group"] == ["A*01:01:01G"]
    assert c["deleted"] == ["A*0105N"]
    assert c["hallucinated"] == ["A*02:9999", "B*99:99:99"]
