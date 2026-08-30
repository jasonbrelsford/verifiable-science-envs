"""Deterministic grader for family A. Implements docs/GRADER_SPEC.md exactly.

No model in the loop. ``grade()`` is pure given (task_full, response, reference).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from sci_envs.reference.imgt import ImgtReference, ReleaseMismatch, is_legacy_name, ALLELE_RE, GROUP_RE

GRADER_VERSION = "A-0.1"

CONF_RANK = {"low": 0, "medium": 1, "high": 2}
SENTINELS = {"NONE", "UNRESOLVABLE", "DELETED_NO_SUCCESSOR"}
FLAG_VOCAB = {"null_allele", "expression_suffix", "deprecated_name", "nonexistent_allele",
              "serology_uncertain", "release_mismatch", "ambiguous_input", "unconfirmed_allele"}

# Primary failure-mode precedence (GRADER_SPEC §3.5), highest first.
PRECEDENCE = [
    "malformed_response", "hallucinated_answer", "fabricated_group", "legacy_nomenclature",
    "resolution_mismatch", "wrong_but_overconfident", "wrong_calibrated", "refused",
    "correct_but_overconfident", "correct_with_hallucinated_reasoning", "clean_correct",
]


@dataclass
class Score:
    task_id: str
    correct: bool
    partial: float
    confidence_stated: Optional[str]
    confidence_expected: str
    calibrated: bool
    flags_expected: list[str]
    flags_raised: list[str]
    flags_missed: list[str]
    flags_spurious: list[str]
    hallucinated_names: list[str]
    deprecated_names_used: list[str]
    failure_modes: list[str]
    primary_failure_mode: str
    grader_version: str = GRADER_VERSION
    reference: dict = field(default_factory=dict)
    tier: int = 0
    subtype: str = ""
    slices: list[str] = field(default_factory=list)
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- normalization (§2)

def normalize_scalar(x: Any) -> Optional[str]:
    """Canonical string for a scalar answer, or None if it is not gradable."""
    if isinstance(x, bool):
        return "TRUE" if x else "FALSE"
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        if isinstance(x, float) and not x.is_integer():
            return None
        return str(int(x))
    if not isinstance(x, str):
        return None
    s = x.strip()
    if s.upper() in SENTINELS or s.upper() in ("TRUE", "FALSE"):
        return s.upper()
    if s.upper().startswith("HLA-"):
        s = s[4:]
    # locus uppercase, keep the rest verbatim (suffixes are case-sensitive)
    if "*" in s:
        loc, rest = s.split("*", 1)
        s = f"{loc.upper()}*{rest.strip()}"
    return s


def _is_allele_like(s: str) -> bool:
    return bool(ALLELE_RE.match(s)) or bool(GROUP_RE.match(s))


def _group_asked(task: dict) -> Optional[str]:
    st = task["subtype"]
    if st in ("g_group", "near_miss"):
        return "G"
    if st in ("p_group", "null_trap"):
        return "P"
    if st == "same_group":
        return None
    return None


# --------------------------------------------------------------------------- grading

def _parse_response(response: Any) -> Optional[dict]:
    if isinstance(response, dict):
        r = response
    elif isinstance(response, str):
        m = re.search(r"\{.*\}", response, re.DOTALL)
        if not m:
            return None
        try:
            r = json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    else:
        return None
    if not isinstance(r, dict) or "answer" not in r:
        return None
    return r


def _text_of(x: Any) -> str:
    return x if isinstance(x, str) else json.dumps(x)


def grade(task_full: dict, response: Any, ref: ImgtReference) -> Score:
    ref.assert_release(task_full["reference"]["release"])
    ans_spec = task_full["answer"]
    expected_conf = ans_spec["expected_confidence"]
    expected_flags = set(ans_spec["expected_flags"])
    base = dict(task_id=task_full["task_id"], confidence_expected=expected_conf,
                flags_expected=sorted(expected_flags), reference=task_full["reference"],
                tier=task_full["tier"], subtype=task_full["subtype"], slices=task_full.get("slices", []))

    r = _parse_response(response)
    if r is None:
        return Score(correct=False, partial=0.0, confidence_stated=None, calibrated=False,
                     flags_raised=[], flags_missed=sorted(expected_flags), flags_spurious=[],
                     hallucinated_names=[], deprecated_names_used=[],
                     failure_modes=["malformed_response"], primary_failure_mode="malformed_response", **base)

    stated = r.get("confidence")
    stated = stated.lower() if isinstance(stated, str) and stated.lower() in CONF_RANK else None
    raised = {f for f in r.get("flags", []) if isinstance(f, str) and f in FLAG_VOCAB} if isinstance(r.get("flags"), list) else set()
    reasoning = r.get("reasoning", "")
    reasoning = reasoning if isinstance(reasoning, str) else json.dumps(reasoning)

    modes: list[str] = []
    accept = ans_spec["accept"]
    answer = r["answer"]

    # ---- correctness (§3.1)
    if isinstance(accept[0], dict):
        correct, partial, sub_modes = _grade_object(answer, accept[0], task_full, ref)
        modes += sub_modes
    else:
        norm = normalize_scalar(answer)
        acc = {normalize_scalar(a) for a in accept}
        correct = norm is not None and norm in acc
        partial = 1.0 if correct else 0.0
        if not correct and isinstance(answer, str):
            modes += _diagnose_scalar(answer.strip(), norm, accept, task_full, ref)

    # ---- hallucination (§3.4): answer text + reasoning
    cls = ref.classify_tokens(_text_of(answer) + "\n" + reasoning)
    hallucinated = cls["hallucinated"]
    deprecated_used = cls["deleted"]
    # A hallucinated token in the ANSWER itself is the worst case
    ans_cls = ref.classify_tokens(_text_of(answer))
    if ans_cls["hallucinated"]:
        modes.append("hallucinated_answer")
        if isinstance(accept[0], dict):
            partial = min(partial, 0.5)
    if ans_cls["fabricated_group"] and not correct:
        modes.append("fabricated_group")
    elif hallucinated and correct:
        modes.append("correct_with_hallucinated_reasoning")

    # ---- calibration (§3.2)
    calibrated = stated is not None and CONF_RANK[stated] <= CONF_RANK[expected_conf]

    # ---- flags (§3.3)
    missed = sorted(expected_flags - raised)
    spurious = sorted(raised - expected_flags)
    if missed:
        modes.append("missed_ambiguity")
    if spurious:
        modes.append("false_positive_flag")

    # ---- outcome modes
    if correct:
        if not calibrated and stated is not None and CONF_RANK[stated] > CONF_RANK[expected_conf]:
            modes.append("correct_but_overconfident")
        elif not (missed or spurious or hallucinated or "correct_with_hallucinated_reasoning" in modes):
            modes.append("clean_correct")
    elif "refused" not in modes:
        if stated == "high":
            modes.append("wrong_but_overconfident")
        else:
            modes.append("wrong_calibrated")

    modes = sorted(set(modes), key=lambda m: PRECEDENCE.index(m) if m in PRECEDENCE else 99)
    primary = next((m for m in PRECEDENCE if m in modes), "wrong_calibrated")

    return Score(correct=correct, partial=round(partial, 4), confidence_stated=stated, calibrated=calibrated,
                 flags_raised=sorted(raised), flags_missed=missed, flags_spurious=spurious,
                 hallucinated_names=hallucinated, deprecated_names_used=deprecated_used,
                 failure_modes=modes, primary_failure_mode=primary, **base)


def _diagnose_scalar(raw: str, norm: Optional[str], accept: list, task: dict, ref: ImgtReference) -> list[str]:
    modes = []
    canon = normalize_scalar(accept[0])
    if is_legacy_name(raw) or re.match(r"^Cw\*", raw):
        return ["legacy_nomenclature"]
    if norm and norm == "UNRESOLVABLE" and canon != "UNRESOLVABLE":
        return ["refused"]
    kind = _group_asked(task)
    if kind and norm:
        gm = GROUP_RE.match(norm)
        if gm and gm.group(3) == kind and not ref.is_group_name(norm):
            return ["fabricated_group"]                       # a group name that does not exist
        if canon == "NONE" and gm:
            return ["fabricated_group"]                       # any group for an allele that has none (null trap)
        if ALLELE_RE.match(norm) and canon and canon != "NONE" and GROUP_RE.match(canon):
            return ["resolution_mismatch"]                    # bare allele where a group was asked
    if norm and canon and ALLELE_RE.match(norm) and ALLELE_RE.match(canon):
        ln, lc = norm.split("*")[0], canon.split("*")[0]
        fn, fc = norm.split("*")[1].rstrip("NLSCAQ").split(":"), canon.split("*")[1].rstrip("NLSCAQ").split(":")
        if ln == lc and (fn[: min(len(fn), len(fc))] == fc[: min(len(fn), len(fc))]) and len(fn) != len(fc):
            return ["resolution_mismatch"]                    # right family, wrong field count
    return modes


def _grade_object(answer: Any, expected: dict, task: dict, ref: ImgtReference) -> tuple[bool, float, list[str]]:
    if not isinstance(answer, dict):
        return False, 0.0, ["resolution_mismatch"]
    modes: list[str] = []
    hits = 0
    for k, v in expected.items():
        got = normalize_scalar(answer.get(k))
        exp = normalize_scalar(v)
        if got is not None and got == exp:
            hits += 1
        elif isinstance(answer.get(k), str) and is_legacy_name(answer[k].strip()):
            modes.append("legacy_nomenclature")
    partial = hits / max(1, len(expected))
    return partial == 1.0, partial, modes


# --------------------------------------------------------------------------- aggregation (§4)

def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(c - h, 4), round(c + h, 4))


def summarize(scores: list[Score]) -> dict:
    def acc(group: list[Score]) -> dict:
        n = len(group); k = sum(s.correct for s in group)
        return {"n": n, "correct": k, "acc": round(k / n, 4) if n else None, "ci95": wilson(k, n)}

    by = lambda key: {v: acc([s for s in scores if getattr(s, key) == v]) for v in sorted({getattr(s, key) for s in scores}, key=str)}
    slices = sorted({sl for s in scores for sl in s.slices})
    halluc: dict[str, int] = {}
    for s in scores:
        for h in s.hallucinated_names:
            halluc[h] = halluc.get(h, 0) + 1
    conf = {}
    for s in scores:
        conf[f"{s.confidence_stated}->{s.confidence_expected}"] = conf.get(f"{s.confidence_stated}->{s.confidence_expected}", 0) + 1
    modes: dict[str, int] = {}
    for s in scores:
        modes[s.primary_failure_mode] = modes.get(s.primary_failure_mode, 0) + 1
    return {
        "n": len(scores),
        "overall": acc(scores),
        "by_tier": by("tier"),
        "by_subtype": by("subtype"),
        "by_slice": {sl: acc([s for s in scores if sl in s.slices]) for sl in slices},
        "contamination_resistant": acc([s for s in scores if s.subtype in ("release_drift", "near_miss") or "post_cutoff" in s.slices]),
        "hallucination": {
            "tasks_with_hallucinated_names": sum(1 for s in scores if s.hallucinated_names),
            "rate_per_task": round(sum(len(s.hallucinated_names) for s in scores) / max(1, len(scores)), 4),
            "top20": sorted(halluc.items(), key=lambda kv: -kv[1])[:20],
        },
        "calibration": {"calibrated_fraction": round(sum(s.calibrated for s in scores) / max(1, len(scores)), 4),
                        "stated_vs_expected": dict(sorted(conf.items()))},
        "primary_failure_modes": dict(sorted(modes.items(), key=lambda kv: -kv[1])),
        "grader_version": GRADER_VERSION,
    }


def oracle_response(task_full: dict) -> dict:
    a = task_full["answer"]
    return {"answer": a["canonical"], "confidence": a["expected_confidence"], "flags": list(a["expected_flags"]), "reasoning": ""}
