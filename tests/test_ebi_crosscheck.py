"""The EBI cross-check script's pure parts: no network, no reference cache (#184)."""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    "ebi_crosscheck", pathlib.Path(__file__).resolve().parent.parent / "scripts" / "ebi_crosscheck.py")
x = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(x)


def _ebi_body(pat, don, result):
    def side(d):
        return {"HLA-B": [{"allele": a, "b_leader": l + " ", "comments": None} for a, l in d]}
    return {"HLA-B_leader": {"patient": {"patientid": "1", "gene": side(pat)},
                             "donors": [{"donorid": "2", "gene": side(don), "result": {"b_leader": result}}]}}


def test_ebi_query_builds_the_documented_url_and_strips_prefix_and_padding():
    seen = []

    def fetch(url):
        seen.append(url)
        return _ebi_body([("HLA-B*07:02", "M"), ("HLA-B*57:01", "T")], [("B*07:02", "M"), ("B*44:02", "T")], "Matched ")
    got = x.ebi_query(("B*07:02", "B*57:01"), ("B*07:02", "B*44:02"), fetch)
    assert seen == [f"{x.EBI_URL}?pid=1&patb1=07:02&patb2=57:01&did=2&donb1=07:02&donb2=44:02"]
    assert got == {"recipient": {"B*07:02": "M", "B*57:01": "T"}, "donor": {"B*07:02": "M", "B*44:02": "T"},
                   "result": "Matched"}


def _ours(rec_g, don_g, leader_match, alleles):
    return {"alleles": alleles, "recipient": rec_g, "donor": don_g, "leader_match": leader_match, "b_mismatches": 1}


def test_compare_agree_and_no_claim():
    rec, don = ("B*07:02", "B*57:01"), ("B*07:02", "B*44:02")
    ours = _ours("M/T", "M/T", True, {"B*07:02": "M", "B*57:01": "T", "B*44:02": "T"})
    ebi = {"recipient": {"B*07:02": "M", "B*57:01": "T"}, "donor": {"B*07:02": "M", "B*44:02": "T"}, "result": "Matched"}
    assert x.compare(ours, ebi, rec, don) == {"allele_leaders": "agree", "genotype_match": "agree", "leader_match": "agree"}
    ours["leader_match"] = None
    assert x.compare(ours, ebi, rec, don)["leader_match"] == "no_claim"


def test_compare_genotype_is_a_multiset_so_order_does_not_matter():
    ours = _ours("M/T", "T/M", None, {"B*07:02": "M", "B*44:02": "T"})
    ebi = {"recipient": {"B*07:02": "M", "B*44:02": "T"}, "donor": {"B*44:02": "T", "B*07:02": "M"}, "result": "Matched"}
    assert x.compare(ours, ebi, ("B*07:02", "B*44:02"), ("B*44:02", "B*07:02"))["genotype_match"] == "agree"


def test_compare_flags_every_kind_of_disagreement():
    rec, don = ("B*07:02", "B*57:01"), ("B*07:02", "B*08:01")
    ours = _ours("M/T", "M/M", False, {"B*07:02": "M", "B*57:01": "T", "B*08:01": "M"})
    ebi = {"recipient": {"B*07:02": "M", "B*57:01": "M"}, "donor": {"B*07:02": "M", "B*08:01": "M"}, "result": "Matched"}
    assert x.compare(ours, ebi, rec, don) == {
        "allele_leaders": "disagree", "genotype_match": "disagree", "leader_match": "disagree"}


def test_compare_no_genotype_claim_when_a_leader_is_not_resolved():
    ours = _ours("M/?", "M/T", None, {"B*07:02": "M", "B*99:99": None, "B*44:02": "T"})
    ebi = {"recipient": {}, "donor": {}, "result": "Mismatched"}
    assert x.compare(ours, ebi, ("B*07:02", "B*99:99"), ("B*07:02", "B*44:02"))["genotype_match"] == "no_claim"


def test_render_counts_disagreements_and_states_the_tce_gap():
    row = {"recipient": ["B*07:02", "B*57:01"], "donor": ["B*07:02", "B*44:02"],
           "ours": _ours("M/T", "M/T", True, {}), "ebi": {"result": "Matched"},
           "verdicts": {"allele_leaders": "agree", "genotype_match": "agree", "leader_match": "agree"}}
    text, bad = x.render("3.66.0", [row], "2026-11-20 20:00Z")
    assert bad == 0 and "No disagreements." in text and "DPB1 T-cell-epitope" in text
    row["verdicts"]["leader_match"] = "disagree"
    text, bad = x.render("3.66.0", [row], "2026-11-20 20:00Z")
    assert bad == 1 and "1 pair(s) disagree." in text


def test_pairs_are_fixed_distinct_and_well_formed():
    assert len(x.PAIRS) >= 20 and len(set(x.PAIRS)) == len(x.PAIRS)
    assert all(n.startswith("B*") for rec, don in x.PAIRS for n in rec + don)
