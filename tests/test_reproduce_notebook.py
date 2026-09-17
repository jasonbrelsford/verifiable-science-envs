"""The reproduction notebook must stay true to the artifacts it claims to verify.

`bench/reproduce.ipynb` is the public answer to "prove your numbers": it refetches the
committed run artifacts from a pinned commit and recomputes every published headline
figure. These tests run offline against the artifacts in this checkout, so the notebook
cannot drift away from them silently, and neither can the published claims it pins.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "bench" / "reproduce.ipynb"
RESULTS = ROOT / "runs" / "hla-bench-a" / "results"

# Scripted reference points, not language models: they are excluded from the published range.
SCRIPTED = {
    "baseline-naive-string",
    "baseline-confident-guesser",
    "baseline-cautious-abstainer",
    "oracle-reference",
}


def _source() -> str:
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code")


def _literal(name: str):
    """Pull a top-level literal assignment out of the notebook's code."""
    src = _source()
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {NOTEBOOK.name}")


def _artifacts() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(RESULTS.glob("*.json"))]


def test_notebook_is_valid_and_unexecuted():
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    assert nb["nbformat"] == 4
    for cell in nb["cells"]:
        if cell["cell_type"] == "code":
            assert cell["outputs"] == [], "commit the notebook without stored outputs"
            assert cell["execution_count"] is None


def test_pin_is_a_full_commit_sha():
    pin = _literal("PIN")
    assert re.fullmatch(r"[0-9a-f]{40}", pin), "pin a full 40-character SHA, never a branch"


def test_fallback_file_list_matches_the_committed_artifacts():
    assert sorted(_literal("FALLBACK")) == sorted(p.name for p in RESULTS.glob("*.json"))


def test_published_claims_match_the_artifacts():
    pub = _literal("PUBLISHED")
    rows = _artifacts()

    full = [d for d in rows if d["split"] == "all" and d["model"] not in SCRIPTED]
    rates = [d["hallucination"]["rate_per_task"] for d in full]

    assert pub["n_language_models"] == len(full)
    assert all(d["n"] == pub["suite_n"] for d in full)
    assert pub["fab_low"] == round(min(rates), 2)
    assert pub["fab_high"] == round(max(rates), 2)
    assert pub["fab_low_model"] == min(full, key=lambda d: d["hallucination"]["rate_per_task"])["model"]
    assert pub["fab_high_model"] == max(full, key=lambda d: d["hallucination"]["rate_per_task"])["model"]

    # The retracted range: 0.05 was a dev-split rate, 0.14 was never any model's rate.
    every_rate = {round(d["hallucination"]["rate_per_task"], 2) for d in rows}
    assert pub["retired_high_matches_nothing"] not in every_rate
    dev = next(d for d in rows if d["model"] == "ollama/qwen2.5:7b" and d["split"] == "dev")
    assert pub["retired_low_is_dev_only"] == round(dev["hallucination"]["rate_per_task"], 2)


def test_suite_sizes_match_the_manifest():
    pub = _literal("PUBLISHED")
    manifest = json.loads((ROOT / "runs" / "hla-bench-a" / "manifest.json").read_text())
    assert pub["suite_n"] == manifest["total"]
    assert pub["dev_n"] == manifest["split"]["dev"]


def test_expand_ambiguity_claim_holds_for_every_model():
    pub = _literal("PUBLISHED")
    for d in _artifacts():
        if d["split"] != "all":
            continue
        ea = d["by_subtype"]["expand_ambiguity"]
        assert ea["n"] == pub["expand_ambiguity_n_per_model"]
        if d["model"] == "oracle-reference":
            assert ea["correct"] == ea["n"], "the oracle must show the task is solvable"
        else:
            assert ea["correct"] == pub["expand_ambiguity_pct"] == 0


def test_claude_row_is_a_lower_bound():
    pub = _literal("PUBLISHED")
    d = json.loads((RESULTS / "anthropic__claude-sonnet-4-6.all.json").read_text())
    malformed = d["primary_failure_modes"]["malformed_response"]
    assert malformed == pub["claude_malformed"]
    assert pub["claude_rate_is_lower_bound"] is True
    # The grader attributes no fabricated names to a response it cannot parse, so those
    # tasks dilute the rate while still counting in the denominator.
    assert malformed > 0
    grader = (ROOT / "sci_envs" / "families" / "nomenclature" / "grade.py").read_text()
    assert "hallucinated_names=[]" in grader
    assert 'primary_failure_mode="malformed_response"' in grader
