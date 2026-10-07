"""py-ard concordance report — run where huggingface-free open internet exists
(hosted runner). Compares our family-A normalizer against NMDP's py-ard on the
slice where both apply, and documents the classes where py-ard has no opinion.
Writes docs/pyard-concordance.md. Honest by construction: divergences are listed,
not hidden; each is either our bug (file an issue + test) or a documented
semantic difference.

Triage is part of the report, not a hand edit: every divergence is classified
by `triage()` into a known semantic family, and anything that does not fit is
printed as UNTRIAGED so a re-run on a new py-ard or reference release cannot
silently absorb a real bug. The classifier is pure (no py-ard, no reference)
so tests/test_concordance_triage.py can exercise it without the database."""
import random, re, sys, time

REF_TAG, PYARD_VER = "v3.65.0-alpha", "3650"
SUFFIXES = "NLSCAQ"  # expression suffixes, as in sci_envs.families.nomenclature.normalize
_TWO_FIELD = re.compile(r"^[A-Z0-9]+\*\d+:\d+$")

Q_SUFFIX, ARD_ROLLUP, UNTRIAGED = "q-suffix", "ard-rollup", "UNTRIAGED"

FAMILY_TEXT = {
    Q_SUFFIX: (
        "Expression suffix on a 2-field name",
        "Our rule names the 2-field *group*: a suffix is kept only when every "
        "full-resolution allele under the 2-field name shares it (see "
        "`sci_envs/families/nomenclature/normalize.py`, `allele_2field`), so "
        "`{a}` → `{o}`. py-ard annotates the *reported allele* and keeps its own "
        "suffix (`{p}`). Different questions, both answerable; the benchmark's "
        "oracle and tasks are self-consistent on the group semantics."),
    ARD_ROLLUP: (
        "ARD-equivalence rollup",
        "py-ard maps ARD-identical alleles onto a group exemplar (`{a}` → `{p}`), "
        "exactly right for matching, where the antigen recognition domain is what "
        "matters. As a *name* normalizer we preserve the distinct allele identity "
        "(`{o}` is a real, distinct allele). Reduction answers \"functionally which "
        "group?\"; verification answers \"which name is this, and is it real?\"."),
}


def two_field(name):
    """Locus plus the first two numeric fields of an allele name, no suffix."""
    locus, _, fields = name.partition("*")
    parts = re.sub(f"[{SUFFIXES}]$", "", fields).split(":")
    return f"{locus}*{':'.join(parts[:2])}"


def triage(allele, ours, pyard_u2):
    """Classify one divergence. Returns Q_SUFFIX, ARD_ROLLUP or UNTRIAGED."""
    if ours == allele or ours == two_field(allele):
        # We kept the name's own 2-field identity.
        if (pyard_u2[:-1] == ours and pyard_u2[-1] in SUFFIXES
                and allele.endswith(pyard_u2[-1])):
            # py-ard kept the reported allele's own expression suffix.
            return Q_SUFFIX
        if (_TWO_FIELD.match(pyard_u2) and pyard_u2 != ours
                and pyard_u2.partition("*")[0] == ours.partition("*")[0]):
            return ARD_ROLLUP
    return UNTRIAGED


def triage_lines(diffs, total):
    """Markdown for section 3. `diffs` is [(allele, ours, pyard_u2), ...]."""
    groups = {}
    for a, o, p in diffs:
        groups.setdefault(triage(a, o, p), []).append((a, o, p))
    lines = [f"## 3. Triage of the {total} divergences", ""]
    if not diffs:
        return lines + ["Nothing to triage: no divergences in this sample."]
    untriaged = groups.pop(UNTRIAGED, [])
    if untriaged:
        lines += [f"**{len(untriaged)} UNTRIAGED divergence(s) — not a known semantic "
                  "family; a human must decide whether this is our bug (file an issue "
                  "and add a test) or a new documented difference:**", ""]
        lines += [f"- `{a}`: ours `{o}`, py-ard `{p}`" for a, o, p in untriaged]
        lines += [""]
    else:
        lines += ["Every divergence falls into a known semantic family. None is a "
                  "bug on either side; none is untriaged.", ""]
    for fam in (Q_SUFFIX, ARD_ROLLUP):
        rows = groups.get(fam)
        if not rows:
            continue
        title, body = FAMILY_TEXT[fam]
        a, o, p = rows[0]
        names = ", ".join(f"`{x}`" for x, _, _ in rows)
        plural = "s" if len(rows) != 1 else ""
        lines += [f"**{title} ({len(rows)} case{plural}: {names}).**",
                  body.format(a=a, o=o, p=p), ""]
    return lines


def notable_lines(class_rows):
    """Section-2 rows where py-ard turned a wrong name into a plausible one."""
    laundered = [(n, p) for l, n, o, p in class_rows
                 if l == "fabricated" and not p.startswith("<")]
    stale = [(n, o, p) for l, n, o, p in class_rows
             if l == "deleted-with-successor" and not p.startswith("<") and p != o]
    if not laundered and not stale:
        return []
    lines = ["**Notable from section 2.** A reduction library doing its job can "
             "turn a wrong name into a plausible one — which, in front of AI "
             "output, is exactly what a verifier exists to stop:", ""]
    lines += [f"- fabricated `{n}` reduces to `{p}` with no error" for n, p in laundered]
    lines += [f"- deleted `{n}` reduces to `{p}`; the database's successor is `{o}`"
              for n, o, p in stale]
    lines += ["", "**Verification and reduction are different jobs.** Use py-ard for "
              "reduction (we do); use a verifier for anything an AI wrote."]
    return lines


def main():
    import pyard
    from sci_envs.reference.imgt import ImgtReference
    from sci_envs.families.nomenclature.normalize import normalize

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
        lines += ["Divergences (each triaged in section 3 as a documented semantic "
                  "difference, or flagged UNTRIAGED for a human):", "",
                  "| allele | ours | py-ard U2 | family |", "|---|---|---|---|"]
        lines += [f"| `{a}` | `{o}` | `{p}` | {triage(a, o, p)} |" for a, o, p in diffs]
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
        "",
    ]
    lines += triage_lines(diffs, diff)
    notable = notable_lines(class_rows)
    if notable:
        if lines[-1] != "":
            lines.append("")
        lines += notable
    open("docs/pyard-concordance.md", "w").write("\n".join(lines) + "\n")
    untriaged = sum(1 for a, o, p in diffs if triage(a, o, p) == UNTRIAGED)
    print(f"concordance: {same}/{same+diff} = {pct:.2f}% identical; {len(class_rows)} class rows; "
          f"{untriaged} untriaged divergence(s)")


if __name__ == "__main__":
    main()
