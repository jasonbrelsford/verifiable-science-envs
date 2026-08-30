"""Verifier: /app/results/normalized.csv must match the rebuilt expected.csv on every row."""
import csv
from pathlib import Path

OUT = Path("/app/results/normalized.csv")
EXP = Path(__file__).with_name("expected.csv")
COLS = ["sample_id", "locus", "allele_2field", "g_group", "flags"]


def _load(p):
    with open(p, newline="") as fh:
        return list(csv.DictReader(fh))


def test_output_exists():
    assert OUT.exists(), "/app/results/normalized.csv not found"


def test_columns_and_row_count():
    got, exp = _load(OUT), _load(EXP)
    assert list(got[0].keys()) == COLS, f"columns {list(got[0].keys())} != {COLS}"
    assert len(got) == len(exp) == 200


def test_every_row_matches():
    got, exp = _load(OUT), _load(EXP)
    bad = []
    for g, e in zip(got, exp):
        diff = {c: (g.get(c), e[c]) for c in COLS if (g.get(c) or "").strip() != e[c]}
        if diff:
            bad.append((e["sample_id"], diff))
    print(f"rows correct: {len(exp) - len(bad)}/{len(exp)}")
    for sid, diff in bad[:20]:
        print(f"  {sid}: {diff}")
    assert not bad, f"{len(bad)} rows differ"
