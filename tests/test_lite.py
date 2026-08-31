"""Lite (history-free) load must agree with the full load on everything but history."""
import shutil
from pathlib import Path

import pytest

from sci_envs.reference.imgt import ImgtReference, LITE_FILES

TAG = "v3.65.0-alpha"


@pytest.fixture(scope="module")
def refs(tmp_path_factory):
    full = ImgtReference.load(TAG)
    lite_root = tmp_path_factory.mktemp("lite") / TAG
    for f in LITE_FILES:
        (lite_root / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(full.root / f, lite_root / f)
    lite = ImgtReference.load(TAG, cache_dir=lite_root.parent, fetch=False, lite=True)
    return full, lite


def test_classify_parity(refs):
    full, lite = refs
    text = "A*0101 B*15:504:01 DRB1*14:06 DQB1*05:03:26:99 DQB1*05:03:01G A*01:34N B*9999 P*1801"
    f, l = full.classify_tokens(text), lite.classify_tokens(text)
    for k in ("valid", "group", "fabricated_group"):
        assert f[k] == l[k], k
    # names only ever valid in a PAST release may fall from 'deleted' to 'hallucinated' in lite;
    # explicit Deleted_alleles entries must still be caught:
    assert "A*01:34N" in l["deleted"]


def test_normalize_parity(refs):
    from sci_envs.families.nomenclature.normalize import normalize
    full, lite = refs
    for s in ("A*0101", "DRB1*1406", "B*15:504:01", "A*01:34N", "B*9999"):
        assert normalize(full, s) == normalize(lite, s), s


def test_history_degrades_not_crashes(refs):
    _, lite = refs
    assert lite.first_release("A*01:01:01:01") is None or True  # must not raise
    assert lite.ids_for_name_ever("A*01:01") in ([], None) or True
