"""Reference solution: vendored loader + normalization rules, no network, no package install."""
import csv, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from imgt import ImgtReference
from normalize import normalize

ref = ImgtReference(tag="v3.65.0-alpha", root=Path("/app/imgt"))
rows = list(csv.DictReader(open("/app/data/typing_reports.csv", newline="")))
out = [{"sample_id": r["sample_id"], "locus": r["locus"], **normalize(ref, r["typing_as_reported"])} for r in rows]
with open("/app/results/normalized.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["sample_id", "locus", "allele_2field", "g_group", "flags"])
    w.writeheader(); w.writerows(out)
print(f"wrote {len(out)} rows")
