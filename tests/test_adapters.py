"""Adapters build and score against the oracle (skipped if optional deps are absent)."""
import json
import pytest

from sci_envs.adapters.common import suite, score

def test_common_score_oracle():
    full, _ = suite(split="dev")
    t = full[0]
    resp = json.dumps({"answer": t["answer"]["canonical"], "confidence": t["answer"]["expected_confidence"],
                       "flags": t["answer"]["expected_flags"], "reasoning": ""})
    s = score(t, [{"role": "assistant", "content": resp}])
    assert s["correct"] and s["primary_failure_mode"] == "clean_correct"


def test_verifiers_env():
    pytest.importorskip("verifiers"); pytest.importorskip("datasets")
    from sci_envs.adapters.verifiers_env import load_environment, correct, no_fabrication
    env = load_environment(split="dev")
    row = env.dataset[0]
    info = row["info"]
    tf = json.loads(info["task"])
    good = json.dumps({"answer": tf["answer"]["canonical"], "confidence": "medium", "flags": tf["answer"]["expected_flags"]})
    assert correct(completion=[{"role": "assistant", "content": good}], info=info) == 1.0
    assert no_fabrication(completion=[{"role": "assistant", "content": '{"answer":"B*99:99:99"}'}], info=info) == 0.0


def test_inspect_task():
    pytest.importorskip("inspect_ai")
    from sci_envs.adapters.inspect_task import hla_bench_a
    t = hla_bench_a(split="dev")
    assert len(t.dataset) >= 90 and t.dataset[0].metadata["task_full"]["reference"]["release"] == "3.65.0"
