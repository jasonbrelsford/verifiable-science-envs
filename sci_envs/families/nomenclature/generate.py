"""Generators for family A — HLA allele nomenclature resolution.

Every generator is a pure function of (reference, rng). Task ids are
``{family}.T{tier}.{subtype}.{seed:04d}``; the suite builder is a pure function
of (tag, base_seed). See docs/TASK_SPEC.md §4–§5.
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Callable, Optional

from sci_envs.reference.imgt import (
    ImgtReference, LOCI_IN_SCOPE, split_allele, truncate, is_class_I,
)
from .task import Task, RESPONSE_CONTRACT, FAMILY, dumps

# --------------------------------------------------------------------------- config

# Assumed most-recent frontier-model training cutoff, expressed as an IMGT
# release: alleles added/renamed after this are the contamination-resistant
# slice. Recorded in the manifest; revisit each quarter.
CUTOFF_RELEASE = "3.58.0"       # ~Oct 2024
RECENT_RELEASE = "3.60.0"       # "added_since_3.60" slice
RENAME_WINDOW = "3.50.0"        # "renamed_since_3.50" slice

SECONDARY_CLASS_II = {"DRB3", "DRB4", "DRB5", "DPA1"}

TIER_OF = {
    "truncate": 1, "expand_ambiguity": 1, "valid_name": 1, "locus_field": 1,
    "g_group": 2, "p_group": 2, "same_group": 2, "group_members_count": 2, "serology": 2,
    "renamed_to": 3, "existed_at": 3, "first_release": 3, "name_at_release": 3,
    "deleted_reason": 3, "new_in_release": 3,
    "resolve_chain": 4, "typing_report_normalize": 4, "null_trap": 4, "near_miss": 4, "release_drift": 4,
}
COUNTS = {1: 30, 2: 30, 3: 30, 4: 20}   # per subtype, v0.1 (550 total)

REASON_CATEGORIES = ["identical_sequence", "renamed_extended", "named_in_error",
                     "low_expression_renamed", "suffix_changed", "never_assigned", "other"]


# --------------------------------------------------------------------------- sampling helpers

class Sampler:
    """Stratified allele sampling per TASK_SPEC §5: uniform over loci, then
    50% weight on Confirmed status / 50% uniform so rare alleles are
    over-represented. Optionally biases toward post-cutoff alleles."""

    def __init__(self, ref: ImgtReference, rng: random.Random):
        self.ref, self.rng = ref, rng
        pools = ref._cache.get("sampler_pools")
        if pools is None:
            by_locus = {l: ref.alleles(l) for l in LOCI_IN_SCOPE}
            unconfirmed = {l: [a for a in v if not ref.confirmed(a)] for l, v in by_locus.items()}
            ci = ref._rel_index(CUTOFF_RELEASE)
            _, table = ref._history
            post = {l: [] for l in LOCI_IN_SCOPE}
            for hid, row in table.items():
                cur = row[0]
                if cur and not row[ci]:
                    loc = cur.split("*")[0]
                    if loc in post:
                        post[loc].append(cur)
            pools = ref._cache["sampler_pools"] = (by_locus, unconfirmed, post)
        self._by_locus, self._unconfirmed, self._post_cutoff = pools

    def locus(self) -> str:
        return self.rng.choice(LOCI_IN_SCOPE)

    def allele(self, locus: Optional[str] = None, pred: Optional[Callable[[str], bool]] = None,
               post_cutoff_bias: float = 0.0, tries: int = 2000) -> str:
        for _ in range(tries):
            loc = locus or self.locus()
            r = self.rng.random()
            if post_cutoff_bias and r < post_cutoff_bias and self._post_cutoff[loc]:
                pool = self._post_cutoff[loc]
            elif self.rng.random() < 0.5:
                pool = self._unconfirmed[loc] or self._by_locus[loc]
            else:
                pool = self._by_locus[loc]
            a = self.rng.choice(pool)
            if pred is None or pred(a):
                return a
        raise RuntimeError("sampler exhausted")


def slices_for(ref: ImgtReference, allele: str) -> list[str]:
    out = []
    locus, fields, suffix = split_allele(allele)
    if suffix == "N":
        out.append("null_allele")
    elif suffix:
        out.append("expression_suffix")
    st = ref.status.get(allele)
    if st and not st.confirmed:
        out.append("unconfirmed")
    if st and st.partial:
        out.append("partial_sequence")
    hid = ref.name_to_id.get(allele)
    if hid:
        at_window = ref.name_at(hid, RENAME_WINDOW)
        if at_window and at_window != allele:
            out.append("renamed_since_3.50")
        if not ref.name_at(hid, RECENT_RELEASE):
            out.append("added_since_3.60")
        if not ref.name_at(hid, CUTOFF_RELEASE):
            out.append("post_cutoff")
    if locus in SECONDARY_CLASS_II:
        out.append("class_II_secondary_locus")
    return out


def expected_confidence(tier: int, slices: list[str], override: Optional[str] = None) -> str:
    if override:
        return override
    hard = {"unconfirmed", "partial_sequence", "null_allele", "expression_suffix", "post_cutoff", "added_since_3.60"}
    if tier == 3:
        return "medium"
    if tier in (1, 2):
        return "medium" if set(slices) & hard else "high"
    return "medium"


def legacy_form(allele2: str) -> Optional[str]:
    """A*02:01 -> A*0201; C*07:02 -> Cw*0702. Only when both fields are 2 digits."""
    locus, fields, suffix = split_allele(allele2)
    if len(fields) != 2 or any(len(f) != 2 for f in fields):
        return None
    loc = "Cw" if locus == "C" else locus
    return f"{loc}*{''.join(fields)}{suffix}"


def _mk(ref: ImgtReference, subtype: str, seed: int, instructions: str, inp: dict,
        canonical, accept: list, flags: list[str], slices: list[str],
        notes: dict, conf_override: Optional[str] = None) -> Task:
    tier = TIER_OF[subtype]
    return Task(
        task_id=f"{FAMILY}.T{tier}.{subtype}.{seed:04d}",
        tier=tier, subtype=subtype,
        reference={"db": "IPD-IMGT/HLA", "release": ref.release, "tag": ref.tag,
                   "md5": ref.manifest["md5"]["Allelelist.txt"]},
        instructions=f"Using IPD-IMGT/HLA release {ref.release}. {instructions} {RESPONSE_CONTRACT}",
        input=inp,
        answer={"canonical": canonical, "accept": accept,
                "expected_confidence": expected_confidence(tier, slices, conf_override),
                "expected_flags": sorted(set(flags))},
        slices=sorted(set(slices)), scorer_notes=notes,
    )


def _flags_for(slices: list[str]) -> list[str]:
    f = []
    if "null_allele" in slices:
        f.append("null_allele")
    if "expression_suffix" in slices:
        f.append("expression_suffix")
    if "unconfirmed" in slices:
        f.append("unconfirmed_allele")
    return f


# --------------------------------------------------------------------------- Tier 1

def gen_truncate(ref, s: Sampler, seed):
    a = s.allele(pred=lambda x: len(split_allele(x)[1]) >= 3)
    n = s.rng.choice([2, 2, 3]) if len(split_allele(a)[1]) == 4 else 2
    ans = ref.reduce(a, n)
    sl = slices_for(ref, a)
    return _mk(ref, "truncate", seed,
               f"Reduce the allele below to {n}-field resolution. Keep an expression suffix only if every "
               f"allele under the reduced name carries that same suffix.",
               {"allele": a, "fields": n}, ans, [ans], _flags_for(sl), sl, {"key": ref.hla_id(a)})


def gen_expand_ambiguity(ref, s: Sampler, seed):
    for _ in range(500):
        a = s.allele(pred=lambda x: len(split_allele(x)[1]) >= 3)
        p2 = truncate(a, 2, keep_suffix=False)
        n = len(ref.expand(p2))
        if n >= 2:
            break
    sl = slices_for(ref, a)
    return _mk(ref, "expand_ambiguity", seed,
               "How many distinct full allele names (including any with expression suffixes) fall under the "
               "2-field name below in this release? Answer with an integer.",
               {"allele": p2}, str(n), [str(n)], [], [x for x in sl if x == "class_II_secondary_locus"], {"key": p2})


def gen_valid_name(ref, s: Sampler, seed):
    kind = s.rng.choice(["valid", "valid", "legacy", "leading_zero", "nonexistent", "deleted"])
    a = s.allele()
    sl = slices_for(ref, a)
    if kind == "valid":
        q, ans, flags = a, "TRUE", _flags_for(sl)
    elif kind == "legacy":
        q = legacy_form(truncate(a, 2, keep_suffix=False)) or a.replace(":", "")
        ans, flags = "FALSE", ["deprecated_name"]
    elif kind == "leading_zero":
        locus, f, suf = split_allele(a)
        f[0] = f[0].lstrip("0") or "0"
        q = f"{locus}*{':'.join(f)}{suf}"
        if ref.exists(q):
            q = a + ":99"
        ans, flags = "FALSE", ["nonexistent_allele"]
    elif kind == "deleted":
        q = s.rng.choice(sorted(ref.deleted))
        ans, flags = "FALSE", ["deprecated_name"]
    else:
        locus, f, suf = split_allele(a)
        q = f"{locus}*{':'.join(f[:-1] + [str(int(f[-1]) + 500).zfill(2)])}"
        while ref.exists(q):
            q += "9"
        ans, flags = "FALSE", ["nonexistent_allele"]
    return _mk(ref, "valid_name", seed,
               "Is the string below a valid, currently assigned allele name in this release, spelled exactly "
               "in current nomenclature? Answer TRUE or FALSE.",
               {"name": q}, ans, [ans], flags, sl if kind == "valid" else [], {"key": q, "kind": kind})


def gen_locus_field(ref, s: Sampler, seed):
    a = s.allele()
    locus = split_allele(a)[0]
    ans = f"{locus}:{'I' if is_class_I(locus) else 'II'}"
    sl = slices_for(ref, a)
    return _mk(ref, "locus_field", seed,
               "Give the locus and HLA class of the allele below, formatted exactly as LOCUS:CLASS "
               "(e.g. DQB1:II or A:I).",
               {"allele": a}, ans, [ans], [], [x for x in sl if x == "class_II_secondary_locus"], {"key": ref.hla_id(a)})


# --------------------------------------------------------------------------- Tier 2

def gen_g_group(ref, s: Sampler, seed):
    a = s.allele()
    g = ref.g_group(a)
    ans = g or "NONE"
    sl = slices_for(ref, a)
    return _mk(ref, "g_group", seed,
               "Give the G group of the allele below, or NONE if it is not a member of any G group in this release.",
               {"allele": a}, ans, [ans], _flags_for(sl), sl, {"key": ref.hla_id(a)})


def gen_p_group(ref, s: Sampler, seed):
    a = s.allele()
    p = ref.p_group(a)
    ans = p or "NONE"
    sl = slices_for(ref, a)
    return _mk(ref, "p_group", seed,
               "Give the P group of the allele below, or NONE if it is not a member of any P group in this release "
               "(null alleles have no P group).",
               {"allele": a}, ans, [ans], _flags_for(sl), sl, {"key": ref.hla_id(a)})


def gen_same_group(ref, s: Sampler, seed):
    kind = s.rng.choice(["G", "P"])
    a = s.allele(pred=lambda x: (ref.g_group(x) if kind == "G" else ref.p_group(x)) is not None)
    grp = ref.g_group(a) if kind == "G" else ref.p_group(a)
    members = ref.g_members(grp) if kind == "G" else ref.p_members(grp)
    if s.rng.random() < 0.5 and len(members) > 1:
        b = s.rng.choice([m for m in members if m != a]); ans = "TRUE"
    else:
        b = s.allele(locus=split_allele(a)[0], pred=lambda x: x != a and (ref.g_group(x) if kind == "G" else ref.p_group(x)) != grp)
        ans = "FALSE"
    sl = sorted(set(slices_for(ref, a) + slices_for(ref, b)))
    return _mk(ref, "same_group", seed,
               f"Are the two alleles below members of the same {kind} group in this release? Answer TRUE or FALSE.",
               {"allele_a": a, "allele_b": b, "group_kind": kind}, ans, [ans], _flags_for(sl), sl,
               {"key": f"{ref.hla_id(a)}|{ref.hla_id(b)}|{kind}"})


def gen_group_members_count(ref, s: Sampler, seed):
    kind = s.rng.choice(["G", "P"])
    locus = s.locus()
    groups = ref.g_groups(locus) if kind == "G" else ref.p_groups(locus)
    g = s.rng.choice(groups)
    n = len(ref.g_members(g) if kind == "G" else ref.p_members(g))
    return _mk(ref, "group_members_count", seed,
               f"How many allele names are members of the {kind} group below in this release? Answer with an integer.",
               {"group": g}, str(n), [str(n)], [], ["class_II_secondary_locus"] if locus in SECONDARY_CLASS_II else [],
               {"key": g})


def gen_serology(ref, s: Sampler, seed):
    a = s.allele(locus=s.rng.choice(["A", "B", "C", "DRB1", "DQB1"]), pred=lambda x: ref.serology(x) is not None)
    ser = ref.serology(a)
    sl = slices_for(ref, a)
    if ser.certain:
        ans = "/".join(ser.unambiguous); flags = _flags_for(sl); conf = None
    else:
        ans = "/".join(ser.best) if ser.best else "NONE"
        flags = _flags_for(sl) + ["serology_uncertain"]; conf = "low"; sl = sl + ["serology_uncertain"]
    return _mk(ref, "serology", seed,
               "Give the WMDA serological equivalent(s) of the allele below as the bare antigen number(s) "
               "(e.g. 1, 0201, 0 for null/no antigen), joining alternatives with '/'. If the assignment is not "
               "unambiguous, raise the flag serology_uncertain and lower your confidence. Answer NONE if no "
               "serological assignment exists.",
               {"allele": a}, ans, [ans], flags, sl, {"key": ref.hla_id(a)}, conf_override=conf)


# --------------------------------------------------------------------------- Tier 3

def gen_renamed_to(ref, s: Sampler, seed):
    names = sorted(ref.deleted)
    old = s.rng.choice(names)
    new = ref.renamed_to(old)
    ans = new if new and ref.exists(new) else "DELETED_NO_SUCCESSOR"
    return _mk(ref, "renamed_to", seed,
               "The allele name below has been deleted from the IPD-IMGT/HLA database. Give its current name "
               "in this release, or DELETED_NO_SUCCESSOR if the sequence has no current name.",
               {"deleted_name": old}, ans, [ans], ["deprecated_name"], ["deleted_name"], {"key": old})


def gen_existed_at(ref, s: Sampler, seed):
    a = s.allele(post_cutoff_bias=0.4)
    rels = [r for r in ref.releases if r >= "3.00.0"]
    R = s.rng.choice(rels[:40])
    ans = "TRUE" if ref.exists_at(a, R) else "FALSE"
    sl = slices_for(ref, a)
    return _mk(ref, "existed_at", seed,
               "Did the allele name below exist, spelled exactly as given, in the IPD-IMGT/HLA release stated? "
               "Answer TRUE or FALSE.",
               {"allele": a, "release": R}, ans, [ans], _flags_for(sl), sl, {"key": f"{ref.hla_id(a)}@{R}"})


def gen_first_release(ref, s: Sampler, seed):
    a = s.allele(post_cutoff_bias=0.4, pred=lambda x: ref.first_release(x) not in (None, "3.00.0"))
    ans = ref.first_release(a)
    sl = slices_for(ref, a)
    return _mk(ref, "first_release", seed,
               "In which IPD-IMGT/HLA release did the allele name below first appear, spelled exactly as given? "
               "Answer as a release string like 3.62.0.",
               {"allele": a}, ans, [ans], _flags_for(sl), sl, {"key": ref.hla_id(a)})


def gen_name_at_release(ref, s: Sampler, seed):
    a = s.allele(post_cutoff_bias=0.3)
    hid = ref.hla_id(a)
    rels = [r for r in ref.releases if r >= "3.00.0"][:40]
    R = s.rng.choice(rels)
    nm = ref.name_at(hid, R)
    ans = nm or "NONE"
    sl = slices_for(ref, a)
    return _mk(ref, "name_at_release", seed,
               f"The IPD-IMGT/HLA accession below is currently named {a}. What was its allele name in the release "
               f"stated? Answer NONE if it had not yet been named in that release.",
               {"hla_id": hid, "current_name": a, "release": R}, ans, [ans],
               _flags_for(sl) + (["release_mismatch"] if nm and nm != a else []), sl, {"key": f"{hid}@{R}"})


def gen_deleted_reason(ref, s: Sampler, seed):
    old = s.rng.choice(sorted(n for n, d in ref.deleted.items() if d.reason != "other"))
    d = ref.deleted[old]
    return _mk(ref, "deleted_reason", seed,
               "Why was the allele name below deleted from the IPD-IMGT/HLA database? Answer with exactly one "
               f"category from: {', '.join(REASON_CATEGORIES)}.",
               {"deleted_name": old}, d.reason, [d.reason], ["deprecated_name"], ["deleted_name"], {"key": old})


def gen_new_in_release(ref, s: Sampler, seed):
    rels = ref.releases
    i = s.rng.randrange(0, 12)
    R, prev = rels[i], rels[i + 1]
    locus = s.locus()
    n = ref.added_between(prev, R, locus)
    return _mk(ref, "new_in_release", seed,
               f"How many new allele names at the locus below were added in IPD-IMGT/HLA release {R} "
               f"relative to release {prev}? Answer with an integer.",
               {"locus": locus, "release": R, "previous_release": prev}, str(n), [str(n)], [],
               ["class_II_secondary_locus"] if locus in SECONDARY_CLASS_II else [], {"key": f"{locus}@{R}"})


# --------------------------------------------------------------------------- Tier 4

def gen_resolve_chain(ref, s: Sampler, seed):
    cands = sorted(n for n in ref.deleted if (ref.renamed_to(n) and ref.exists(ref.renamed_to(n))))
    old = s.rng.choice(cands)
    cur = ref.renamed_to(old)
    g = ref.g_group(cur) or "NONE"
    ser = ref.serology(cur)
    sero = "/".join(ser.best) if ser and ser.best else "NONE"
    ans = {"current_name": cur, "g_group": g, "serology": sero}
    sl = slices_for(ref, cur) + ["deleted_name"]
    flags = ["deprecated_name"] + _flags_for(sl) + (["serology_uncertain"] if ser and not ser.certain else [])
    return _mk(ref, "resolve_chain", seed,
               "Resolve the deleted allele name below in three steps and answer with an object "
               '{"current_name": ..., "g_group": ... or "NONE", "serology": bare antigen number(s) joined by "/" or "NONE"}.',
               {"deleted_name": old}, ans, [ans], flags, sl, {"key": old})


def gen_typing_report_normalize(ref, s: Sampler, seed):
    loci = ["A", "B", "C", "DRB1", "DQB1", "DPB1"]
    shown, answer, flags = [], {}, []
    for loc in loci:
        a = s.allele(locus=loc, pred=lambda x: len(split_allele(x)[1]) >= 2)
        style = s.rng.choice(["full", "two", "legacy", "deleted"])
        two = ref.reduce(a, 2)
        if style == "full":
            text = a
        elif style == "two":
            text = two
        elif style == "legacy":
            text = legacy_form(truncate(a, 2, keep_suffix=False)) or two
            if text != two:
                flags.append("deprecated_name")
        else:
            olds = [n for n in ref.deleted if ref.renamed_to(n) and ref.renamed_to(n).startswith(f"{loc}*")]
            if olds:
                old = s.rng.choice(sorted(olds))
                text = old; a = ref.renamed_to(old); two = ref.reduce(a, 2); flags.append("deprecated_name")
            else:
                text = two
        shown.append(text); answer[loc] = two
    sl = ["typing_report"] + (["deleted_name"] if "deprecated_name" in flags else [])
    return _mk(ref, "typing_report_normalize", seed,
               "The typing report below lists one allele per locus in mixed, partly outdated styles. Normalize "
               "every entry to its current 2-field name in this release and answer with an object keyed by locus, "
               'e.g. {"A": "A*02:01", "B": ..., "C": ..., "DRB1": ..., "DQB1": ..., "DPB1": ...}. Raise '
               "deprecated_name if any entry used legacy or deleted nomenclature.",
               {"typing": ", ".join(shown)}, answer, [answer], flags, sl, {"key": "|".join(shown)}, conf_override="medium")


def gen_null_trap(ref, s: Sampler, seed):
    a = s.allele(pred=lambda x: split_allele(x)[2] == "N")
    sl = slices_for(ref, a)
    return _mk(ref, "null_trap", seed,
               "Give the P group of the allele below, or NONE if it has no P group in this release.",
               {"allele": a}, "NONE", ["NONE"], ["null_allele"], sl, {"key": ref.hla_id(a)}, conf_override="high")


def gen_near_miss(ref, s: Sampler, seed):
    a = s.allele(pred=lambda x: len(split_allele(x)[1]) >= 2)
    locus, f, suf = split_allele(a)
    for bump in (1, 2, 3, 7, 11):
        g = f[:]; g[-1] = str(int(g[-1]) + bump).zfill(len(g[-1]))
        q = f"{locus}*{':'.join(g)}"
        if not ref.exists(q) and not ref.expand(q) and q not in ref.deleted and not ref.ids_for_name_ever(q):
            break
    else:
        q = a + ":99"
    return _mk(ref, "near_miss", seed,
               "Give the G group of the allele below, or NONE if it is not a member of any G group. If the name "
               "is not an assigned allele in this release, answer UNRESOLVABLE and raise nonexistent_allele.",
               {"allele": q}, "UNRESOLVABLE", ["UNRESOLVABLE"], ["nonexistent_allele"], ["near_miss"],
               {"key": q, "nearest": a}, conf_override="high")


def gen_release_drift(ref, s: Sampler, seed):
    rels = [r for r in ref.releases if r >= "3.00.0"]
    for _ in range(3000):
        a = s.allele()
        hid = ref.hla_id(a)
        R = s.rng.choice(rels[3:45])
        old = ref.name_at(hid, R)
        if old and old != a:
            break
    else:
        raise RuntimeError("no drifted allele found")
    sl = slices_for(ref, a) + ["renamed"]
    return _mk(ref, "release_drift", seed,
               f"Work strictly in IPD-IMGT/HLA release {R}. The sequence known today as {a} had a different "
               f"name in release {R}. Give the name that was valid in release {R} (not the current one).",
               {"current_name": a, "release": R}, old, [old], ["release_mismatch"] + _flags_for(sl), sl,
               {"key": f"{hid}@{R}"}, conf_override="low")


GENERATORS = {
    "truncate": gen_truncate, "expand_ambiguity": gen_expand_ambiguity, "valid_name": gen_valid_name,
    "locus_field": gen_locus_field,
    "g_group": gen_g_group, "p_group": gen_p_group, "same_group": gen_same_group,
    "group_members_count": gen_group_members_count, "serology": gen_serology,
    "renamed_to": gen_renamed_to, "existed_at": gen_existed_at, "first_release": gen_first_release,
    "name_at_release": gen_name_at_release, "deleted_reason": gen_deleted_reason, "new_in_release": gen_new_in_release,
    "resolve_chain": gen_resolve_chain, "typing_report_normalize": gen_typing_report_normalize,
    "null_trap": gen_null_trap, "near_miss": gen_near_miss, "release_drift": gen_release_drift,
}


# --------------------------------------------------------------------------- suite

def _split_of(task_id: str, dev_fraction: float) -> str:
    h = int(hashlib.sha256(task_id.encode()).hexdigest(), 16) % 10_000
    return "dev" if h < dev_fraction * 10_000 else "test"


def generate_suite(ref: ImgtReference, base_seed: int = 20260830, counts: dict = COUNTS,
                   dev_fraction: float = 0.2) -> tuple[list[Task], dict]:
    """Deterministic suite of ~550 tasks + manifest. Dedups on Task.key()."""
    tasks: list[Task] = []
    for subtype, gen in GENERATORS.items():
        tier = TIER_OF[subtype]
        want = counts[tier]
        seen = set()
        seed, made = 0, 0
        s = Sampler(ref, random.Random(f"{base_seed}:{subtype}"))
        while made < want and seed < want * 20:
            t = gen(ref, s, seed)
            seed += 1
            if t.key() in seen:
                continue
            seen.add(t.key())
            tasks.append(t)
            made += 1
    by_split = {"dev": 0, "test": 0}
    for t in tasks:
        t.scorer_notes["split"] = _split_of(t.task_id, dev_fraction)
        by_split[t.scorer_notes["split"]] += 1
    t34 = [t for t in tasks if t.tier >= 3 and t.subtype not in ("new_in_release", "typing_report_normalize", "deleted_reason", "renamed_to", "resolve_chain")]
    post = sum(1 for t in t34 if "post_cutoff" in t.slices)
    manifest = {
        "benchmark": f"HLA-Bench-A-v0.1@IMGT-{ref.release}",
        "reference": ref.manifest,
        "base_seed": base_seed,
        "counts_per_subtype": {s: sum(1 for t in tasks if t.subtype == s) for s in GENERATORS},
        "total": len(tasks), "split": by_split,
        "cutoff_assumption": {"release": CUTOFF_RELEASE, "post_cutoff_share_T3T4_allele_tasks": round(post / max(1, len(t34)), 3)},
        "slice_counts": _count_slices(tasks),
    }
    return tasks, manifest


def _count_slices(tasks: list[Task]) -> dict:
    c: dict[str, int] = {}
    for t in tasks:
        for s in t.slices:
            c[s] = c.get(s, 0) + 1
    return dict(sorted(c.items()))


def write_suite(tasks: list[Task], manifest: dict, out_dir: str | Path) -> None:
    out = Path(out_dir)
    (out / "full").mkdir(parents=True, exist_ok=True)
    (out / "dev").mkdir(parents=True, exist_ok=True)
    # Clear task files from any earlier suite revision (runners keep their
    # tree between runs for the response cache; stale ids must not be run).
    for old_file in (out / "full").glob("*.full.json"):
        old_file.unlink()
    for old_file in (out / "dev").glob("*.agent.json"):
        old_file.unlink()
    for t in tasks:
        (out / "full" / f"{t.task_id}.full.json").write_text(dumps(t.full()))
        if t.scorer_notes.get("split") == "dev":
            (out / "dev" / f"{t.task_id}.agent.json").write_text(dumps(t.agent()))
    (out / "manifest.json").write_text(dumps(manifest))


if __name__ == "__main__":
    import sys
    tag = sys.argv[1] if len(sys.argv) > 1 else "v3.65.0-alpha"
    out = sys.argv[2] if len(sys.argv) > 2 else "runs/hla-bench-a"
    ref = ImgtReference.load(tag)
    tasks, manifest = generate_suite(ref)
    write_suite(tasks, manifest, out)
    print(json.dumps({k: manifest[k] for k in ("benchmark", "total", "split", "cutoff_assumption")}, indent=2))
