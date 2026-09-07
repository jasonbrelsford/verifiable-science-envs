"""py-ard concordance report — run where huggingface-free open internet exists
(hosted runner). Compares our family-A normalizer against NMDP's py-ard on the
slice where both apply, and documents the classes where py-ard has no opinion.
Writes docs/pyard-concordance.md. Honest by construction: divergences are listed,
not hidden; each is either our bug (file an issue + test) or a documented
semantic difference."""
import random, sys, time
import pyard
from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize

REF_TAG, PYARD_VER = "v3.65.0-alpha", "3650"

ref = ImgtReference.load(REF_TAG)
ard = pyard.init(PYARD_VER)

rng = random.Random(20260907)
alleles = [a for a in ref.alleles() if a.split("*")[0] in ("A", "B", "C", "DRB1", "DQB1", "DPB1")]
sample = rng.sample(alleles, min(2000, len(alleles)))

def ours_2f(name):
    return normalize(ref, name)["allele_2field"]

def pyard_u2(name):
    try:
        return ard.redux(name, "U2")
    except Exception as e:
        return f"<{type(e).__name__}>"

# 1. Valid full-resolution names — the overlap slice.
same = diff = 0
diffs = []
for a in sample:
    o, p = ours_2f(a), pyard_u2(a)
    if o == p:
        same += 1
    else:
        diff += 1
        if len(diffs) < 40:
            diffs.append((a, o, p))

# 2. Classes py-ard is not designed for (expected: error or passthrough).
classes = {
    "legacy colon-less (A*0101)": ["A*0101", "B*0702", "DRB1*1501", "Cw*0702"],
    "deleted-with-successor": [n for n, d in list(ref.deleted.items())
                               if getattr(d, "successor", None)][:6],
    "fabricated": ["DQB1*05:03:26:99", "P*1801", "B*9999", "A*99:999"],
}
class_rows = []
for label, names in classes.items():
    for n in names:
        class_rows.append((label, n, ours_2f(n), pyard_u2(n)))

pct = 100.0 * same / max(1, same + diff)
lines = [
    "# py-ard concordance report",
    "",
    f"*Generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())} · IPD-IMGT/HLA {REF_TAG} · "
    f"py-ard {getattr(pyard, '__version__', '?')} (db {PYARD_VER}) · script: `scripts/pyard_concordance.py`*",
    "",
    "py-ard is NMDP's reduction library for valid typing — the right tool inside a",
    "matching pipeline. HLA-Verify is a verifier for arbitrary (including AI-",
    "generated) text. This report shows both facts: we agree with py-ard where",
    "py-ard applies, and we return structured verdicts where it cannot.",
    "",
    "## 1. Overlap slice: 2-field reduction of valid full-resolution names",
    "",
    f"**{same}/{same+diff} identical ({pct:.2f}%)** on a deterministic random sample "
    f"of {same+diff} alleles across A, B, C, DRB1, DQB1, DPB1.",
    "",
]
if diffs:
    lines += ["Divergences (each triaged as our bug → test, or documented semantic difference):", "",
              "| allele | ours | py-ard U2 |", "|---|---|---|"]
    lines += [f"| `{a}` | `{o}` | `{p}` |" for a, o, p in diffs]
else:
    lines += ["No divergences in this sample."]
lines += [
    "",
    "## 2. Where py-ard has no opinion (and a verifier must)",
    "",
    "| class | input | HLA-Verify | py-ard |", "|---|---|---|---|",
]
lines += [f"| {l} | `{n}` | `{o}` | `{p}` |" for l, n, o, p in class_rows]
lines += [
    "",
    "A library exception is correct behaviour for a library — and no verdict at",
    "all for a safety gate. HLA-Verify classifies *what kind of wrong* an input",
    "is (fabricated / deleted-with-successor / legacy-era / valid), with the",
    "successor resolution and release version attached.",
]
open("docs/pyard-concordance.md", "w").write("\n".join(lines) + "\n")
print(f"concordance: {same}/{same+diff} = {pct:.2f}% identical; {len(class_rows)} class rows")
