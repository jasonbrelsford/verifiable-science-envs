"""The Harbor task's reference solution must pass its own verifier on the committed data."""
import csv, subprocess, sys
from pathlib import Path

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize, legacy_to_colon

TASK = Path(__file__).resolve().parents[1] / "harbor" / "hla-typing-report-normalize"


def test_normalize_rules():
    ref = ImgtReference.load("v3.65.0-alpha")
    assert legacy_to_colon("Cw*0702") == "C*07:02" and legacy_to_colon("A*020101") == "A*02:01:01"
    assert normalize(ref, "A*0101") == {"allele_2field": "A*01:01", "g_group": "AMBIGUOUS", "flags": "deprecated_name"}
    assert normalize(ref, "A*01:01:01:02N") == {"allele_2field": "A*01:01", "g_group": "A*01:01:01G", "flags": "null_allele"}
    assert normalize(ref, "A*0105N")["flags"] == "deprecated_name;null_allele"
    assert normalize(ref, "A*99:999") == {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": "nonexistent_allele"}


def test_expected_matches_rules_and_solution_passes_verifier(tmp_path):
    ref = ImgtReference.load("v3.65.0-alpha")
    rows = list(csv.DictReader(open(TASK / "environment/data/typing_reports.csv", newline="")))
    exp = list(csv.DictReader(open(TASK / "tests/expected.csv", newline="")))
    assert len(rows) == len(exp) == 200
    for r, e in zip(rows, exp):
        n = normalize(ref, r["typing_as_reported"])
        assert {k: e[k] for k in n} == n, r
    # vendored solution files are byte-identical to the package versions (modulo the import rewrite)
    assert (TASK / "solution/imgt.py").read_text() == Path("sci_envs/reference/imgt.py").read_text()
    vend = (TASK / "solution/normalize.py").read_text().replace("from imgt import", "from sci_envs.reference.imgt import")
    assert vend == Path("sci_envs/families/nomenclature/normalize.py").read_text()
