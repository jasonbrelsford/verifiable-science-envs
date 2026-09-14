"""Lab Toolkit tests (docs/LAB-TOOLKIT-SPEC.md). Offline once the reference
cache is warm (~/.cache/sci_envs/imgt)."""
import pytest
from fastapi.testclient import TestClient

from sci_envs.reference.imgt import ImgtReference
from sci_envs.service import lab
from sci_envs.service.app import app, ref as app_ref

client = TestClient(app)
REF = app_ref()
PF = lab.get_protein_facts(REF)


# --------------------------------------------------------------------- §2 ligands

@pytest.mark.parametrize("name,expected", [
    ("B*07:02", {"expressed": True, "leader_21": "M", "residue_80": "N", "bw": "Bw6",
                 "c_group": None, "kir_ligand": "none"}),
    ("B*57:01", {"expressed": True, "leader_21": "T", "residue_80": "I", "bw": "Bw4",
                 "c_group": None, "kir_ligand": "Bw4-80I"}),
    ("B*27:05", {"expressed": True, "leader_21": "T", "residue_80": "T", "bw": "Bw4",
                 "c_group": None, "kir_ligand": "Bw4-80T"}),
    ("A*24:02", {"expressed": True, "leader_21": "M", "residue_80": "I", "bw": "Bw4",
                 "c_group": None, "kir_ligand": "Bw4-80I"}),
    ("C*01:02", {"expressed": True, "leader_21": "M", "residue_80": "N", "bw": None,
                 "c_group": "C1", "kir_ligand": "C1"}),
    ("C*06:02", {"expressed": True, "leader_21": "M", "residue_80": "K", "bw": None,
                 "c_group": "C2", "kir_ligand": "C2"}),
])
def test_ligands_validated_values(name, expected):
    assert lab.ligands(REF, PF, name) == expected


def test_ligands_b4601_is_c1():
    """B*46:01: V76 + N80 -> C1 (the atypical B-locus C1 case, per protein.py §1)."""
    d = lab.ligands(REF, PF, "B*46:01")
    assert d["c_group"] == "C1" and d["kir_ligand"] == "C1"


def test_ligands_null_allele():
    d = lab.ligands(REF, PF, "A*24:09N")
    assert d == {"expressed": False, "leader_21": "not_expressed", "residue_80": "not_expressed",
                 "bw": "not_expressed", "c_group": None, "kir_ligand": "none"}


def test_ligands_non_class_i_is_none():
    assert lab.ligands(REF, PF, "DRB1*15:01") is None


def test_ligands_ambiguous_leader_21():
    """No true 2-field name in release 3.65.0 has ambiguous leader_21 (a 2-field
    name's full-resolution members are protein-identical by nomenclature
    convention; confirmed by exhaustive search over every A/B/C 2-field name).
    B*07 (a 1-field prefix, mixing several distinct 2-field groups) exercises the
    identical aggregation/ambiguity code path and is ambiguous at every key."""
    d = lab.ligands(REF, PF, "B*07")
    assert d["leader_21"] == "ambiguous"
    assert "leader_21" in d["ambiguities"]
    assert d["ambiguities"]["leader_21"] == sorted(d["ambiguities"]["leader_21"])
    assert list(d["ambiguities"].keys()) == [
        k for k in ("leader_21", "residue_80", "bw", "c_group", "kir_ligand") if k in d["ambiguities"]
    ]


def test_ligands_no_members_is_none():
    assert lab.ligands(REF, PF, "A*99:99") is None


# --------------------------------------------------------------------- §2a /v1/allele

def test_allele_endpoint_gains_ligands():
    d = client.get("/v1/allele/A*24:02").json()
    assert d["status"] in ("assigned", "valid_prefix")
    assert list(d.keys())[-1] == "ligands"
    assert d["ligands"]["kir_ligand"] == "Bw4-80I"


def test_allele_endpoint_no_ligands_for_non_class_i():
    d = client.get("/v1/allele/DRB1*15:01").json()
    assert "ligands" not in d


# --------------------------------------------------------------- §3 typing/check

def test_check_typing_every_locus_string_issue():
    typing = {"A": ["A*99:99", "A*0101", "A*02:01"], "B": ["B*07:02"],
              "C": ["C*01:02", "C*01:02"]}
    d = lab.check_typing(REF, PF, typing)
    codes = [i["code"] for i in d["issues"]]
    assert codes == ["unresolvable", "deprecated_name", "too_many_alleles",
                      "single_allele", "homozygous"]
    assert d["counts"] == {"error": 1, "warning": 2, "info": 2}
    assert d["valid"] is False
    a_issues = {i["code"]: i for i in d["issues"] if i["locus"] == "A"}
    assert a_issues["unresolvable"]["detail"] == f"'A*99:99' is not a name in release {REF.release}"
    assert a_issues["deprecated_name"]["detail"] == "'A*0101' is an outdated name; current name is A*01:01"
    assert a_issues["too_many_alleles"]["detail"] == "3 alleles listed; a genotype has at most 2 per locus"
    single = next(i for i in d["issues"] if i["code"] == "single_allele")
    assert single["locus"] == "B" and single["detail"] == "one allele listed: homozygous or incomplete typing"
    homo = next(i for i in d["issues"] if i["code"] == "homozygous")
    assert homo["locus"] == "C" and homo["detail"] == "both alleles are C*01:02"


def test_check_typing_locus_mismatch_and_null_allele():
    d = lab.check_typing(REF, PF, {"A": ["B*07:02", "A*24:09N"]})
    codes = [i["code"] for i in d["issues"]]
    assert codes == ["locus_mismatch", "null_allele"]
    assert d["issues"][0]["detail"] == "B*07:02 is a B allele listed under A"
    assert d["issues"][1]["detail"] == "A*24:09N is a null allele (not expressed)"
    row = d["loci"]["A"][1]
    assert row["flags"] == ["null_allele"] and row["ligands"]["expressed"] is False


def test_check_typing_row_shape_and_antigen():
    d = lab.check_typing(REF, PF, {"B": ["B*07:02"]})
    row = d["loci"]["B"][0]
    assert list(row.keys()) == ["reported", "status", "current_name", "allele_2field",
                                 "g_group", "flags", "antigen", "ligands"]
    assert row["status"] == "ok" and row["antigen"] == "0702"


def test_check_typing_null_antigen_sentinel():
    d = lab.check_typing(REF, PF, {"A": ["A*24:09N"]})
    assert d["loci"]["A"][0]["antigen"] == "null"


# ---------------------------------------------------------------------- §3a profile

def test_profile_b_leader_and_kir_complete():
    typing = {"A": ["A*02:01", "A*24:02"], "B": ["B*57:01", "B*07:02"], "C": ["C*01:02", "C*06:02"]}
    d = lab.check_typing(REF, PF, typing)
    p = d["profile"]
    assert p["b_leader_genotype"] == "M/T"
    assert p["c_kir_ligand_genotype"] == "C1/C2"
    assert p["kir_ligands_present"] == ["Bw4-80I", "C1", "C2"]
    assert p["kir_ligand_status"] == "complete"


def test_profile_incomplete_when_locus_missing():
    d = lab.check_typing(REF, PF, {"A": ["A*02:01", "A*24:02"], "B": ["B*57:01", "B*07:02"]})
    assert d["profile"]["kir_ligand_status"] == "incomplete"
    assert d["profile"]["c_kir_ligand_genotype"] is None


# ------------------------------------------------------------------------- §3b drb345

def test_drb345_unexpected_and_not_reported():
    typing = {"DRB1": ["DRB1*15:01", "DRB1*16:01"], "DRB3": ["DRB3*01:01"]}
    d = lab.check_typing(REF, PF, typing)
    assert d["drb345"] == {"expected": ["DRB5"], "reported": ["DRB3"], "determinate": True}
    codes = {(i["code"], i["locus"]) for i in d["issues"] if i["code"].startswith("drb345")}
    assert codes == {("drb345_unexpected", "DRB3"), ("drb345_not_reported", "DRB5")}
    unexpected = next(i for i in d["issues"] if i["code"] == "drb345_unexpected")
    assert unexpected["detail"] == "DRB3 reported but neither DRB1 allele is normally carried with DRB3"
    not_reported = next(i for i in d["issues"] if i["code"] == "drb345_not_reported")
    assert not_reported["detail"] == "DRB5 is normally carried with DRB1*15:01, DRB1*16:01 but was not reported"


def test_drb345_absent_without_drb1_key():
    d = lab.check_typing(REF, PF, {"A": ["A*02:01"]})
    assert d["drb345"] is None


def test_drb345_indeterminate_no_unexpected_issue():
    # Only 1 DRB1 row -> determinate is False -> drb345_unexpected must not fire
    # even if an "unexpected" locus is also reported.
    typing = {"DRB1": ["DRB1*15:01"], "DRB3": ["DRB3*01:01"]}
    d = lab.check_typing(REF, PF, typing)
    assert d["drb345"]["determinate"] is False
    assert all(i["code"] != "drb345_unexpected" for i in d["issues"])


# ------------------------------------------------------------------------------ §4 compat

def test_compat_petersdorf_leader_matched_true():
    rec = {"B": ["B*07:02", "B*57:01"]}
    don = {"B": ["B*07:02", "B*44:02"]}
    c = lab.compat(REF, PF, rec, don)
    assert c["b_leader"]["b_mismatches"] == 1
    assert c["b_leader"]["leader_match"] is True


def test_compat_petersdorf_leader_matched_false():
    rec = {"B": ["B*07:02", "B*57:01"]}
    don = {"B": ["B*07:02", "B*08:01"]}
    c = lab.compat(REF, PF, rec, don)
    assert c["b_leader"]["b_mismatches"] == 1
    assert c["b_leader"]["leader_match"] is False


def test_compat_leader_match_null_when_not_single_mismatch():
    rec = {"B": ["B*07:02", "B*57:01"]}
    don = {"B": ["B*44:02", "B*08:01"]}  # 2 mismatches
    c = lab.compat(REF, PF, rec, don)
    assert c["b_leader"]["b_mismatches"] == 2
    assert c["b_leader"]["leader_match"] is None


def test_compat_kir_ligands_and_status():
    typing = {"A": ["A*02:01", "A*24:02"], "B": ["B*57:01", "B*07:02"], "C": ["C*01:02", "C*06:02"]}
    c = lab.compat(REF, PF, typing, typing)
    assert c["kir_ligands"]["recipient"] == ["Bw4", "C1", "C2"]
    assert c["kir_ligands"]["donor"] == ["Bw4", "C1", "C2"]
    assert c["kir_ligands"]["missing_in_recipient"] == []
    assert c["kir_ligands"]["missing_in_donor"] == []
    assert c["kir_ligands"]["status"] == "complete"
    assert c["recipient_valid"] is True and c["donor_valid"] is True
    assert c["kir_ligands"]["rule"] == lab.KIR_RULE
    assert c["b_leader"]["rule"] == lab.PETERSDORF_RULE
    assert list(c.keys()) == ["release", "b_leader", "kir_ligands", "recipient_valid",
                               "donor_valid", "issues", "attribution"]


def test_compat_kir_missing_direction():
    rec = {"A": ["A*24:02"], "B": ["B*57:01"], "C": ["C*01:02"]}
    don = {"A": ["A*01:01"], "B": ["B*07:02"], "C": ["C*06:02"]}
    c = lab.compat(REF, PF, rec, don)
    assert c["kir_ligands"]["recipient"] == ["Bw4", "C1"]
    assert c["kir_ligands"]["donor"] == ["C2"]
    assert c["kir_ligands"]["missing_in_recipient"] == ["C2"]
    assert c["kir_ligands"]["missing_in_donor"] == ["Bw4", "C1"]


# ------------------------------------------------------------------------------- §5 glstring

@pytest.mark.parametrize("gl,code,detail", [
    ("A*01:01//A*02:01", "empty_element", "empty element in 'A*01:01//A*02:01'"),
    ("A*01 01", "whitespace_in_name", "'A*01 01' contains whitespace"),
    ("A*99:99", "unresolvable_allele", f"'A*99:99' is not a name in release {'3.65.0'}"),
    ("A*01:01/B*07:02", "mixed_locus_allele_list", "'A*01:01/B*07:02' mixes loci A, B"),
    ("A*01:01~A*02:01", "haplotype_repeats_locus", "'A*01:01~A*02:01' repeats locus A"),
    ("A*01:01+A*02:01+A*03:01", "more_than_two_haplotypes", "'A*01:01+A*02:01+A*03:01' has 3 haplotypes"),
    ("A*01:01+B*07:02", "genotype_loci_differ", "'A*01:01+B*07:02' pairs different loci"),
    ("A*01:01|B*07:02", "genotype_list_loci_differ", "'A*01:01|B*07:02' lists genotypes over different loci"),
    ("A*01:01^A*02:01", "locus_repeated_across_blocks", "locus A appears in more than one ^ block"),
])
def test_glstring_every_structure_issue(gl, code, detail):
    d = lab.gl_string(REF, gl)
    codes = [i["code"] for i in d["issues"]]
    assert code in codes
    found = next(i for i in d["issues"] if i["code"] == code)
    assert found["detail"] == detail


def test_glstring_whitespace_also_unresolvable():
    d = lab.gl_string(REF, "A*01 01")
    codes = [i["code"] for i in d["issues"]]
    assert codes == ["whitespace_in_name", "unresolvable_allele"]


def test_glstring_renamed_allele_and_normalized():
    """A legacy (pre-2010, colon-less) name is renamed in normalized_gl."""
    d = lab.gl_string(REF, "A*0101")
    assert d["valid"] is True
    assert d["issues"] == [{"severity": "warning", "code": "renamed_allele",
                             "detail": "'A*0101' is outdated; current name is A*01:01"}]
    assert d["normalized_gl"] == "A*01:01"
    assert d["changed"] is True


def test_glstring_hla_prefix_preserved_on_rename():
    d = lab.gl_string(REF, "HLA-A*0101")
    assert d["normalized_gl"] == "HLA-A*01:01"


def test_glstring_group_name():
    d = lab.gl_string(REF, "DQB1*05:03:01G")
    row = d["alleles"][0]
    assert row == {"token": "DQB1*05:03:01G", "status": "group",
                    "current_name": "DQB1*05:03:01G", "locus": "DQB1"}
    assert d["valid"] is True and d["issues"] == []


def test_glstring_valid_haplotype_round_trip():
    gl = "A*01:01~B*08:01~C*07:01+A*02:01~B*07:02~C*07:02"
    d = lab.gl_string(REF, gl)
    assert d["valid"] is True
    assert d["normalized_gl"] == gl
    assert d["changed"] is False
    assert d["loci"] == ["A", "B", "C"]


def test_glstring_alleles_first_appearance_dedup():
    d = lab.gl_string(REF, "A*01:01+A*01:01")
    assert len(d["alleles"]) == 1
    assert d["alleles"][0]["token"] == "A*01:01"
    # but the issue-free token still produces no issues twice (nothing to emit for 'valid')
    assert d["issues"] == []


def test_glstring_empty_token_not_added_to_alleles():
    d = lab.gl_string(REF, "A*01:01//A*02:01")
    tokens = [a["token"] for a in d["alleles"]]
    assert "" not in tokens
    assert tokens == ["A*01:01", "A*02:01"]


def test_glstring_422_not_a_string():
    with pytest.raises(ValueError, match="gl must be a non-empty string"):
        lab.gl_string(REF, 12345)


def test_glstring_422_empty():
    with pytest.raises(ValueError, match="gl must be a non-empty string"):
        lab.gl_string(REF, "   ")


def test_glstring_422_too_long():
    with pytest.raises(ValueError, match="gl must be at most 100000 characters"):
        lab.gl_string(REF, "A" * 100_001)


def test_glstring_422_too_many_alleles():
    gl = "+".join(["A*01:01"] * 5001)
    with pytest.raises(ValueError, match="gl must contain at most 5000 alleles"):
        lab.gl_string(REF, gl)


# -------------------------------------------------------------------- validate_typing / 422s

def test_validate_typing_matches_edge_messages():
    assert lab.validate_typing("nope", "typing") == "typing must be an object mapping locus -> [reported alleles]"
    assert lab.validate_typing([], "typing") == "typing must be an object mapping locus -> [reported alleles]"
    assert lab.validate_typing({f"L{i}": [] for i in range(25)}, "typing") == "typing: at most 24 loci"
    assert (lab.validate_typing({"A": ["x"] * 5}, "typing")
            == "typing.A must be a list of up to 4 reported allele strings")
    assert (lab.validate_typing({"A": ["x" * 65]}, "typing")
            == "typing.A must be a list of up to 4 reported allele strings")
    assert lab.validate_typing({"A": ["A*01:01"]}, "typing") is None


def test_http_typing_check_422():
    r = client.post("/v1/typing/check", json={"typing": "nope"})
    assert r.status_code == 422
    assert r.json() == {"detail": "typing must be an object mapping locus -> [reported alleles]"}


def test_http_typing_check_ok():
    r = client.post("/v1/typing/check", json={"typing": {"A": ["A*02:01", "A*24:02"]}})
    assert r.status_code == 200
    d = r.json()
    assert d["valid"] is True and d["profile"]["b_leader_genotype"] is None


def test_http_compat_422_recipient_and_donor():
    r = client.post("/v1/compat", json={"recipient": {}, "donor": "bad"})
    assert r.status_code == 422
    assert r.json() == {"detail": "donor must be an object mapping locus -> [reported alleles]"}


def test_http_compat_ok():
    body = {"recipient": {"B": ["B*07:02", "B*57:01"]}, "donor": {"B": ["B*07:02", "B*44:02"]}}
    r = client.post("/v1/compat", json=body)
    assert r.status_code == 200
    assert r.json()["b_leader"]["leader_match"] is True


def test_http_glstring_422():
    r = client.post("/v1/glstring", json={"gl": ""})
    assert r.status_code == 422
    assert r.json() == {"detail": "gl must be a non-empty string"}


def test_http_glstring_ok():
    r = client.post("/v1/glstring", json={"gl": "A*01:01+A*02:01"})
    assert r.status_code == 200
    d = r.json()
    assert d["valid"] is True and d["loci"] == ["A"]


def test_mcp_donor_compat_description_mentions_decision_support():
    from sci_envs import mcp_server
    tools = mcp_server.mcp._tool_manager.list_tools()
    donor_compat = next(t for t in tools if t.name == "donor_compat")
    assert "decision support only; not a medical device" in donor_compat.description.lower()
    for name in ("check_typing", "donor_compat", "validate_gl_string"):
        assert any(t.name == name for t in tools)
