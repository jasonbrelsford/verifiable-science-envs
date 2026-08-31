"""Run a model over a suite split, grade every response, write results.

Layout under ``<suite_dir>``:
  manifest.json, dev/*.agent.json, full/*.full.json   (from the generator)
  responses/<model>/<task_id>.json                     (raw model output; gitignored)
  scores/<model>.json                                  (per-task Score + summary; gitignored)
  results/<model>.json                                 (summary only; committed → feeds the bench page)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.grade import grade, summarize, Score
from sci_envs.families.nomenclature.task import dumps
from . import models as M


def load_suite(suite_dir: str | Path, split: str = "dev") -> tuple[dict, dict[str, dict]]:
    suite = Path(suite_dir)
    manifest = json.loads((suite / "manifest.json").read_text())
    full = {}
    for f in sorted((suite / "full").glob("*.full.json")):
        t = json.loads(f.read_text())
        if split == "all" or t["scorer_notes"].get("split") == split:
            full[t["task_id"]] = t
    if not full and split == "dev":
        # sealed split absent (e.g. a fresh clone): fall back to the committed agent files, which can't be graded
        raise SystemExit("no full/*.full.json found — regenerate the suite first: python -m sci_envs.families.nomenclature.generate")
    return manifest, full


def _agent_view(t: dict) -> dict:
    return {k: v for k, v in t.items() if k not in ("answer", "scorer_notes")}


def run_model(model, full: dict[str, dict], ref: ImgtReference, suite_dir: Path, split: str,
              limit: Optional[int] = None, verbose: bool = True) -> tuple[list[Score], dict]:
    safe = model.name.replace("/", "__").replace(":", "_")   # ":" is illegal in Windows paths (ollama/qwen2.5:7b)
    rdir = suite_dir / "responses" / safe
    rdir.mkdir(parents=True, exist_ok=True)
    scores: list[Score] = []
    ids = list(full)[:limit] if limit else list(full)
    t0 = time.time()
    for i, tid in enumerate(ids, 1):
        t = full[tid]
        rfile = rdir / f"{tid}.json"
        if rfile.exists():
            raw = json.loads(rfile.read_text())["raw"]
        else:
            try:
                raw = model.answer(_agent_view(t))
            except Exception as e:  # keep going; the grader will record malformed_response
                raw = f"ERROR: {e}"
            rfile.write_text(dumps({"task_id": tid, "model": model.name, "raw": raw}))
        s = grade(t, raw, ref)
        scores.append(s)
        if verbose and (i % 25 == 0 or i == len(ids)):
            acc = sum(x.correct for x in scores) / len(scores)
            print(f"  {model.name}: {i}/{len(ids)} acc={acc:.3f} halluc={sum(bool(x.hallucinated_names) for x in scores)} ({time.time()-t0:.0f}s)", file=sys.stderr)
    summary = summarize(scores)
    summary.update({"model": model.name, "split": split, "benchmark": json.loads((suite_dir / "manifest.json").read_text())["benchmark"],
                    "n_tasks": len(ids), "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "prompt_rev": M.PROMPT_REV})  # bare-JSON clamp revision for hosted API models
    (suite_dir / "scores").mkdir(exist_ok=True)
    (suite_dir / "results").mkdir(exist_ok=True)
    (suite_dir / "scores" / f"{safe}.{split}.json").write_text(dumps({"summary": summary, "scores": [s.to_dict() for s in scores]}))
    (suite_dir / "results" / f"{safe}.{split}.json").write_text(dumps(summary))
    # A small, committable sample of wrong answers so grader strictness can be audited without the raw dump.
    logs = suite_dir.parent.parent / "logs"      # top-level logs/ is what workflows commit
    logs.mkdir(parents=True, exist_ok=True)
    # Stratified: up to 3 wrong answers per subtype, so every subtype's failure shape is visible.
    per: dict[str, int] = {}
    sample = []
    for tid, s in zip(ids, scores):
        if s.correct or per.get(s.subtype, 0) >= 3:
            continue
        per[s.subtype] = per.get(s.subtype, 0) + 1
        raw = json.loads((rdir / f"{tid}.json").read_text())["raw"]
        sample.append({"task_id": tid, "subtype": s.subtype, "input": full[tid]["input"],
                       "canonical": full[tid]["answer"]["canonical"], "raw": raw if isinstance(raw, str) else json.dumps(raw),
                       "primary_failure_mode": s.primary_failure_mode, "hallucinated": s.hallucinated_names})
    (logs / f"{suite_dir.name}.{safe}.{split}.wrong-sample.json").write_text(dumps(sample))
    return scores, summary


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="hla-bench", description="Run models against HLA-Bench-A and grade them.")
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="(re)generate a suite from the pinned reference")
    g.add_argument("--tag", default="v3.65.0-alpha"); g.add_argument("--out", default=None)
    g.add_argument("--seed", type=int, default=None, help="base seed; a different seed gives a disjoint suite (e.g. a training split)")
    g.add_argument("--family", default="a", choices=["a", "c"], help="a = nomenclature (HLA-Bench-A), c = donor-recipient matching (HLA-Bench-C)")
    r = sub.add_parser("run", help="run one or more models")
    r.add_argument("models", nargs="+", help="baseline-naive-string | baseline-confident-guesser | baseline-cautious-abstainer | oracle | anthropic/<m> | openai/<m> | google/<m> | ollama/<m> (local, free)")
    r.add_argument("--suite", default="runs/hla-bench-a"); r.add_argument("--split", default="dev", choices=["dev", "test", "all"])
    r.add_argument("--limit", type=int); r.add_argument("--tag", default="v3.65.0-alpha")
    a = sub.add_parser("auto", help="run all baselines plus every API model whose key is in the environment")
    a.add_argument("--suite", default="runs/hla-bench-a"); a.add_argument("--split", default="dev", choices=["dev", "test", "all"])
    a.add_argument("--limit", type=int); a.add_argument("--tag", default="v3.65.0-alpha")
    rp = sub.add_parser("report", help="render bench/HLA-Bench-A.md from results/")
    rp.add_argument("--suite", default="runs/hla-bench-a"); rp.add_argument("--out", default="bench/HLA-Bench-A.md")
    args = p.parse_args(argv)

    if args.cmd == "generate":
        if args.family == "c":
            from sci_envs.families.matching.generate import generate_suite, write_suite
        else:
            from sci_envs.families.nomenclature.generate import generate_suite, write_suite
        ref = ImgtReference.load(args.tag)
        tasks, manifest = generate_suite(ref, **({"base_seed": args.seed} if args.seed else {}))
        write_suite(tasks, manifest, args.out or ("runs/hla-bench-c" if args.family == "c" else "runs/hla-bench-a"))
        print(json.dumps({k: manifest[k] for k in ("benchmark", "total", "split")}))
        return 0
    if args.cmd == "report":
        from .report import render
        out = render(Path(args.suite), Path(args.out))
        print(f"wrote {out}")
        return 0

    ref = ImgtReference.load(args.tag)
    suite_dir = Path(args.suite)
    manifest, full = load_suite(suite_dir, args.split)
    specs = args.models if args.cmd == "run" else list(M.BASELINES) + M.available_api_models()
    if args.cmd == "auto":
        print(f"running: {specs}", file=sys.stderr)
    for spec in specs:
        model = M.resolve(spec, full)
        scores, summary = run_model(model, full, ref, suite_dir, args.split, args.limit)
        o = summary["overall"]
        print(f"{model.name:40s} split={args.split:4s} n={o['n']:3d} acc={o['acc']:.3f} "
              f"halluc_tasks={summary['hallucination']['tasks_with_hallucinated_names']} calibrated={summary['calibration']['calibrated_fraction']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
