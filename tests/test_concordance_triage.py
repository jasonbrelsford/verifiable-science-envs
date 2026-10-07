"""The py-ard concordance script's triage classifier, without py-ard or the
reference database: every divergence the report lists must land in a known
semantic family, and anything new must surface as UNTRIAGED rather than vanish."""
import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "pyard_concordance", Path(__file__).resolve().parent.parent / "scripts" / "pyard_concordance.py")
pc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(pc)

# The 14 divergences reported on py-ard 2.4.0, 2.4.1 and 2.4.2 (db 3650),
# IPD-IMGT/HLA 3.65.0 — docs/pyard-concordance.md.
Q_CASES = [
    ("C*02:02:02:74Q", "C*02:02", "C*02:02Q"),
    ("C*12:03:01:77Q", "C*12:03", "C*12:03Q"),
    ("C*12:02:02:26Q", "C*12:02", "C*12:02Q"),
    ("B*38:01:01:03Q", "B*38:01", "B*38:01Q"),
    ("C*05:01:01:81Q", "C*05:01", "C*05:01Q"),
    ("B*51:01:01:97Q", "B*51:01", "B*51:01Q"),
    ("C*16:01:01:42Q", "C*16:01", "C*16:01Q"),
]
ROLLUP_CASES = [
    ("C*12:436", "C*12:436", "C*12:03"),
    ("C*06:110", "C*06:110", "C*06:02"),
    ("B*49:38", "B*49:38", "B*49:01"),
    ("DQB1*06:258", "DQB1*06:258", "DQB1*06:01"),
    ("B*13:224", "B*13:224", "B*13:01"),
    ("C*03:669", "C*03:669", "C*03:04"),
    ("C*02:225", "C*02:225", "C*02:35"),
]
UNTRIAGED_CASES = [
    ("A*02:01:01:01", "A*02:01", "A*02:01N"),      # suffix the input never carried
    ("A*02:01:01:01", "A*02:01", "B*02:01"),       # locus changed
    ("A*02:01:01:01", "A*02:01", "<InvalidAlleleError>"),  # py-ard rejects a valid name
    ("A*02:01:08", "A*02:1040", "A*02:01"),        # we resolved a successor, py-ard did not
    ("A*02:01:01:01", "A*02:01", "A*02:01:01G"),   # wrong resolution
]


@pytest.mark.parametrize("allele,ours,pyard", Q_CASES)
def test_q_suffix_family(allele, ours, pyard):
    assert pc.triage(allele, ours, pyard) == pc.Q_SUFFIX


@pytest.mark.parametrize("allele,ours,pyard", ROLLUP_CASES)
def test_ard_rollup_family(allele, ours, pyard):
    assert pc.triage(allele, ours, pyard) == pc.ARD_ROLLUP


@pytest.mark.parametrize("allele,ours,pyard", UNTRIAGED_CASES)
def test_unknown_shape_is_untriaged(allele, ours, pyard):
    assert pc.triage(allele, ours, pyard) == pc.UNTRIAGED


def test_two_field():
    assert pc.two_field("C*02:02:02:74Q") == "C*02:02"
    assert pc.two_field("C*12:436") == "C*12:436"
    assert pc.two_field("A*01:01:01:01N") == "A*01:01"


def test_report_section_counts_families_and_names_every_case():
    diffs = Q_CASES + ROLLUP_CASES
    text = "\n".join(pc.triage_lines(diffs, len(diffs)))
    assert "## 3. Triage of the 14 divergences" in text
    assert "UNTRIAGED" not in text
    assert "(7 cases:" in text
    for a, _, _ in diffs:
        assert f"`{a}`" in text


def test_report_section_shouts_about_untriaged():
    diffs = Q_CASES[:1] + UNTRIAGED_CASES[:1]
    text = "\n".join(pc.triage_lines(diffs, 2))
    assert "1 UNTRIAGED divergence(s)" in text
    assert "`A*02:01:01:01`: ours `A*02:01`, py-ard `A*02:01N`" in text
    assert "a human must decide" in text


def test_report_section_with_no_divergences():
    assert "Nothing to triage" in "\n".join(pc.triage_lines([], 0))


def test_notable_rows_from_section_two():
    rows = [
        ("fabricated", "DQB1*05:03:26:99", "UNRESOLVABLE", "DQB1*05:03"),
        ("fabricated", "B*9999", "UNRESOLVABLE", "<InvalidAlleleError>"),
        ("deleted-with-successor", "A*02:01:08", "A*02:1040", "A*02:01"),
        ("deleted-with-successor", "A*0105N", "A*01:04N", "A*01:04N"),
    ]
    text = "\n".join(pc.notable_lines(rows))
    assert "fabricated `DQB1*05:03:26:99` reduces to `DQB1*05:03`" in text
    assert "B*9999" not in text
    assert "deleted `A*02:01:08` reduces to `A*02:01`; the database's successor is `A*02:1040`" in text
    assert "A*0105N" not in text
    assert pc.notable_lines([]) == []
