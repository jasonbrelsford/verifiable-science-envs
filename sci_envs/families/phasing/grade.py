"""Deterministic grader for family B's determinate subtypes (docs/TASK_SPEC_FAMILY_B.md §4, §7).

No model in the loop. ``grade()`` is pure given (task_full, response, reference) and
reuses family A's ``Score`` record, response envelope, calibration rule and
hallucination check, so ``summarize()`` and the report tooling work unchanged.

What is family B specific:
  * the answer is a *pair of haplotypes* (one allele per locus, in the task's ``loci``
    order) or the ``UNRESOLVABLE`` sentinel; pairs are compared order-normalised, so
    the two haplotypes may be given in either order;
  * two new failure modes from §4 — ``phase_flip`` (the pair reproduces the genotype
    but pairs the alleles wrongly) and ``impossible_pair`` (the pair does not reproduce
    the genotype at all: it carries an allele the individual does not have — the
    fabrication analogue; a pair with the wrong number of loci or haplotypes breaks the
    response contract and is ``malformed_response``);
  * ``refused`` fires on ``UNRESOLVABLE`` for a task whose phase was determinate,
    exactly as family A treats refusal spam, so a blanket ``UNRESOLVABLE`` scores only
    on the ``consistency_check`` tasks and is marked ``refused`` everywhere else.

Probabilistic subtypes (ranked lists, tolerance bands, Brier) are not graded yet;
they arrive with the frequency-model layer.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.grade import (
    CONF_RANK, Score, normalize_scalar, _parse_response, summarize, oracle_response,
)

__all__ = ["grade", "normalize_pair", "pair_reproduces_genotype", "summarize", "oracle_response",
           "GRADER_VERSION", "FLAG_VOCAB", "PRECEDENCE"]

GRADER_VERSION = "B-0.1"
SENTINEL = "UNRESOLVABLE"
FLAG_VOCAB = {"phase_ambiguous", "rare_haplotype", "inconsistent_genotype", "low_resolution_input"}

# Primary failure-mode precedence, highest first.  Family A's list with the two §4
# modes slotted where A keeps its own answer-shape diagnoses (above the calibration
# overlays, below hallucination).  The two flag modes are ranked too, so a correct
# answer with a missed or spurious flag reports that rather than a fallback.
PRECEDENCE = [
    "malformed_response", "hallucinated_answer", "impossible_pair", "phase_flip",
    "wrong_but_overconfident", "wrong_calibrated", "refused",
    "correct_but_overconfident", "correct_with_hallucinated_reasoning",
    "missed_ambiguity", "false_positive_flag", "clean_correct",
]

Pair = tuple[tuple[str, ...], tuple[str, ...]]


def _haplotype(h: Any, loci: list[str]) -> Optional[tuple[str, ...]]:
    """One haplotype as a tuple in ``loci`` order: a list aligned with ``loci`` or an
    object keyed by locus (``HLA-`` prefix and case on the key forgiven).  None if it
    is not one allele name per locus."""
    if isinstance(h, dict):
        keyed = {}
        for k, v in h.items():
            if not isinstance(k, str):
                return None
            keyed[k.strip().upper().removeprefix("HLA-")] = v
        if set(keyed) != set(loci):
            return None
        h = [keyed[l] for l in loci]
    if not isinstance(h, list) or len(h) != len(loci):
        return None
    out = []
    for a in h:
        if not isinstance(a, str):
            return None
        n = normalize_scalar(a)
        if n is None or n == SENTINEL:
            return None
        out.append(n)
    return tuple(out)


def normalize_pair(answer: Any, loci: list[str]) -> Optional[Pair]:
    """Canonical, order-normalised haplotype pair from an answer, or None if the answer
    is not two haplotypes over ``loci``.  Accepts ``{"haplotypes": [h1, h2]}`` or a bare
    ``[h1, h2]``; a haplotype is a list in ``loci`` order or an object keyed by locus."""
    if isinstance(answer, dict):
        answer = answer.get("haplotypes")
    if not isinstance(answer, list) or len(answer) != 2:
        return None
    h1, h2 = _haplotype(answer[0], loci), _haplotype(answer[1], loci)
    if h1 is None or h2 is None:
        return None
    a, b = sorted((h1, h2))
    return (a, b)


def pair_reproduces_genotype(pair: Pair, genotype: dict[str, list[str]], loci: list[str]) -> bool:
    """True if the two haplotypes unphase to exactly the task's genotype."""
    return all(sorted([pair[0][i], pair[1][i]]) == sorted(genotype[l]) for i, l in enumerate(loci))


def _answer_text(x: Any) -> str:
    return x if isinstance(x, str) else json.dumps(x)


def grade(task_full: dict, response: Any, ref: ImgtReference) -> Score:
    ref.assert_release(task_full["reference"]["release"])
    ans_spec = task_full["answer"]
    expected_conf = ans_spec["expected_confidence"]
    expected_flags = set(ans_spec["expected_flags"])
    loci: list[str] = list(task_full["input"]["loci"])
    genotype: dict[str, list[str]] = task_full["input"]["genotype"]
    base = dict(task_id=task_full["task_id"], confidence_expected=expected_conf,
                flags_expected=sorted(expected_flags), reference=task_full["reference"],
                tier=task_full["tier"], subtype=task_full["subtype"], slices=task_full.get("slices", []),
                grader_version=GRADER_VERSION)

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
    answer = r["answer"]

    # ---- the agent's answer: sentinel, pair, or neither
    sentinel = isinstance(answer, str) and normalize_scalar(answer) == SENTINEL
    pair = None if sentinel else normalize_pair(answer, loci)
    if not sentinel and pair is None:
        return Score(correct=False, partial=0.0, confidence_stated=stated, calibrated=False,
                     flags_raised=sorted(raised), flags_missed=sorted(expected_flags - raised),
                     flags_spurious=sorted(raised - expected_flags),
                     hallucinated_names=[], deprecated_names_used=[],
                     failure_modes=["malformed_response"], primary_failure_mode="malformed_response", **base)

    # ---- correctness (§4: exact, order-normalised)
    modes: list[str] = []
    canonical = ans_spec["canonical"]
    if isinstance(canonical, str):                       # consistency_check: the sentinel is the answer
        expected_pair = None
        correct = sentinel
    else:
        expected_pair = normalize_pair(canonical, loci)
        assert expected_pair is not None, "task canonical answer is not a haplotype pair"
        correct = pair == expected_pair
    if not correct:
        if sentinel:
            modes.append("refused")                      # UNRESOLVABLE where a phase existed
        elif not pair_reproduces_genotype(pair, genotype, loci):
            modes.append("impossible_pair")              # alleles the individual does not carry
        elif expected_pair is not None:
            modes.append("phase_flip")                   # right alleles, wrong pairing
    partial = 1.0 if correct else 0.0

    # ---- hallucination (family A §3.4): answer text + reasoning
    cls = ref.classify_tokens(_answer_text(answer) + "\n" + reasoning)
    hallucinated = cls["hallucinated"]
    deprecated_used = cls["deleted"]
    ans_cls = ref.classify_tokens(_answer_text(answer))
    if ans_cls["hallucinated"]:
        modes.append("hallucinated_answer")
    elif hallucinated and correct:
        modes.append("correct_with_hallucinated_reasoning")

    # ---- calibration (family A §3.2): over-confidence is the penalised direction
    calibrated = stated is not None and CONF_RANK[stated] <= CONF_RANK[expected_conf]

    # ---- flags (soft, as family A §3.3)
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
        elif not (missed or spurious or hallucinated):
            modes.append("clean_correct")
    elif "refused" not in modes:
        modes.append("wrong_but_overconfident" if stated == "high" else "wrong_calibrated")

    modes = sorted(set(modes), key=lambda m: PRECEDENCE.index(m) if m in PRECEDENCE else 99)
    primary = next((m for m in PRECEDENCE if m in modes), "wrong_calibrated")
    return Score(correct=correct, partial=partial, confidence_stated=stated, calibrated=calibrated,
                 flags_raised=sorted(raised), flags_missed=missed, flags_spurious=spurious,
                 hallucinated_names=hallucinated, deprecated_names_used=deprecated_used,
                 failure_modes=modes, primary_failure_mode=primary, **base)
