"""The release-history export (sci_envs/service/history_export.py) against the engine.

The edge Worker answers /v1/translate, /v1/releases/diff and /v1/allele/{name}/history
from these files alone, so every name they give for an HLA ID in a release must be the
one ImgtReference.name_at() reads from Allelelist_history.txt. Checked for a fixed
sample of IDs across every release, plus the whole of HLA00001.
"""
import json
import random

import pytest

from sci_envs.reference import ImgtReference
from sci_envs.service.history_export import export, runs

TAG = "v3.66.0-alpha"


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    ref = ImgtReference.load(TAG)
    out = tmp_path_factory.mktemp("edge")
    summary = export(ref, out)
    return ref, out / "history", summary


def name_at(rec, i):
    for a, b, nm in rec["t"]:
        if a <= i <= b:
            return nm
    return None


def test_runs_collapse_consecutive_releases():
    assert runs(["A*0101", "A*0101", None, "A*01011", "A*01011", "A*0101"]) == [
        [0, 1, "A*0101"], [3, 4, "A*01011"], [5, 5, "A*0101"]]
    assert runs([None, None]) == []


def test_every_id_and_release_is_covered(built):
    ref, base, summary = built
    meta = json.loads((base / "releases.json").read_text())
    assert meta["releases"] == list(reversed(ref.releases))
    assert meta["latest"] == ref.release == meta["releases"][-1]
    assert summary["ids"] == len(ref._history[1])
    assert summary["skipped"] == 0


def test_names_match_the_engine_for_a_sample_of_ids(built):
    ref, base, _ = built
    meta = json.loads((base / "releases.json").read_text())
    files = {p.stem: json.loads(p.read_text()) for p in (base / "ids").glob("*.json")}
    ids = {hid: rec for recs in files.values() for hid, rec in recs.items()}
    sample = random.Random(2026).sample(sorted(ids), 300) + ["HLA00001"]
    for hid in sample:
        for i, rel in enumerate(meta["releases"]):
            assert name_at(ids[hid], i) == ref.name_at(hid, rel), (hid, rel)


def test_name_index_points_at_every_id_that_carried_the_name(built):
    ref, base, _ = built
    index = {}
    for p in (base / "names").rglob("*.json"):
        index.update(json.loads(p.read_text()))
    for name in ["A*0101", "A*01:01:01:01", "A*24:02:03", "C*12:139", "DRB1*15:01:01:01"]:
        assert {hid for hid, _ in index[name]} == ref.ids_for_name_ever(name), name


def test_deletions_are_kept_per_name(built):
    _, base, _ = built
    a = json.loads((base / "ids" / "A.json").read_text())
    assert a["HLA01616"]["d"]["A*24:02:03"]["successor"] == "A*24:02:03Q"
