"""Generate golden fixtures for the edge Worker from the Python oracle.

Every expected value is produced by the FastAPI service (verify / normalize /
allele, via TestClient) or by rules.score() (match) — the same code that grades
HLA-Bench.  The Node test in golden.test.mjs must reproduce every byte.

Run from the repository root:  python edge/test/gen_fixtures.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from sci_envs.reference.imgt import ImgtReference, split_allele  # noqa: E402
from sci_envs.families.matching.rules import FRAMEWORKS, score  # noqa: E402
from sci_envs.service.app import app  # noqa: E402

rng = random.Random(20260910)
client = TestClient(app)
r = ImgtReference.load("v3.65.0-alpha")
alleles = r.alleles()
by_locus: dict[str, list[str]] = {}
for a in alleles:
    by_locus.setdefault(split_allele(a)[0], []).append(a)


def prefixes(a: str, n: int) -> str:
    loc, f, _ = split_allele(a)
    return f"{loc}*{':'.join(f[:n])}"


def legacy_of(a: str) -> str:
    loc, f, suf = split_allele(a)
    loc = "Cw" if loc == "C" and rng.random() < 0.5 else loc
    return f"{loc}*{''.join(f[:2])}{suf}"


def fabricated(a: str) -> str:
    loc, f, suf = split_allele(a)
    f = list(f)
    k = rng.randrange(len(f))
    f[k] = f"{int(f[k]) + rng.choice([1, 7, 400]):0{len(f[k])}d}"
    if rng.random() < 0.3:
        f.append(f"{rng.randrange(10, 99)}")
    return f"{loc}*{':'.join(f[:4])}{suf}"


def pool() -> list[str]:
    p: list[str] = []
    p += rng.sample(alleles, 500)
    p += [prefixes(a, 1) for a in rng.sample(alleles, 80)]
    p += [prefixes(a, 2) for a in rng.sample(alleles, 300)]
    p += [prefixes(a, 3) for a in rng.sample(alleles, 200)]
    nulls = [a for a in alleles if a.endswith("N")]
    p += rng.sample(nulls, 120)
    p += [prefixes(a, 2) + "N" for a in rng.sample(nulls, 60)]
    p += [a for a in alleles if split_allele(a)[2] in "LSQ" and split_allele(a)[2]][:60]
    p += list(r.deleted.keys())
    hist_only = [n for n in r._name_index if not r.exists(n)]
    p += rng.sample(hist_only, 400)
    p += rng.sample(r.g_groups(), 60) + rng.sample(r.p_groups(), 60)
    p += [g[:-1] + "P" for g in rng.sample(r.g_groups(), 30)]      # often fabricated groups
    p += [prefixes(a, 2) + "G" for a in rng.sample(alleles, 40)]   # fabricated groups
    p += [fabricated(a) for a in rng.sample(alleles, 250)]
    p += [legacy_of(a) for a in rng.sample(alleles, 250)]
    p += ["HLA-" + a for a in rng.sample(alleles, 60)]
    p += ["HLA-" + prefixes(a, 2) for a in rng.sample(alleles, 30)]
    p += [f"DPB1*{n:04d}" for n in rng.sample(range(1000, 1100), 15)]
    p += ["notanallele", "A*1", "A*01:0", "a*01:01", "A*01:01:", "A*01:01:01:01:01", "B*99:99", "DQB1*99:99",
          "DQB1*05:03:26:99", "DQB1*05:03:01G", "A*01:34N", "A*0101", "DRB1*1406", "B*9999", "A*24:09N",
          "A*02:01", " A*02:01 ", "A*02:01\t", "HLA-DRB1*14:06", "C*07", "Cw*0702", "Cw*07", "MICA*091",
          "MICA*008:01", "DRB1*04:07:01", "KIR2DL1*001", "TAP1*01:01", "A*02:01:01:01N", "B*44:02:01:02S",
          "A*01:01:38L", "A*01:01:01:02N", "A*23:19Q"]
    rng.shuffle(p)
    return p


def verify_texts(p: list[str]) -> list[str]:
    seps = [" ", ", ", "; ", " and ", "\n", " / ", " (", ") ", ". ", ": ", "—", "→"]
    prose = ["Patient typing:", "Donor is", "The assistant suggested", "Report lists", "Consider", "vs", "not"]
    texts = []
    for _ in range(220):
        k = rng.randrange(1, 14)
        parts = []
        for _ in range(k):
            if rng.random() < 0.15:
                parts.append(rng.choice(prose))
            parts.append(rng.choice(p))
        s = ""
        for x in parts:
            s += x + rng.choice(seps)
        if rng.random() < 0.2:
            s = s.rstrip() + rng.choice([".", ")", "!", "é", "_x", "1", ":"])
        texts.append(s)
    texts += [
        "A*0101 and B*15:504:01 are fine; DQB1*05:03:26:99 and DQB1*99:99 are not; DQB1*05:03:01G is a group.",
        "old name A*01:34N in a report", "HLA-A*01:01 with DRB1*14:06",
        "Patient typing: A*0101, B*15:504:01, DRB1*14:06. Assistant suggested DQB1*05:03:26:99 (DQB1*05:03:01G).",
        "", "no alleles here", "HLA-A*02:01 and A*02:01 both appear", "A*02:01:01:01N A*02:01N", "(A*24:02) [B*07:02]",
    ]
    return texts


def typing_pool(locus: str) -> list[str]:
    al = by_locus.get(locus, [])
    if not al:
        return []
    out = []
    a = rng.choice(al)
    out.append(a)
    out.append(prefixes(rng.choice(al), 2))
    out.append(prefixes(rng.choice(al), 3) if len(split_allele(rng.choice(al))[1]) >= 3 else prefixes(rng.choice(al), 2))
    out.append(legacy_of(rng.choice(al)))
    nulls = [x for x in al if x.endswith("N")]
    if nulls:
        out.append(rng.choice(nulls))
        out.append(prefixes(rng.choice(nulls), 2))  # expressed-looking 2-field over a null
    dels = [d for d in r.deleted if d.startswith(locus + "*")]
    if dels:
        out.append(rng.choice(dels))
    hist = [n for n in r._name_index if n.startswith(locus + "*") and not r.exists(n)]
    if hist:
        out.append(rng.choice(hist[:400]))
    out.append(fabricated(rng.choice(al)))
    out.append(prefixes(rng.choice(al), 1))
    return out


def gen_matches() -> list[dict]:
    cases = []
    for f in sorted((ROOT / "runs/hla-bench-c/dev").glob("*.json")):
        t = json.loads(f.read_text(encoding="utf-8"))
        i = t["input"]
        cases.append({"framework": i["framework"], "recipient": i["recipient"], "donor": i["donor"]})
    for _ in range(320):
        fw = rng.choice(list(FRAMEWORKS))
        loci = [l for l, _ in FRAMEWORKS[fw]]
        rec, don = {}, {}
        base = {l: typing_pool(l) for l in loci}
        for l in loci:
            if rng.random() < 0.06:
                continue  # locus missing from one side
            pl = base[l]
            rec[l] = [rng.choice(pl), rng.choice(pl)]
            don[l] = [rng.choice(pl) if rng.random() < 0.6 else x for x in rec[l]]
            if rng.random() < 0.1:
                don[l] = don[l][:1]  # homozygous / single entry
            if rng.random() < 0.05:
                rec[l] = []
        if rng.random() < 0.1:
            rec["DQA1"] = ["DQA1*01:01", "DQA1*05:01"]
        cases.append({"framework": fw, "recipient": rec, "donor": don})
    out = []
    for c in cases:
        s = score(r, c["framework"], c["recipient"], c["donor"])
        out.append({"input": c, "expected": {
            "release": r.release, "framework": c["framework"], "count": s["count"],
            "verdicts": s["verdicts"], "hvg_mismatches": s["hvg_mismatches"],
            "gvh_mismatches": s["gvh_mismatches"], "flags": s["flags"]}})
    return out


# ------------------------------------------------------------ typing_check / compat

LOCI_MAIN = ["A", "B", "C", "DRB1"]
LOCI_EXTRA = ["DRB3", "DRB4", "DRB5", "DQA1", "DQB1", "DPA1", "DPB1"]


def random_typing() -> dict:
    typing: dict[str, list[str]] = {}
    for l in LOCI_MAIN:
        if rng.random() < 0.92:
            pl = typing_pool(l)
            if pl:
                n = rng.choice([1, 2, 2, 2, 3, 4])
                typing[l] = [rng.choice(pl) for _ in range(n)]
    for l in LOCI_EXTRA:
        if rng.random() < 0.3:
            pl = typing_pool(l)
            if pl:
                n = rng.choice([1, 1, 2])
                typing[l] = [rng.choice(pl) for _ in range(n)]
    if not typing:
        typing["A"] = [rng.choice(by_locus["A"])]

    # locus-mismatch: append a wrong-locus allele under an existing key
    if rng.random() < 0.15:
        keys = [k for k in typing if len(typing[k]) < 4]
        if keys:
            k = rng.choice(keys)
            others = [l for l in by_locus if l != k and by_locus[l]]
            if others:
                typing[k].append(rng.choice(by_locus[rng.choice(others)]))

    # legacy "Cw" key form
    if "C" in typing and rng.random() < 0.15:
        typing["Cw"] = typing.pop("C")
    # HLA- prefixed key
    if typing and rng.random() < 0.1:
        k = rng.choice(list(typing.keys()))
        typing["HLA-" + k] = typing.pop(k)
    return typing


def gen_typing_checks() -> list[dict]:
    out = []
    for _ in range(330):
        t = random_typing()
        resp = client.post("/v1/typing/check", json={"typing": t})
        out.append({"input": t, "status": resp.status_code, "expected": resp.json()})
    return out


def gen_compat_cases() -> list[dict]:
    out = []
    for _ in range(160):
        rec = random_typing()
        don = random_typing()
        resp = client.post("/v1/compat", json={"recipient": rec, "donor": don})
        out.append({"input": {"recipient": rec, "donor": don}, "status": resp.status_code, "expected": resp.json()})
    return out


# ------------------------------------------------------------------- glstring

def gl_tok(loc: str | None = None) -> str:
    a = rng.choice(by_locus[loc] if loc else alleles)
    if rng.random() < 0.12:
        a = legacy_of(a)
    if rng.random() < 0.1:
        a = "HLA-" + a
    return a


def gl_list(loc: str | None = None, n: int = 1) -> str:
    toks = [gl_tok(loc) for _ in range(n)]
    if rng.random() < 0.08:
        toks.insert(rng.randrange(len(toks) + 1), "")
    return "/".join(toks)


def gl_haplotype(loc: str | None = None, n_lists: int = 1) -> str:
    return "~".join(gl_list(loc, rng.choice([1, 1, 2])) for _ in range(n_lists))


def gl_genotype(loc: str | None = None, n_haps: int = 1) -> str:
    return "+".join(gl_haplotype(loc, rng.choice([1, 1, 2])) for _ in range(n_haps))


def gl_block(loc: str | None = None, n_genos: int = 1) -> str:
    return "|".join(gl_genotype(loc, rng.choice([1, 1, 2])) for _ in range(n_genos))


def gen_gl_strings() -> list[str]:
    out: list[str] = []
    # well-formed strings across every operator, single-locus per block
    for _ in range(110):
        loc = rng.choice(list(by_locus))
        out.append("^".join(gl_block(loc, rng.choice([1, 1, 2])) for _ in range(rng.choice([1, 1, 2]))))
    # mixed-locus "/" list (mixed_locus_allele_list)
    for _ in range(30):
        out.append(f"{gl_tok('A')}/{gl_tok('B')}")
    # haplotype repeats a locus (haplotype_repeats_locus)
    for _ in range(20):
        out.append(f"{gl_tok('A')}~{gl_tok('B')}~{gl_tok('A')}")
    # more than two haplotypes (more_than_two_haplotypes)
    for _ in range(15):
        out.append("+".join(gl_tok("A") for _ in range(rng.choice([3, 4, 5]))))
    # genotype pairs different loci (genotype_loci_differ)
    for _ in range(15):
        out.append(f"{gl_tok('A')}+{gl_tok('B')}")
    # genotype list loci differ across | (genotype_list_loci_differ)
    for _ in range(15):
        out.append(f"{gl_tok('A')}+{gl_tok('A')}|{gl_tok('B')}+{gl_tok('B')}")
    # locus repeated across ^ blocks (locus_repeated_across_blocks)
    for _ in range(15):
        out.append(f"{gl_tok('A')}^{gl_tok('A')}")
    # empty elements
    for _ in range(15):
        a = gl_tok("A")
        out.append(rng.choice([f"{a}/", f"/{a}", f"{a}//{a}", f"{a}/ /{a}"]))
    # internal whitespace in a token
    for _ in range(15):
        a = gl_tok("A")
        pos = rng.randrange(2, max(3, len(a) - 1))
        out.append(a[:pos] + " " + a[pos:])
    # legacy names (bare)
    for _ in range(15):
        out.append(legacy_of(rng.choice(alleles)))
    # HLA- prefixed
    for _ in range(10):
        out.append("HLA-" + rng.choice(alleles))
    # group names (real G/P groups)
    groups = r.g_groups() + r.p_groups()
    for _ in range(10):
        out.append(rng.choice(groups))
    # deleted names
    if r.deleted:
        for _ in range(10):
            out.append(rng.choice(list(r.deleted.keys())))
    # fabricated (unresolvable) names
    for _ in range(10):
        out.append(fabricated(rng.choice(alleles)))
    out += [
        "", "   ", "A*01:01", "notanallele", " A*02:01 ", "A*01:01/A*02:01",
        "HLA-A*01:01+HLA-A*02:01", "A*01:01~B*07:02", "A*01:01|B*07:02^C*01:02",
        "A*01:01/A*02:01+A*03:01~B*07:02", "A*01:01^A*01:01",
    ]
    rng.shuffle(out)
    return out


def gen_glstring_cases() -> list[dict]:
    out = []
    for gl in gen_gl_strings():
        resp = client.post("/v1/glstring", json={"gl": gl})
        out.append({"input": gl, "status": resp.status_code, "expected": resp.json()})
    return out


def main():
    p = pool()
    fx = {"release": r.release, "verify": [], "normalize": [], "allele": [], "match": [],
          "typing_check": [], "compat": [], "glstring": []}
    for text in verify_texts(p):
        resp = client.post("/v1/verify", json={"text": text})
        fx["verify"].append({"input": text, "status": resp.status_code, "expected": resp.json()})
    for i in range(0, len(p), 100):
        batch = p[i:i + 100]
        resp = client.post("/v1/normalize", json={"typings": batch})
        fx["normalize"].append({"input": batch, "status": resp.status_code, "expected": resp.json()})
    for name in rng.sample(p, 700):
        resp = client.get("/v1/allele/" + name)
        fx["allele"].append({"input": name, "status": resp.status_code, "expected": resp.json()})
    fx["match"] = gen_matches()
    fx["typing_check"] = gen_typing_checks()
    fx["compat"] = gen_compat_cases()
    fx["glstring"] = gen_glstring_cases()
    out = Path(__file__).with_name("fixtures.json")
    out.write_text(json.dumps(fx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print({k: len(v) for k, v in fx.items() if isinstance(v, list)}, "->", out, round(out.stat().st_size / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
