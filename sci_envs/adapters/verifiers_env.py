"""Prime Intellect `verifiers` environment for HLA-Bench-A.

    import verifiers as vf
    env = vf.load_environment("hla_nomenclature")      # after `vf-install` / packaging
    # or directly:
    from sci_envs.adapters.verifiers_env import load_environment
    env = load_environment(split="dev")

Reward = 1.0 * correct  +  0.25 * no_fabrication  +  0.10 * calibrated  +  0.10 * flags_right
(all deterministic; see docs/GRADER_SPEC.md). `correct` is the headline metric.
"""
from __future__ import annotations

import json
from typing import Any

from .common import SYSTEM_PROMPT, suite, prompt_for, score


def _rows(tag: str, split: str) -> list[dict]:
    full, _ = suite(tag, split)
    # `info` is a JSON string: task dicts are heterogeneous across subtypes and Arrow needs one schema.
    return [{"question": prompt_for(t), "answer": json.dumps(t["answer"]["canonical"]), "info": {"task": json.dumps(t)}} for t in full]


def _task(info) -> dict:
    if isinstance(info, dict) and "task" in info:
        return json.loads(info["task"]) if isinstance(info["task"], str) else info["task"]
    return json.loads(info) if isinstance(info, str) else info


def _score(completion, info) -> dict:
    t = _task(info)
    return score(t, completion, t["reference"]["tag"])


def correct(completion, info, **kwargs) -> float:
    return 1.0 if _score(completion, info)["correct"] else 0.0


def no_fabrication(completion, info, **kwargs) -> float:
    return 0.0 if _score(completion, info)["hallucinated_names"] else 1.0


def calibrated(completion, info, **kwargs) -> float:
    return 1.0 if _score(completion, info)["calibrated"] else 0.0


def flags_right(completion, info, **kwargs) -> float:
    s = _score(completion, info)
    return 0.0 if (s["flags_missed"] or s["flags_spurious"]) else 1.0


def load_environment(tag: str = "v3.65.0-alpha", split: str = "dev", **kwargs):
    import verifiers as vf
    from datasets import Dataset

    ds = Dataset.from_list(_rows(tag, split))
    rubric = vf.Rubric(funcs=[correct, no_fabrication, calibrated, flags_right], weights=[1.0, 0.25, 0.10, 0.10])
    return vf.SingleTurnEnv(dataset=ds, system_prompt=SYSTEM_PROMPT, rubric=rubric, **kwargs)
