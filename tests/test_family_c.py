"""Family C end-to-end: suite generation determinism + oracle 100% through the grader."""
import json
from pathlib import Path

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.matching.generate import generate_suite
from sci_envs.families.nomenclature.grade import grade, oracle_response

REF = ImgtReference.load("v3.65.0-alpha")


def test_suite_deterministic_and_oracle_perfect():
    tasks, manifest = generate_suite(REF)
    tasks2, _ = generate_suite(REF)
    assert [t.task_id for t in tasks] == [t.task_id for t in tasks2]
    assert manifest["total"] == len(tasks) >= 200
    wrong = []
    for t in tasks:
        s = grade(t.full(), oracle_response(t.full()), REF)
        if not s.correct:
            wrong.append(t.task_id)
    assert wrong == [], wrong[:5]


def test_committed_suite_matches_generator():
    suite = Path("runs/hla-bench-c/manifest.json")
    if suite.exists():
        m = json.loads(suite.read_text())
        _, manifest = generate_suite(REF, base_seed=m["base_seed"])
        assert m["total"] == manifest["total"] and m["split"] == manifest["split"]
