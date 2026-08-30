"""Family A: oracle, anti-oracle, sentinel, legacy, release-pin, determinism (GRADER_SPEC §5)."""
import json
import random

import pytest

from sci_envs.reference import ImgtReference, ReleaseMismatch
from sci_envs.families.nomenclature import generate_suite, grade, oracle_response, summarize, GENERATORS, Sampler
from sci_envs.families.nomenclature.generate import COUNTS, TIER_OF

TAG = "v3.65.0-alpha"


@pytest.fixture(scope="session")
def ref():
    return ImgtReference.load(TAG)


@pytest.fixture(scope="session")
def suite(ref):
    tasks, manifest = generate_suite(ref)
    return tasks, manifest


def test_suite_shape(suite):
    tasks, manifest = suite
    assert manifest["total"] == 550
    for st in GENERATORS:
        assert manifest["counts_per_subtype"][st] == COUNTS[TIER_OF[st]]
    assert 90 <= manifest["split"]["dev"] <= 130
    assert manifest["cutoff_assumption"]["post_cutoff_share_T3T4_allele_tasks"] >= 0.25
    ids = [t.task_id for t in tasks]
    assert len(ids) == len(set(ids))
    keys = [t.key() for t in tasks]
    assert len(keys) == len(set(keys))


def test_determinism(ref, suite):
    tasks, _ = suite
    again, _ = generate_suite(ref)
    assert [t.task_id for t in tasks] == [t.task_id for t in again]
    assert [t.answer for t in tasks] == [t.answer for t in again]
    assert [t.input for t in tasks] == [t.input for t in again]


def test_agent_projection_hides_answer(suite):
    tasks, _ = suite
    a = tasks[0].agent()
    assert "answer" not in a and "scorer_notes" not in a
    assert "instructions" in a and "input" in a and a["reference"]["release"] == "3.65.0"


def test_oracle_passes_every_task(ref, suite):
    tasks, _ = suite
    bad = []
    for t in tasks:
        s = grade(t.full(), oracle_response(t.full()), ref)
        if not (s.correct and s.calibrated and s.primary_failure_mode == "clean_correct" and not s.hallucinated_names):
            bad.append((t.task_id, s.primary_failure_mode))
    assert bad == []


def test_anti_oracle_random_valid_allele_is_wrong_not_hallucinated(ref, suite):
    tasks, _ = suite
    rng = random.Random(1)
    pool = ref.alleles("B")
    scalar_tasks = [t for t in tasks if t.subtype in ("g_group", "p_group", "truncate", "renamed_to", "first_release")]
    for t in rng.sample(scalar_tasks, 40):
        wrong = rng.choice(pool)
        if wrong in t.answer["accept"]:
            continue
        s = grade(t.full(), {"answer": wrong, "confidence": "medium", "flags": t.answer["expected_flags"], "reasoning": ""}, ref)
        assert not s.correct
        assert "hallucinated_answer" not in s.failure_modes, (t.task_id, wrong)


def test_null_trap_sentinels(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "null_trap")
    ok = grade(t.full(), {"answer": "NONE", "confidence": "high", "flags": ["null_allele"], "reasoning": ""}, ref)
    assert ok.correct and ok.primary_failure_mode == "clean_correct"
    # Fabricate a P group for a null allele: must be fabricated_group, not merely wrong
    allele = t.input["allele"]
    fake = allele.split("*")[0] + "*" + ":".join(allele.split("*")[1].rstrip("N").split(":")[:2]) + "P"
    bad = grade(t.full(), {"answer": fake, "confidence": "high", "flags": [], "reasoning": ""}, ref)
    assert not bad.correct and bad.primary_failure_mode == "fabricated_group"


def test_legacy_answer_is_legacy_nomenclature(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "truncate" and t.input["fields"] == 2)
    canon = t.answer["canonical"]
    legacy = canon.replace(":", "")
    s = grade(t.full(), {"answer": legacy, "confidence": "high", "flags": [], "reasoning": ""}, ref)
    assert not s.correct and s.primary_failure_mode == "legacy_nomenclature"


def test_resolution_mismatch(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "g_group" and t.answer["canonical"] != "NONE")
    s = grade(t.full(), {"answer": t.input["allele"], "confidence": "high", "flags": [], "reasoning": ""}, ref)
    assert not s.correct and s.primary_failure_mode == "resolution_mismatch"


def test_hallucinated_answer_and_reasoning(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "g_group")
    s = grade(t.full(), {"answer": "A*99:999:01G", "confidence": "high", "flags": [], "reasoning": ""}, ref)
    assert s.primary_failure_mode in ("hallucinated_answer", "fabricated_group")
    ok = oracle_response(t.full()); ok["reasoning"] = "Because B*77:777 is similar."
    s2 = grade(t.full(), ok, ref)
    assert s2.correct and s2.hallucinated_names == ["B*77:777"] and s2.primary_failure_mode == "correct_with_hallucinated_reasoning"


def test_overconfidence_and_refusal(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "release_drift")   # expected confidence: low
    ok = oracle_response(t.full()); ok["confidence"] = "high"
    s = grade(t.full(), ok, ref)
    assert s.correct and not s.calibrated and s.primary_failure_mode == "correct_but_overconfident"
    t2 = next(t for t in tasks if t.subtype == "g_group" and t.answer["canonical"] != "NONE")
    s2 = grade(t2.full(), {"answer": "UNRESOLVABLE", "confidence": "low", "flags": ["ambiguous_input"], "reasoning": ""}, ref)
    assert not s2.correct and s2.primary_failure_mode == "refused"


def test_malformed(ref, suite):
    tasks, _ = suite
    t = tasks[0]
    s = grade(t.full(), "I think the answer is probably A*01:01 but I'm not sure", ref)
    assert s.primary_failure_mode == "malformed_response" and not s.correct


def test_compositional_partial_credit(ref, suite):
    tasks, _ = suite
    t = next(t for t in tasks if t.subtype == "typing_report_normalize")
    ans = dict(t.answer["canonical"]); k = next(iter(ans)); ans[k] = "A*01:01" if ans[k] != "A*01:01" else "A*02:01"
    s = grade(t.full(), {"answer": ans, "confidence": "medium", "flags": t.answer["expected_flags"], "reasoning": ""}, ref)
    assert not s.correct and abs(s.partial - 5 / 6) < 1e-3


def test_release_pin_enforced(ref, suite):
    tasks, _ = suite
    t = tasks[0].full()
    t["reference"] = dict(t["reference"], release="3.64.0")
    with pytest.raises(ReleaseMismatch):
        grade(t, oracle_response(t), ref)


def test_summary_shape(ref, suite):
    tasks, _ = suite
    scores = [grade(t.full(), oracle_response(t.full()), ref) for t in tasks[:60]]
    summ = summarize(scores)
    assert summ["overall"]["acc"] == 1.0 and summ["n"] == 60
    assert "by_slice" in summ and "hallucination" in summ and "contamination_resistant" in summ
    json.dumps(summ)  # serializable
