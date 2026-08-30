"""Inspect AI (UK AISI) task for HLA-Bench-A.

    inspect eval sci_envs/adapters/inspect_task.py@hla_bench_a --model anthropic/claude-sonnet-4-6 -T split=dev
"""
from __future__ import annotations

import json

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, accuracy, mean, scorer, stderr
from inspect_ai.solver import TaskState, generate, system_message

from .common import SYSTEM_PROMPT, suite, prompt_for, score


@scorer(metrics=[accuracy(), stderr()])
def hla_grader():
    async def _score(state: TaskState, target: Target) -> Score:
        info = state.metadata["task_full"]
        s = score(info, state.output.completion, info["reference"]["tag"])
        return Score(value="C" if s["correct"] else "I", answer=state.output.completion,
                     explanation=s["primary_failure_mode"],
                     metadata={"partial": s["partial"], "hallucinated_names": s["hallucinated_names"],
                               "calibrated": s["calibrated"], "failure_modes": s["failure_modes"],
                               "tier": s["tier"], "subtype": s["subtype"], "slices": s["slices"]})
    return _score


@task
def hla_bench_a(tag: str = "v3.65.0-alpha", split: str = "dev") -> Task:
    full, manifest = suite(tag, split)
    samples = [Sample(id=t["task_id"], input=prompt_for(t), target=json.dumps(t["answer"]["canonical"]),
                      metadata={"task_full": t, "tier": t["tier"], "subtype": t["subtype"]}) for t in full]
    return Task(dataset=samples, solver=[system_message(SYSTEM_PROMPT), generate()], scorer=hla_grader(),
                name=manifest["benchmark"])
