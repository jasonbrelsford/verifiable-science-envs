"""Harness smoke test: baselines run, oracle scores 100%, report renders."""
import json
from pathlib import Path

import pytest

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature import generate_suite, write_suite
from sci_envs.harness import models as M
from sci_envs.harness.run import run_model, load_suite
from sci_envs.harness.report import render


@pytest.fixture(scope="session")
def suite_dir(tmp_path_factory):
    ref = ImgtReference.load("v3.65.0-alpha")
    tasks, manifest = generate_suite(ref)
    d = tmp_path_factory.mktemp("suite")
    write_suite(tasks, manifest, d)
    return d, ref


def test_baselines_and_oracle(suite_dir):
    d, ref = suite_dir
    manifest, full = load_suite(d, "dev")
    assert len(full) == manifest["split"]["dev"]
    _, oracle = run_model(M.ReferenceOracle(full), full, ref, d, "dev", verbose=False)
    assert oracle["overall"]["acc"] == 1.0 and oracle["hallucination"]["tasks_with_hallucinated_names"] == 0
    _, naive = run_model(M.NaiveStringBaseline(), full, ref, d, "dev", verbose=False)
    assert 0.05 < naive["overall"]["acc"] < 0.6
    _, abst = run_model(M.CautiousAbstainer(), full, ref, d, "dev", verbose=False)
    assert abst["hallucination"]["tasks_with_hallucinated_names"] == 0
    assert abst["primary_failure_modes"].get("refused", 0) > 0
    out = render(d, d / "bench.md")
    text = out.read_text()
    assert "oracle-reference" in text and "baseline-naive-string" in text and "## By slice" in text


def test_resolve_specs():
    assert M.resolve("baseline-naive-string").name == "baseline-naive-string"
    with pytest.raises(ValueError):
        M.resolve("nonsense/model")
