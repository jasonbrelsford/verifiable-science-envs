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


def test_ligands_for_class_i_group(ref, pf):
    lg = lab.ligands(ref, pf, "B*44:02:01G")
    assert lg["expressed"] is True and lg["bw"] == "Bw4"


# --- KIR names in free text (issue #71): out of scope, never a fabricated HLA name ----

def test_token_grammar_never_starts_inside_a_word(ref):
    from sci_envs.reference.imgt import ALLELE_TOKEN_RE, MAC_TOKEN_RE
    assert ALLELE_TOKEN_RE.findall("HLA-DRB1*04:01, KIR3DL1*001 KIR2DL1*0010101") == ["HLA-DRB1*04:01"]
    assert ALLELE_TOKEN_RE.findall("xA*02:01 1B*07:02 (A*24:02) HLA-A*02:01") == ["A*24:02", "HLA-A*02:01"]
    assert MAC_TOKEN_RE.findall("KIR2DL1*AB and A*02:AB") == ["A*02:AB"]


def test_classify_tokens_reports_kir_as_out_of_scope(ref):
    c = ref.classify_tokens("HLA-DRB1*04:01, KIR3DL1*001, KIR2DL1*0010101, 2DL5A*001, KIR3DP1*003:01; DQB1*99:99")
    assert c["out_of_scope"] == ["2DL5A*001", "KIR2DL1*0010101", "KIR3DL1*001", "KIR3DP1*003:01"]
    assert c["valid"] == ["DRB1*04:01"]
    assert c["hallucinated"] == ["DQB1*99:99"]
    assert all("DL1*001" not in v for v in c.values())


def test_verify_endpoint_mixed_hla_kir_report_is_clean(client):
    r = client.post("/v1/verify", json={"text": "HLA-DRB1*04:01, KIR3DL1*001"}).json()
    by = {t["token"]: t for t in r["tokens"]}
    assert set(by) == {"DRB1*04:01", "KIR3DL1*001"}
    assert by["DRB1*04:01"]["status"] == "valid"
    assert by["KIR3DL1*001"]["status"] == "out_of_scope" and "KIR" in by["KIR3DL1*001"]["note"]
    assert r["counts"]["hallucinated"] == 0 and r["counts"]["out_of_scope"] == 1
    assert r["clean"] is True
    # a fabricated HLA name next to KIR typing still fails the guardrail
    bad = client.post("/v1/verify", json={"text": "DQB1*99:99 with KIR2DL1*001"}).json()
    assert bad["clean"] is False and bad["counts"]["out_of_scope"] == 1
