"""Shared pieces for the RL/eval-format adapters (verifiers, Inspect, Harbor)."""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.generate import generate_suite
from sci_envs.families.nomenclature.grade import grade
from sci_envs.harness.models import SYSTEM, _prompt

SYSTEM_PROMPT = SYSTEM


@lru_cache(maxsize=4)
def reference(tag: str = "v3.65.0-alpha") -> ImgtReference:
    return ImgtReference.load(tag)


@lru_cache(maxsize=8)
def suite(tag: str = "v3.65.0-alpha", split: str = "dev") -> tuple[list[dict], dict]:
    """Full task dicts for a split ('dev' | 'test' | 'all'), generated deterministically."""
    tasks, manifest = generate_suite(reference(tag))
    full = [t.full() for t in tasks if split == "all" or t.scorer_notes.get("split") == split]
    return full, manifest


def prompt_for(task_full: dict) -> str:
    agent = {k: v for k, v in task_full.items() if k not in ("answer", "scorer_notes")}
    return _prompt(agent)


def last_assistant_text(completion: Any) -> str:
    """verifiers/Inspect hand back either a string or a list of chat messages."""
    if isinstance(completion, str):
        return completion
    if isinstance(completion, list):
        for m in reversed(completion):
            role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
            if role == "assistant":
                c = m.get("content") if isinstance(m, dict) else getattr(m, "content", "")
                if isinstance(c, list):
                    c = "".join(p.get("text", "") if isinstance(p, dict) else getattr(p, "text", "") for p in c)
                return c or ""
    return str(completion)


def score(task_full: dict, completion: Any, tag: str = "v3.65.0-alpha") -> dict:
    s = grade(task_full, last_assistant_text(completion), reference(tag))
    return s.to_dict()
