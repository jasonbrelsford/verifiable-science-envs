"""Verifier: /root/normalized.csv must match expected.csv exactly on every row."""
import csv, sys
from pathlib import Path

OUT = Path("/root/normalized.csv")
EXP = Path(__file__).with_name("expected.csv")
COLS = ["sample_id", "locus", "allele_2field", "g_group", "flags"]

if not OUT.exists():
    print("FAIL: /root/normalized.csv not found"); sys.exit(1)
with open(OUT, newline="") as fh:
    got = list(csv.DictReader(fh))
with open(EXP, newline="") as fh:
    exp = list(csv.DictReader(fh))
if got and list(got[0].keys()) != COLS:
    print(f"FAIL: columns {list(got[0].keys())} != {COLS}"); sys.exit(1)
if len(got) != len(exp):
    print(f"FAIL: {len(got)} rows, expected {len(exp)}"); sys.exit(1)
ok = 0; bad = []
for g, e in zip(got, exp):
    match = all((g.get(c) or "").strip() == e[c] for c in COLS)
    ok += match
    if not match and len(bad) < 15:
        bad.append((e["sample_id"], {c: (g.get(c), e[c]) for c in COLS if (g.get(c) or "").strip() != e[c]}))
print(f"rows correct: {ok}/{len(exp)} ({100*ok/len(exp):.1f}%)")
for sid, diff in bad:
    print(f"  {sid}: {diff}")
sys.exit(0 if ok == len(exp) else 1)
