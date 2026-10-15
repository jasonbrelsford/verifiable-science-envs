"""Deterministic grader for family B's determinate subtypes (docs/TASK_SPEC_FAMILY_B.md §4,
§7.2, §8.3).

No model in the loop. ``grade()`` is pure given (task_full, response, reference) and
reuses family A's ``Score`` record, response envelope, calibration rule and
hallucination check, so ``summarize()`` and the report tooling work unchanged.

What is family B specific:
  * the answer is a *pair of haplotypes* (one allele per locus, in the task's ``loci``
    order), a ``ranked`` list of one to three such pairs (§8.3; a one-entry list is a
    pair), or the ``UNRESOLVABLE`` sentinel; pairs are compared order-normalised, so the
    two haplotypes may be given in either order, and a set task compares sets;
  * the §4 modes — ``phase_flip`` (the pair reproduces the genotype but pairs the alleles
    wrongly) and ``impossible_pair`` (the pair does not reproduce the genotype at the
    typed loci, or carries, at the untyped or a lifted locus, an allele neither parent
    carries there — the fabrication analogue; the wrong number of loci or haplotypes
    breaks the response contract and is ``malformed_response``);
  * the §8.3 modes — ``resolution_not_lifted``, ``wrong_lift``, ``wrong_imputation``,
    ``hedged_answer`` — and the probability-sum rule (each in [0, 1], sum ≤ 1 + ε, else
    ``malformed_response``); probability *values* are not graded in this layer;
  * ``refused`` fires on ``UNRESOLVABLE`` for a task whose phase was determinate,
    exactly as family A treats refusal spam, so a blanket ``UNRESOLVABLE`` scores only
    on the ``consistency_check`` tasks and is marked ``refused`` everywhere else.

Tolerance bands and Brier arrive with the frequency-model layer (§8.4).
"""
from __future__ import annotations

import json
from typing import Any, Optional

from sci_envs.reference.imgt import ImgtReference, split_allele
from sci_envs.families.nomenclature.grade import (
    CONF_RANK, Score, normalize_scalar, _parse_response, summarize,
)

__all__ = ["grade", "normalize_pair", "pair_reproduces_genotype", "summarize", "oracle_response",
           "GRADER_VERSION", "FLAG_VOCAB", "PRECEDENCE", "MAX_RANKED", "PROB_EPS"]

GRADER_VERSION = "B-0.2"
SENTINEL = "UNRESOLVABLE"
FLAG_VOCAB = {"phase_ambiguous", "rare_haplotype", "inconsistent_genotype", "low_resolution_input",
              "null_allele"}
MAX_RANKED = 3           # §1: a rank list of up to 3 pairs
PROB_EPS = 0.01          # §8.3: probabilities, if present, sum to at most 1 + ε

# Primary failure-mode precedence (§8.3), highest first.  Family A's list with the
# family B answer-shape diagnoses slotted above the calibration overlays and below
# hallucination.  The two flag modes are ranked too, so a correct answer with a missed
# or spurious flag reports that rather than a fallback.
PRECEDENCE = [
    "malformed_response", "hallucinated_answer", "impossible_pair", "phase_flip",
    "resolution_not_lifted", "wrong_lift", "wrong_imputation", "hedged_answer",
    "wrong_but_overconfident", "wrong_calibrated", "refused",
    "correct_but_overconfident", "correct_with_hallucinated_reasoning",
    "missed_ambiguity", "false_positive_flag", "clean_correct",
]

Pair = tuple[tuple[str, ...], tuple[str, ...]]


# ------------------------------------------------------------------- answer shapes
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


def _probability_ok(entries: list[dict]) -> bool:
    """§8.3: probabilities are optional; when present each is a number in [0, 1] and
    they sum to at most 1 + ε."""
    total = 0.0
    for e in entries:
        p = e.get("probability")
        if p is None:
            continue
        if isinstance(p, bool) or not isinstance(p, (int, float)) or not 0.0 <= p <= 1.0:
            return False
        total += p
    return total <= 1.0 + PROB_EPS


def normalize_ranked(answer: Any, loci: list[str]) -> Optional[list[Pair]]:
    """The pairs of a ``{"ranked": [...]}`` answer in the order given, or None when the
    list is not one to three well-formed pairs with well-formed probabilities."""
    if not isinstance(answer, dict) or not isinstance(answer.get("ranked"), list):
        return None
    entries = answer["ranked"]
    if not 1 <= len(entries) <= MAX_RANKED or not all(isinstance(e, dict) for e in entries):
        return None
    pairs = [normalize_pair(e, loci) for e in entries]
    if any(p is None for p in pairs) or not _probability_ok(entries):
        return None
    return pairs


# ----------------------------------------------------------------- consistency checks
def _fields(name: str) -> int:
    return len(split_allele(name)[1])


def _trunc(name: str, n: int) -> str:
    """``name`` reduced to its first ``n`` fields (the suffix kept only when nothing is
    cut); a name with fewer fields is returned as is."""
    locus, fields, suffix = split_allele(name)
    if len(fields) <= n:
        return name
    return f"{locus}*{':'.join(fields[:n])}"


def pair_reproduces_genotype(pair: Pair, genotype: dict[str, Optional[list[str]]], loci: list[str],
                             fields: Optional[int] = None) -> bool:
    """True if the two haplotypes unphase to exactly the task's genotype at every typed
    locus (``genotype[l]`` not None), after truncation to ``fields`` when the input was
    given at that resolution (§8.3)."""
    for i, l in enumerate(loci):
        if genotype[l] is None:
            continue
        a, b = pair[0][i], pair[1][i]
        if fields is not None:
            a, b = _trunc(a, fields), _trunc(b, fields)
        if sorted([a, b]) != sorted(genotype[l]):
            return False
    return True


def _parental_alleles(relatives: dict, locus: str, loci: list[str]) -> set[str]:
    """Every allele the father or mother carries at ``locus``, whichever shape the
    relative was given in (unphased genotype or phased ``haplotypes``)."""
    out: set[str] = set()
    i = loci.index(locus)
    for who in ("father", "mother"):
        rel = relatives.get(who)
        if not isinstance(rel, dict):
            continue
        if "haplotypes" in rel:
            out |= {h[i] for h in rel["haplotypes"]}
        elif locus in rel:
            out |= set(rel[locus])
    return out


def _same_names(p: Pair, q: Pair) -> bool:
    """The per-locus allele multisets agree: the names are right, only the pairing differs."""
    return all(sorted([p[0][i], p[1][i]]) == sorted([q[0][i], q[1][i]]) for i in range(len(p[0])))


def _restrict(p: Pair, keep: list[int]) -> Pair:
    a, b = sorted((tuple(p[0][i] for i in keep), tuple(p[1][i] for i in keep)))
    return (a, b)


class _Ctx:
    """What the task's input says about which checks apply."""

    def __init__(self, task_full: dict):
        inp = task_full["input"]
        self.subtype: str = task_full["subtype"]
        self.loci: list[str] = list(inp["loci"])
        self.genotype: dict = inp["genotype"]
        self.relatives: dict = inp.get("relatives") or {}
        self.untyped: list[str] = [l for l in self.loci if self.genotype[l] is None]
        self.typed_idx: list[int] = [i for i, l in enumerate(self.loci) if self.genotype[l] is not None]
        self.lifted: bool = self.subtype == "resolution_lift"
        self.fields: Optional[int] = task_full.get("scorer_notes", {}).get("input_fields", 2) if self.lifted else None

    def impossible(self, pair: Pair) -> bool:
        """§8.3's widened ``impossible_pair``: fails to reproduce the typed loci (at the
        input's resolution), or carries at the untyped locus — or, lifted beyond the input's
        fields, at any locus — an allele neither parent carries there."""
        if not pair_reproduces_genotype(pair, self.genotype, self.loci, self.fields):
            return True
        for i, l in enumerate(self.loci):
            check = l in self.untyped or (self.lifted and self.fields is not None)
            if not check:
                continue
            parental = _parental_alleles(self.relatives, l, self.loci)
            for a in (pair[0][i], pair[1][i]):
                if self.lifted and _fields(a) <= self.fields:
                    continue                           # not lifted at all: resolution_not_lifted's case
                if a not in parental:
                    return True
        return False

    def not_lifted(self, pair: Pair) -> bool:
        return self.lifted and all(_fields(a) <= self.fields for h in pair for a in h)

    def wrong_pair_modes(self, pair: Pair, truth: Pair) -> list[str]:
        """Shape diagnosis for a single wrong pair on a single-pair task (§7.2, §8.3)."""
        if self.impossible(pair):
            return ["impossible_pair"]
        if self.not_lifted(pair):
            return ["resolution_not_lifted"]
        if _same_names(pair, truth):
            return ["phase_flip"]
        if self.lifted:
            return ["wrong_lift"]                      # parental, consistent, not forced, not a flip
        if self.untyped and _restrict(pair, self.typed_idx) == _restrict(truth, self.typed_idx):
            return ["wrong_imputation"]                # typed loci exactly right, untyped wrong
        return []


def _answer_text(x: Any) -> str:
    return x if isinstance(x, str) else json.dumps(x)


def _malformed(base: dict, stated, raised: set, expected_flags: set) -> Score:
    return Score(correct=False, partial=0.0, confidence_stated=stated, calibrated=False,
                 flags_raised=sorted(raised), flags_missed=sorted(expected_flags - raised),
                 flags_spurious=sorted(raised - expected_flags),
                 hallucinated_names=[], deprecated_names_used=[],
                 failure_modes=["malformed_response"], primary_failure_mode="malformed_response", **base)


def grade(task_full: dict, response: Any, ref: ImgtReference) -> Score:
    ref.assert_release(task_full["reference"]["release"])
    ans_spec = task_full["answer"]
    expected_conf = ans_spec["expected_confidence"]
    expected_flags = set(ans_spec["expected_flags"])
    ctx = _Ctx(task_full)
    loci = ctx.loci
    base = dict(task_id=task_full["task_id"], confidence_expected=expected_conf,
                flags_expected=sorted(expected_flags), reference=task_full["reference"],
                tier=task_full["tier"], subtype=task_full["subtype"], slices=task_full.get("slices", []),
                grader_version=GRADER_VERSION)

    r = _parse_response(response)
    if r is None:
        return _malformed(base, None, set(), expected_flags)

    stated = r.get("confidence")
    stated = stated.lower() if isinstance(stated, str) and stated.lower() in CONF_RANK else None
    raised = {f for f in r.get("flags", []) if isinstance(f, str) and f in FLAG_VOCAB} if isinstance(r.get("flags"), list) else set()
    reasoning = r.get("reasoning", "")
    reasoning = reasoning if isinstance(reasoning, str) else json.dumps(reasoning)
    answer = r["answer"]

    # ---- the agent's answer: sentinel, pair, ranked list, or neither
    sentinel = isinstance(answer, str) and normalize_scalar(answer) == SENTINEL
    pair: Optional[Pair] = None
    ranked: Optional[list[Pair]] = None
    if not sentinel:
        if isinstance(answer, dict) and "ranked" in answer:
            ranked = normalize_ranked(answer, loci)
            if ranked is None:
                return _malformed(base, stated, raised, expected_flags)
            if len(ranked) == 1:                       # §8.3: a one-entry list is a pair
                pair, ranked = ranked[0], None
        else:
            pair = normalize_pair(answer, loci)
            if pair is None:
                return _malformed(base, stated, raised, expected_flags)

    # ---- the truth: sentinel, one pair, or a set of pairs
    canonical = ans_spec["canonical"]
    truth_pair: Optional[Pair] = None
    truth_set: Optional[set[Pair]] = None
    if isinstance(canonical, dict) and "ranked" in canonical:
        truth_set = {normalize_pair(e, loci) for e in canonical["ranked"]}
        assert None not in truth_set, "task canonical ranked answer holds a non-pair"
    elif not isinstance(canonical, str):
        truth_pair = normalize_pair(canonical, loci)
        assert truth_pair is not None, "task canonical answer is not a haplotype pair"

    # ---- correctness (§4: exact, order-normalised; sets compared as sets)
    modes: list[str] = []
    if truth_set is not None:
        correct = ranked is not None and set(ranked) == truth_set
        if not correct:
            if sentinel:
                modes.append("refused")
            elif ranked is not None:
                modes.append("impossible_pair" if any(ctx.impossible(p) for p in ranked) else "phase_flip")
            elif ctx.impossible(pair):
                modes.append("impossible_pair")        # a single pair, even one of the two, is wrong
    elif truth_pair is not None:
        correct = pair == truth_pair
        if not correct:
            if sentinel:
                modes.append("refused")                # UNRESOLVABLE where a phase existed
            elif ranked is not None:
                if any(ctx.impossible(p) for p in ranked):
                    modes.append("impossible_pair")
                if truth_pair in ranked:
                    modes.append("hedged_answer")      # the truth, hedged with others
                elif "impossible_pair" not in modes:
                    modes += ctx.wrong_pair_modes(ranked[0], truth_pair)
            else:
                modes += ctx.wrong_pair_modes(pair, truth_pair)
    else:
        correct = sentinel                             # consistency_check: the sentinel is the answer
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


def oracle_response(task_full: dict) -> dict:
    """The generator's own answer in the response envelope: the canonical pair or sentinel,
    or — for a set task — the ``ranked`` form with equal probabilities (§8.3)."""
    a = task_full["answer"]
    answer = a["canonical"]
    if isinstance(answer, dict) and "ranked" in answer:
        n = len(answer["ranked"])
        answer = {"ranked": [{"haplotypes": e["haplotypes"], "probability": round(1 / n, 4)}
                             for e in answer["ranked"]]}
    return {"answer": answer, "confidence": a["expected_confidence"], "flags": list(a["expected_flags"]),
            "reasoning": ""}
