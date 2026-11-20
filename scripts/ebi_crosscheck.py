"""Cross-check HLA-B leader matching against EBI's public HLA Matching API (#184).

Runs a fixed set of recipient/donor HLA-B pairs through our engine (`sci_envs.service.lab.compat`,
the Python oracle the Worker's /v1/compat is held to by the golden tests, so no anonymous quota is
spent) and through EBI's `b_leader` endpoint, and records agree/disagree per pair in
docs/ebi-crosscheck.md. A disagreement is a defect to triage in the next evaluation, not something
this script hides.

Three comparisons per pair:
  allele_leaders  the -21 M/T residue of every allele, ours vs EBI's `b_leader` per allele
  genotype_match  do recipient and donor carry the same leader genotype (as a multiset)? EBI's
                  Matched/Mismatched answers exactly that; ours is derived from `b_leader.recipient`
                  and `.donor`
  leader_match    our Petersdorf 2020 verdict (a single HLA-B mismatch whose leaders match),
                  only where we give one; where it is null we make no claim and it is not a
                  disagreement

DPB1 T-cell-epitope matching is not part of /v1/compat (it answers HLA-B leader and KIR ligand), so
there is nothing of ours to compare EBI's DPB1 TCE API with; the report says so.

Only EBI's public endpoint is used, one request a second, identified with the tower-ops agent.
Needs the reference cache and network access. Usage: python scripts/ebi_crosscheck.py [--out FILE]
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

EBI_URL = "https://www.ebi.ac.uk/cgi-bin/ipd/matching/b_leader"
USER_AGENT = "tower-ops/1 (+https://hlaverify.com)"
DELAY_S = 1.0

# (recipient B pair, donor B pair). The alleles span M and T leaders; the pairs cover each leader
# genotype (M/M, M/T, T/T) on each side, single and double mismatches, identical typings, swapped
# order, a homozygous side, and a single-mismatch pair with and without a leader match.
PAIRS = [
    (("B*07:02", "B*57:01"), ("B*07:02", "B*44:02")),   # one mismatch, leaders match
    (("B*07:02", "B*57:01"), ("B*07:02", "B*08:01")),   # one mismatch, leaders differ
    (("B*07:02", "B*57:01"), ("B*44:02", "B*08:01")),   # two mismatches, same leader genotype
    (("B*07:02", "B*44:02"), ("B*07:02", "B*44:02")),   # identical
    (("B*07:02", "B*44:02"), ("B*44:02", "B*07:02")),   # identical, order swapped
    (("B*07:02", "B*07:02"), ("B*07:02", "B*44:02")),   # homozygous recipient, leader differs
    (("B*07:02", "B*08:01"), ("B*07:02", "B*08:01")),   # M/M identical
    (("B*07:02", "B*08:01"), ("B*07:02", "B*40:01")),   # M/M recipient, one mismatch
    (("B*44:02", "B*57:01"), ("B*44:02", "B*35:01")),   # one mismatch
    (("B*44:02", "B*57:01"), ("B*44:03", "B*58:01")),   # two mismatches
    (("B*15:01", "B*35:01"), ("B*15:01", "B*51:01")),   # one mismatch
    (("B*15:02", "B*07:02"), ("B*15:02", "B*35:01")),   # EBI's own example
    (("B*27:05", "B*44:02"), ("B*27:05", "B*07:02")),
    (("B*13:02", "B*38:01"), ("B*13:02", "B*39:01")),
    (("B*18:01", "B*49:01"), ("B*18:01", "B*50:01")),
    (("B*14:02", "B*52:01"), ("B*14:02", "B*55:01")),
    (("B*41:02", "B*45:01"), ("B*41:02", "B*47:01")),
    (("B*07:02", "B*57:01"), ("B*35:01", "B*08:01")),
    (("B*08:01", "B*08:01"), ("B*08:01", "B*57:01")),   # homozygous recipient
    (("B*56:01", "B*07:02"), ("B*56:01", "B*44:02")),
    (("B*81:01", "B*73:01"), ("B*81:01", "B*07:02")),
]


def ebi_query(recipient, donor, fetch=None):
    """EBI's b_leader answer for one pair: per-allele leaders for each side and the overall result."""
    qs = urllib.parse.urlencode({
        "pid": "1", "patb1": recipient[0].split("*")[1], "patb2": recipient[1].split("*")[1],
        "did": "2", "donb1": donor[0].split("*")[1], "donb2": donor[1].split("*")[1]}, safe=":")
    url = f"{EBI_URL}?{qs}"
    if fetch is None:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    else:
        body = fetch(url)
    root = body["HLA-B_leader"]
    don = root["donors"][0]
    return {"recipient": {_bare(a["allele"]): a["b_leader"].strip() for a in root["patient"]["gene"]["HLA-B"]},
            "donor": {_bare(a["allele"]): a["b_leader"].strip() for a in don["gene"]["HLA-B"]},
            "result": don["result"]["b_leader"].strip()}


def _bare(name):
    name = name.strip()
    return name[4:] if name.startswith("HLA-") else name


def our_answer(ref, pf, lab, recipient, donor):
    """Our engine's view of one pair: per-allele -21 residue, the genotypes, and the leader verdict."""
    c = lab.compat(ref, pf, {"B": list(recipient)}, {"B": list(donor)})
    per_allele = {n: (lab.ligands(ref, pf, n) or {}).get("leader_21") for n in set(recipient) | set(donor)}
    b = c["b_leader"]
    return {"alleles": per_allele, "recipient": b["recipient"], "donor": b["donor"],
            "leader_match": b["leader_match"], "b_mismatches": b["b_mismatches"]}


def _genotype(s):
    return sorted(s.split("/")) if s else None


def compare(ours, ebi, recipient, donor):
    """Per-pair verdicts: each of allele_leaders / genotype_match / leader_match is 'agree',
    'disagree' or 'no_claim' (we answer null, so there is nothing to compare)."""
    theirs = {**ebi["recipient"], **ebi["donor"]}
    leaders_ok = all(ours["alleles"].get(n) == theirs.get(n) for n in set(recipient) | set(donor))
    out = {"allele_leaders": "agree" if leaders_ok else "disagree"}
    rg, dg = _genotype(ours["recipient"]), _genotype(ours["donor"])
    ebi_match = ebi["result"] == "Matched"
    if rg is None or dg is None or any(x not in ("M", "T") for x in rg + dg):
        out["genotype_match"] = "no_claim"
    else:
        out["genotype_match"] = "agree" if (rg == dg) == ebi_match else "disagree"
    if ours["leader_match"] is None:
        out["leader_match"] = "no_claim"
    else:
        out["leader_match"] = "agree" if ours["leader_match"] == ebi_match else "disagree"
    return out


def run(fetch=None, pairs=PAIRS, sleep=time.sleep):
    from sci_envs.service import lab
    from sci_envs.service.app import ref as app_ref
    ref = app_ref()
    pf = lab.get_protein_facts(ref)
    rows = []
    for rec, don in pairs:
        ours = our_answer(ref, pf, lab, rec, don)
        ebi = ebi_query(rec, don, fetch)
        rows.append({"recipient": list(rec), "donor": list(don), "ours": ours, "ebi": ebi,
                     "verdicts": compare(ours, ebi, rec, don)})
        sleep(DELAY_S)
    return ref.release, rows


CHECKS = ("allele_leaders", "genotype_match", "leader_match")


def render(release, rows, when):
    tally = {c: {"agree": 0, "disagree": 0, "no_claim": 0} for c in CHECKS}
    for r in rows:
        for c in CHECKS:
            tally[c][r["verdicts"][c]] += 1
    bad = [r for r in rows if "disagree" in r["verdicts"].values()]
    lines = [
        "# HLA-B leader cross-check against EBI's HLA Matching API", "",
        f"Run {when} against IPD-IMGT/HLA {release} (ours) and EBI's live `b_leader` endpoint "
        f"(`{EBI_URL}`), {len(rows)} fixed pairs from `scripts/ebi_crosscheck.py`. Generated; do not hand edit.", "",
        "Ours is `lab.compat`, the oracle the Worker's `/v1/compat` is tested against. `no_claim` means our "
        "`leader_match` is null (not a single HLA-B mismatch), which is not a disagreement.", "",
        "| check | agree | disagree | no claim |", "|---|---|---|---|"]
    lines += [f"| {c} | {t['agree']} | {t['disagree']} | {t['no_claim']} |" for c, t in tally.items()]
    lines += ["", f"**{len(bad)} pair(s) disagree.**" if bad else "**No disagreements.**", "",
              "| recipient | donor | ours (rec / donor) | EBI | allele leaders | genotype | leader_match |",
              "|---|---|---|---|---|---|---|"]
    for r in rows:
        v, o = r["verdicts"], r["ours"]
        lines.append(f"| {' '.join(r['recipient'])} | {' '.join(r['donor'])} | {o['recipient']} / {o['donor']} "
                     f"(leader_match {o['leader_match']}) | {r['ebi']['result']} | {v['allele_leaders']} | "
                     f"{v['genotype_match']} | {v['leader_match']} |")
    lines += ["", "## DPB1 T-cell-epitope matching", "",
              "EBI also publishes a DPB1 TCE API. `/v1/compat` does not compute TCE groups (it answers HLA-B leader "
              "and KIR ligand), so there is no verdict of ours to compare; the check starts when a DPB1 TCE rule "
              "exists in the engine.", ""]
    return "\n".join(lines), len(bad)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/ebi-crosscheck.md")
    args = ap.parse_args(argv)
    release, rows = run()
    text, bad = render(release, rows, datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%MZ"))
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"{len(rows)} pairs, {bad} disagreeing; wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
