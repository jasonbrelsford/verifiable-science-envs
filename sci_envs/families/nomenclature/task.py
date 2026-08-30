"""Task record for family A (HLA nomenclature resolution). See docs/TASK_SPEC.md §3."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any

FAMILY = "hla_nomenclature"

RESPONSE_CONTRACT = (
    'Respond with ONLY a JSON object: {"answer": <string, integer, boolean, or object as the task '
    'specifies>, "confidence": "high"|"medium"|"low", "flags": [<strings>], "reasoning": "<brief>"}. '
    'Recognized flags: null_allele, expression_suffix, deprecated_name, nonexistent_allele, '
    'serology_uncertain, release_mismatch, ambiguous_input, unconfirmed_allele. '
    'If the input cannot be resolved, answer "UNRESOLVABLE" and explain in flags/reasoning. '
    'Use current IPD-IMGT/HLA colon-delimited nomenclature only; legacy colon-less names (A*0101) are not accepted.'
)


@dataclass
class Task:
    task_id: str
    tier: int
    subtype: str
    reference: dict            # {"db","release","tag","md5"}
    instructions: str
    input: dict
    answer: dict               # {"canonical","accept","expected_confidence","expected_flags"}
    slices: list[str] = field(default_factory=list)
    scorer_notes: dict = field(default_factory=dict)
    family: str = FAMILY

    def full(self) -> dict:
        d = asdict(self)
        return d

    def agent(self) -> dict:
        d = asdict(self)
        d.pop("answer")
        d.pop("scorer_notes")
        return d

    def key(self) -> tuple:
        """Dedup key across splits: (subtype, primary input identity)."""
        return (self.subtype, self.scorer_notes.get("key", json.dumps(self.input, sort_keys=True)))


def dumps(obj: Any) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False)
