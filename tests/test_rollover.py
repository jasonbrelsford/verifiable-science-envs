"""Pre-2010 rollover names (A*9201, B*9501, DPB1*0102) resolve through the official 2010
old-to-new mapping — the same HLA ID's names in Allelelist_history.txt, the file
/v1/translate answers from — not by splitting their digits into pairs (A*92:01 does not
exist). Ordinary legacy names keep the mechanical colon form. The Worker reads the same
answers from the exported rows (edge/test/rollover.test.mjs)."""
import pytest
from fastapi.testclient import TestClient

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize, resolve_name, legacy_to_colon
from sci_envs.service.app import app

TAG = "v3.66.0-alpha"

ROLLOVERS = [
    # legacy,     2010 colon name, current name,     allele_2field
    ("A*9201",    "A*02:101",      "A*02:101",       "A*02:101"),
    ("B*9501",    "B*15:101",      "B*15:101",       "B*15:101"),
    ("DPB1*0102", "DPB1*100:01",   "DPB1*100:01",    "DPB1*100:01"),
]


@pytest.fixture(scope="module")
def ref():
    return ImgtReference.load(TAG)


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


@pytest.mark.parametrize("legacy,colon,current,two", ROLLOVERS)
def test_rollover_follows_the_2010_mapping(ref, legacy, colon, current, two):
    assert legacy_to_colon(legacy) != colon            # the mechanical form is the wrong allele
    assert ref.rollover_of(legacy) == colon
    # the mapping is the history file's own pairing of the two names under one HLA ID
    ids = ref.ids_for_name_ever(legacy)
    assert len(ids) == 1
    (hid,) = ids
    assert colon in {n for n in ref.history(hid).values() if n} or \
        any(n and n.startswith(colon + ":") for n in ref.history(hid).values())
    name, flags = resolve_name(ref, legacy)
    assert name == current and flags == {"deprecated_name", "legacy_rollover"}
    n = normalize(ref, legacy)
    assert n["allele_2field"] == two and "UNRESOLVABLE" not in n.values()
    assert n["flags"] == "deprecated_name;legacy_rollover"


def test_ordinary_legacy_name_stays_mechanical(ref):
    assert ref.rollover_of("A*0101") is None
    assert resolve_name(ref, "A*0101") == ("A*01:01", {"deprecated_name"})
    assert normalize(ref, "A*0101")["allele_2field"] == "A*01:01"


def test_modern_and_nonsense_names_unchanged(ref):
    assert ref.rollover_of("A*02:101") is None
    assert resolve_name(ref, "A*02:101") == ("A*02:101", set())
    assert normalize(ref, "A*02:101")["flags"] == ""
    for bad in ("A*9999", "A*99:99", "notanallele"):
        assert ref.rollover_of(bad) is None
        assert normalize(ref, bad)["allele_2field"] == "UNRESOLVABLE"


def test_rollover_table_is_exact(ref):
    roll = ref._rollovers
    assert roll and all(legacy_to_colon(k) != v for k, v in roll.items())
    assert "A*0101" not in roll and "Cw*0702" not in roll


def test_rest_normalize(client):
    typings = ["A*9201", "B*9501", "DPB1*0102", "HLA-A*9201", "A*0101", "A*02:01:01:01", "A*9999"]
    rows = {r["reported"]: r for r in client.post("/v1/normalize", json={"typings": typings}).json()["rows"]}
    for legacy, _, current, two in ROLLOVERS:
        r = rows[legacy]
        assert (r["current_name"], r["allele_2field"]) == (current, two), r
        assert r["flags"] == ["deprecated_name", "legacy_rollover"]
    assert rows["HLA-A*9201"]["current_name"] == "A*02:101"
    assert rows["A*0101"]["current_name"] == "A*01:01" and rows["A*0101"]["flags"] == ["deprecated_name"]
    assert rows["A*02:01:01:01"]["current_name"] == "A*02:01:01:01" and rows["A*02:01:01:01"]["flags"] == []
    assert rows["A*9999"]["current_name"] == "UNRESOLVABLE" and rows["A*9999"]["allele_2field"] == "UNRESOLVABLE"


def test_rest_normalize_agrees_with_translate_names(ref):
    """normalize and the release history give one answer: the rollover's current name is
    what its HLA ID is called in the pinned release (or a prefix of it)."""
    latest = ref.release
    for legacy, _, current, _ in ROLLOVERS:
        (hid,) = ref.ids_for_name_ever(legacy)
        now = ref.name_at(hid, latest)
        assert now == current or now.startswith(current + ":"), (legacy, now)
