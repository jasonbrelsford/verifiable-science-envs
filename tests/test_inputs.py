"""Reported-typing shorthands accepted as input: G/P group names, XX codes, two-field lg
notation, an optional HLA- prefix on any field count, and NMDP MAC codes (recognised, never
expanded). Mirrors edge/test/golden.test.mjs through the fixtures, so every expectation here
is also what the Worker must return."""
import pytest
from fastapi.testclient import TestClient

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize, resolve_name
from sci_envs.families.matching.rules import score
from sci_envs.service import lab
from sci_envs.service.app import app

TAG = "v3.65.0-alpha"


@pytest.fixture(scope="session")
def ref():
    return ImgtReference.load(TAG)


@pytest.fixture(scope="session")
def pf(ref):
    return lab.get_protein_facts(ref)


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.mark.parametrize("reported,name,flag,two", [
    ("A*02:01:01G", "A*02:01:01G", "g_group_name", "A*02:01"),
    ("DRB1*15:01:01G", "DRB1*15:01:01G", "g_group_name", "DRB1*15:01"),
    ("DPB1*04:01P", "DPB1*04:01P", "p_group_name", "DPB1*04:01"),
    ("HLA-A*02:01:01G", "A*02:01:01G", "g_group_name", "A*02:01"),
    ("A*02:XX", "A*02", "xx_code", "A*02"),
    ("HLA-DQB1*06:XX", "DQB1*06", "xx_code", "DQB1*06"),
    ("A*02:01g", "A*02:01", "lg_notation", "A*02:01"),
    ("DQB1*06:02g", "DQB1*06:02", "lg_notation", "DQB1*06:02"),
])
def test_shorthands_resolve_with_a_flag(ref, reported, name, flag, two):
    got, flags = resolve_name(ref, reported)
    assert got == name and flag in flags
    n = normalize(ref, reported)
    assert n["allele_2field"] == two and flag in n["flags"].split(";")


def test_g_group_normalizes_to_itself(ref):
    assert normalize(ref, "A*02:01:01G")["g_group"] == "A*02:01:01G"


def test_lg_over_a_null_keeps_the_suffix(ref):
    n = normalize(ref, "A*24:09g")
    assert n["allele_2field"] == "A*24:09N" and set(n["flags"].split(";")) == {"lg_notation", "null_allele"}


def test_lg_over_a_renamed_two_field_name_chases_the_successor(ref):
    name, flags = resolve_name(ref, "A*24:447g")
    assert name == "A*24:447Q" and flags == {"lg_notation", "deprecated_name"}


def test_hla_prefix_on_four_fields(ref):
    assert resolve_name(ref, "HLA-A*02:01:01:01") == ("A*02:01:01:01", set())
    assert resolve_name(ref, "HLA-A*02:01")[0] == "A*02:01"


@pytest.mark.parametrize("bad,flags", [
    ("A*99:XX", {"xx_code", "nonexistent_allele"}),
    ("A*99:01g", {"lg_notation", "nonexistent_allele"}),
])
def test_shorthands_over_nothing_are_unresolvable(ref, bad, flags):
    assert resolve_name(ref, bad) == (None, flags)
    assert normalize(ref, bad)["allele_2field"] == "UNRESOLVABLE"


@pytest.mark.parametrize("mac", ["A*02:AB", "DRB1*04:BNDC", "HLA-B*15:ABCDE"])
def test_mac_codes_are_recognised_not_expanded(ref, mac):
    assert resolve_name(ref, mac) == (None, {"mac_code"})
    assert normalize(ref, mac) == {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": "mac_code"}


def test_mac_shapes_that_are_not_codes(ref):
    # one letter, six letters, lowercase: not MAC-shaped, so plain nonexistent names
    for s in ("A*02:A", "A*02:ABCDEF", "A*02:ab"):
        assert resolve_name(ref, s) == (None, {"nonexistent_allele"})


def test_classify_tokens_sees_mac_lg_and_xx(ref):
    c = ref.classify_tokens("Patient: A*02:AB, A*24:XX; C*07:01g; DRB1*04:BNDC; DQB1*03:01P; A*99:01g; A*99:XX")
    assert c["mac_code"] == ["A*02:AB", "DRB1*04:BNDC"]
    assert c["valid"] == ["A*24:XX", "C*07:01g"]
    assert c["group"] == ["DQB1*03:01P"]
    assert c["hallucinated"] == ["A*99:01g", "A*99:XX"]


def test_verify_endpoint_reports_mac_codes_and_keeps_clean_fabrication_only(client):
    r = client.post("/v1/verify", json={"text": "A*02:AB and A*02:01:01G and C*07:01g"}).json()
    by = {t["token"]: t for t in r["tokens"]}
    assert by["A*02:AB"]["status"] == "mac_code" and r["counts"]["mac_code"] == 1
    assert by["A*02:01:01G"]["status"] == "group"
    assert by["C*07:01g"]["status"] == "valid" and by["C*07:01g"]["flags"] == ["lg_notation"]
    assert r["clean"] is True


G_TYPING = {"A": ["A*02:01:01G", "A*24:02:01G"], "B": ["B*44:02:01G", "B*07:02:01G"],
            "C": ["C*07:02:01G", "C*05:01:01G"], "DRB1": ["DRB1*04:01:01G", "DRB1*15:01:01G"]}
ALLELE_TYPING = {"A": ["A*02:01:01:01", "A*24:02"], "B": ["B*44:02", "B*07:02:01"],
                 "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*04:01", "DRB1*15:01"]}


def test_g_group_typing_passes_typing_check(ref, pf):
    out = lab.check_typing(ref, pf, G_TYPING)
    assert out["valid"] is True
    assert all(row["status"] == "ok" for rows in out["loci"].values() for row in rows)
    assert out["drb345"] == {"expected": ["DRB4", "DRB5"], "reported": [], "determinate": True}


def test_g_group_typing_matches_itself_and_allele_level_typing(ref):
    assert score(ref, "8/8", G_TYPING, G_TYPING)["count"] == "8/8"
    s = score(ref, "8/8", G_TYPING, ALLELE_TYPING)
    assert s["count"] == "8/8" and s["flags"] == []
    assert score(ref, "6/6", G_TYPING, ALLELE_TYPING)["count"] == "6/6"


def test_xx_code_is_resolution_insufficient_at_allele_level_but_fine_at_antigen_level(ref):
    rec = {"A": ["A*02:XX", "A*24:02"], "B": ["B*44:02", "B*07:02"], "DRB1": ["DRB1*04:01", "DRB1*15:01"]}
    don = {"A": ["A*02:01", "A*24:02"], "B": ["B*44:02", "B*07:02"], "DRB1": ["DRB1*04:01", "DRB1*15:01"]}
    s8 = score(ref, "8/8", rec, don)
    assert s8["verdicts"]["A"] == "potential" and "resolution_insufficient" in s8["flags"]
    assert score(ref, "6/6", rec, don)["verdicts"]["A"] == "match"   # A*02 -> antigen A2 on both sides


def test_first_field_only_typing_is_potential_at_allele_level(ref):
    # the pre-existing trap this PR closes: 'A*02' vs 'A*02:01' used to be a confident mismatch
    rec = {"A": ["A*02", "A*24:02"], "B": ["B*44:02", "B*07:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*04:01", "DRB1*15:01"]}
    don = {"A": ["A*02:01", "A*24:02"], "B": ["B*44:02", "B*07:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*04:01", "DRB1*15:01"]}
    s = score(ref, "8/8", rec, don)
    assert s["verdicts"]["A"] == "potential" and s["count"] == "6/6" and "resolution_insufficient" in s["flags"]


def test_mac_code_in_typing_check_has_its_own_issue(ref, pf):
    out = lab.check_typing(ref, pf, {"A": ["A*02:AB", "A*24:XX"]})
    codes = [(i["code"], i["severity"]) for i in out["issues"]]
    assert ("mac_code", "error") in codes and ("unresolvable", "error") not in codes
    assert out["valid"] is False


def test_glstring_mac_code_issue(ref):
    out = lab.gl_string(ref, "HLA-A*02:AB+HLA-A*24:XX")
    assert [i["code"] for i in out["issues"]] == ["mac_code"]
    assert lab.gl_string(ref, "HLA-A*02:01g+HLA-A*24:02g")["valid"] is True


def test_allele_endpoint_group_and_prefixed_names(client):
    g = client.get("/v1/allele/A*02:01:01G").json()
    assert g["status"] == "group" and g["group_type"] == "G" and g["members_count"] > 100
    assert g["members_sample"][0].startswith("A*02:01")
    p = client.get("/v1/allele/DPB1*04:01P").json()
    assert p["status"] == "group" and p["group_type"] == "P"
    pre = client.get("/v1/allele/HLA-B*51:112").json()
    assert pre["status"] == "assigned" and pre["name"] == "HLA-B*51:112"


def test_allele_endpoint_accepts_reported_shorthands(client):
    """GET /v1/allele takes what /v1/normalize takes; a shorthand answers with the facts of the
    name it stands for, plus `resolves_to` and a flag so nothing is converted silently (#72)."""
    legacy = client.get("/v1/allele/A*0101").json()
    assert legacy["status"] == "valid_prefix" and legacy["name"] == "A*0101"
    assert legacy["resolves_to"] == "A*01:01" and legacy["flags"] == ["deprecated_name"]
    assert legacy["members_count"] > 100 and legacy["members_sample"][0].startswith("A*01:01")
    cw = client.get("/v1/allele/Cw*0702").json()
    assert cw["status"] == "valid_prefix" and cw["resolves_to"] == "C*07:02" and cw["flags"] == ["deprecated_name"]
    assert "ligands" in cw
    lg = client.get("/v1/allele/A*02:01g").json()
    assert lg["status"] == "valid_prefix" and lg["resolves_to"] == "A*02:01" and lg["flags"] == ["lg_notation"]
    xx = client.get("/v1/allele/HLA-A*02:XX").json()
    assert xx["status"] == "valid_prefix" and xx["name"] == "HLA-A*02:XX"
    assert xx["resolves_to"] == "A*02" and xx["flags"] == ["xx_code"]
    old_null = client.get("/v1/allele/A*0134N").json()   # legacy form of a deleted name: chased
    assert old_null["status"] == "deleted" and old_null["resolves_to"] == "A*01:34N"
    assert old_null["successor"] == "A*01:01:38L" and old_null["flags"] == ["deprecated_name"]
    mac = client.get("/v1/allele/A*02:AB").json()
    assert mac["status"] == "mac_code" and mac["flags"] == ["mac_code"] and "note" in mac
    assert "resolves_to" not in mac and "members_count" not in mac
    plain = client.get("/v1/allele/A*02:01").json()
    assert "flags" not in plain and "resolves_to" not in plain
    # a shorthand for a name that does not exist still 404s, and the message names both forms
    r = client.get("/v1/allele/A*99:XX")
    assert r.status_code == 404 and r.json()["detail"] == "'A*99:XX' stands for 'A*99', which is not assigned in release 3.65.0"
    r = client.get("/v1/allele/B*9999")
    assert r.status_code == 404 and "stands for 'B*99:99'" in r.json()["detail"]
    assert client.get("/v1/allele/A*02001").status_code == 404   # odd digit count: not a legacy name we can read


def test_ligands_for_class_i_group(ref, pf):
    lg = lab.ligands(ref, pf, "B*44:02:01G")
    assert lg["expressed"] is True and lg["bw"] == "Bw4"
