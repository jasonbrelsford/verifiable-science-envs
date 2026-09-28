"""Harness smoke test: baselines run, oracle scores 100%, report renders."""
import json
from pathlib import Path

import pytest

from sci_envs.reference import ImgtReference
from sci_envs.families.nomenclature import generate_suite, write_suite
from sci_envs.harness import models as M
from sci_envs.harness.run import run_model, load_suite, cache_usable, ApiErrorRateExceeded
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


def _fake_task():
    return {"task_id": "t", "subtype": "expand_ambiguity", "tier": 1, "instructions": "x", "input": {}}


def test_anthropic_request_has_no_assistant_prefill(monkeypatch):
    """Current Claude models reject a request that ends on an assistant turn
    ('This model does not support assistant message prefill'); the request body
    must contain no assistant message and must end with a user message."""
    captured = {}

    def fake_post(url, headers, body, timeout=120, **kw):
        captured["body"] = body
        return {"content": [{"type": "text", "text": '{"answer": "A*01:01"}'}]}

    monkeypatch.setattr(M, "_post", fake_post)
    m = M.AnthropicModel("claude-sonnet-4-6", key="test-key")
    out = m.answer(_fake_task())
    messages = captured["body"]["messages"]
    assert all(msg["role"] != "assistant" for msg in messages)
    assert messages[-1]["role"] == "user"
    assert out == '{"answer": "A*01:01"}'


def test_anthropic_extracts_json_wrapped_in_prose_or_code_fence(monkeypatch):
    replies = [
        'Sure, here is the answer:\n```json\n{"answer": "A*01:01", "confidence": "high"}\n```\n'
        'Let me know if you need anything else.',
        'The JSON object is {"answer": "A*01:01"} and that is final.',
        '{"answer": "A*01:01"}',
    ]

    def fake_post(url, headers, body, timeout=120, **kw):
        return {"content": [{"type": "text", "text": replies.pop(0)}]}

    monkeypatch.setattr(M, "_post", fake_post)
    m = M.AnthropicModel("claude-sonnet-4-6", key="test-key")
    for _ in range(3):
        out = m.answer(_fake_task())
        assert json.loads(out)["answer"] == "A*01:01"


def test_extract_json_object_ignores_braces_inside_strings():
    text = 'prose {"answer": "A*01:01", "reasoning": "looks like {not json}"} trailing'
    out = M._extract_json_object(text)
    assert json.loads(out) == {"answer": "A*01:01", "reasoning": "looks like {not json}"}


class _AlwaysErrorModel:
    name = "anthropic/stub-mostly-errors"

    def answer(self, t):
        raise RuntimeError('400 Bad Request: {"type": "error", "error": {"message": "boom"}}')


def test_run_aborts_and_writes_nothing_when_mostly_api_errors(suite_dir):
    d, ref = suite_dir
    _, full = load_suite(d, "dev")
    model = _AlwaysErrorModel()
    with pytest.raises(ApiErrorRateExceeded):
        run_model(model, full, ref, d, "dev", verbose=False)
    safe = model.name.replace("/", "__").replace(":", "_")
    assert not (d / "results" / f"{safe}.dev.json").exists()
    assert not (d / "scores" / f"{safe}.dev.json").exists()
