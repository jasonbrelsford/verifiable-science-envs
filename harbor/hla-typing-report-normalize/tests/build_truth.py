"""Rebuild the expected answer from the pinned reference + the published rules (run at verifier build time)."""
import argparse, csv, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from imgt import ImgtReference
from normalize import normalize

ap = argparse.ArgumentParser()
ap.add_argument("--imgt", required=True); ap.add_argument("--typing", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--selfcheck", action="store_true")
a = ap.parse_args()
ref = ImgtReference(tag="v3.65.0-alpha", root=Path(a.imgt))
ref.verify()
rows = list(csv.DictReader(open(a.typing, newline="")))
out = [{"sample_id": r["sample_id"], "locus": r["locus"], **normalize(ref, r["typing_as_reported"])} for r in rows]
if a.selfcheck:
    assert ref.release == "3.65.0", ref.release
    assert len(ref.alleles()) == 46652 and len(ref.deleted) == 288
    assert len(out) == 200
    assert normalize(ref, "A*01:01:01:02N") == {"allele_2field": "A*01:01", "g_group": "A*01:01:01G", "flags": "null_allele"}
    assert normalize(ref, "A*0105N")["flags"] == "deprecated_name;null_allele"
    assert normalize(ref, "A*99:999")["allele_2field"] == "UNRESOLVABLE"
    n_unres = sum(o["allele_2field"] == "UNRESOLVABLE" for o in out); assert 5 <= n_unres <= 30, n_unres
    n_dep = sum("deprecated_name" in o["flags"] for o in out); assert 40 <= n_dep <= 90, n_dep
with open(a.out, "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["sample_id", "locus", "allele_2field", "g_group", "flags"]); w.writeheader(); w.writerows(out)
print(f"expected.csv: {len(out)} rows")
