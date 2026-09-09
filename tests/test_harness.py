"""Harness smoke test: baselines run, oracle scores 100%, report renders."""
import json
from pathlib import Path

import pytest

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature import generate_suite, write_suite
from sci_envs.harness import models as M
from sci_envs.harness.run import run_model, load_suite, cache_usable
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


def test_cache_usable_rejects_backend_failures():
    assert cache_usable('{"answer": "A*01:01"}')
    assert not cache_usable("")
    assert not cache_usable("   \n")
    assert not cache_usable("ERROR: 500 b'boom'")
    assert cache_usable({"answer": "A*01:01", "confidence": "high"})   # baseline payloads are dicts
    assert not cache_usable(None)


def test_second_run_reuses_cache(suite_dir):
    d, ref = suite_dir
    _, full = load_suite(d, "dev")
    _, first = run_model(M.NaiveStringBaseline(), full, ref, d, "dev", verbose=False)
    _, second = run_model(M.NaiveStringBaseline(), full, ref, d, "dev", verbose=False)   # cache hit path
    assert first["overall"] == second["overall"]


def test_ollama_fallback_ladder_on_degenerate_replies(monkeypatch):
    calls = []

    def fake_post(url, headers, body, timeout=120, **kw):
        calls.append(body["options"])
        n = len(calls)
        content = "" if n == 1 else ("<unused57><unused57>" if n == 2 else '{"answer": 1}')
        return {"message": {"content": content}}

    monkeypatch.setattr(M, "_post", fake_post)
    monkeypatch.setattr(M.time, "sleep", lambda s: None)
    m = M.OllamaModel("gemma3:12b")
    out = m.answer({"task_id": "t", "subtype": "expand_ambiguity", "tier": 1, "instructions": "x", "input": {}})
    assert out == '{"answer": 1}' and len(calls) == 3
    assert calls[0]["num_ctx"] == 8192 and "num_batch" not in calls[0]
    assert calls[1]["num_batch"] == 64 and calls[2]["num_gpu"] == 0
    assert m.last_fallback == '{"num_gpu": 0}'
    assert not cache_usable("<unused57><unused57>")
