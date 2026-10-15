"""Family B layers 2 and 3 (TASK_SPEC_FAMILY_B §7, §8): the graded subtypes and their grader.

The gate the issues (#99, #126) name: the oracle — phased truth read straight from the
layer-1 generator — scores 100% on every generated task, seeded and byte-reproducible.
Then the §4 rules one by one: order-normalised exact match, ``phase_flip``,
``impossible_pair``, blanket ``UNRESOLVABLE`` penalised as refusal, the Mendel oracle
behind ``family_phase`` and ``consistency_check``, the envelope rules inherited from
family A; and the §8 additions: every determinacy filter, the ``ranked`` form, the
probability-sum rule, ``resolution_not_lifted`` / ``wrong_lift`` / ``wrong_imputation`` /
``hedged_answer``, the loosened name invariant for ``resolution_lift``, and the split key
that ignores the revision segment.

The suite is generated at the pinned release (3.66.0): §8.5's supply table was measured
there, and the §8.5 guard is *meant* to fire on a release whose supply falls short.
"""
import json
from collections import Counter

import pytest

from sci_envs.reference.imgt import ImgtReference, split_allele, truncate
from sci_envs.families.nomenclature.task import dumps
from sci_envs.families.phasing import (
    SUITE_REV, COUNTS, DATASETS, generate_suite, mendelian_phasings, lifted_phasings, pedigree_phasings,
    phased_pairs, split_key, grade, oracle_response, summarize,
)
from sci_envs.families.phasing.tasks import GRANDPARENTS, _split_of
from sci_envs.families.phasing.grade import GRADER_VERSION, normalize_pair, PRECEDENCE, PROB_EPS

REF = ImgtReference.load("v3.66.0-alpha")
TASKS, MANIFEST = generate_suite(REF)
BY = {s: [t for t in TASKS if t.subtype == s] for s in COUNTS}
LAYER3 = ["impute_missing_locus", "resolution_lift", "phase_ambiguous", "pedigree_phase", "null_in_haplotype"]


def _resp(answer, confidence="high", flags=(), reasoning=""):
    return {"answer": answer, "confidence": confidence, "flags": list(flags), "reasoning": reasoning}


def _truth(task):
    return task.full()["answer"]["canonical"]["haplotypes"]


def _truth_set(task):
    return [e["haplotypes"] for e in task.full()["answer"]["canonical"]["ranked"]]


def _ranked(*pairs, probabilities=None):
    entries = [{"haplotypes": p} for p in pairs]
    if probabilities is not None:
        for e, p in zip(entries, probabilities):
            e["probability"] = p
    return {"ranked": entries}


def _fields(a):
    return len(split_allele(a)[1])


# ------------------------------------------------------------------ the suite itself
def test_suite_shape_and_counts():
    assert MANIFEST["total"] == len(TASKS) == sum(n for _, n in COUNTS.values()) == 240
    for s, (tier, n) in COUNTS.items():
        assert len(BY[s]) == n and all(t.tier == tier for t in BY[s])
        assert all(t.task_id.startswith(f"hla_phasing.{SUITE_REV}.T{tier}.{s}.") for t in BY[s])
    assert MANIFEST["split"]["dev"] + MANIFEST["split"]["test"] == 240 and MANIFEST["split"]["dev"] > 0
    assert MANIFEST["by_subtype"] == {s: n for s, (_, n) in COUNTS.items()}
    assert MANIFEST["dataset_parameters"]["loci"] == ["A", "B", "DRB1"]     # §6 Q1 as settled by #86
    assert set(MANIFEST["datasets"]) == set(DATASETS) == {"D-main", "D-ped", "D-null", "D-lift"}
    assert MANIFEST["datasets"]["D-main"]["families"] == 300                 # §8.5: 60 in layer 2
    assert MANIFEST["datasets"]["D-null"]["null_per_locus"] == 2
    assert MANIFEST["datasets"]["D-lift"]["sibling_pairs_per_locus"] == 3
    assert MANIFEST["datasets"]["D-ped"]["grandparents"] is True and MANIFEST["datasets"]["D-ped"]["families"] == 600
    assert MANIFEST["suite_rev"] == "B3-r1" and MANIFEST["generator_rev"] == "B1-r2"
    assert MANIFEST["reference"]["release"] == REF.release
    assert len({t.task_id for t in TASKS}) == 240 and len({t.key() for t in TASKS}) == 240


def test_fixed_seed_is_byte_identical():
    again, manifest = generate_suite(REF)
    assert dumps([t.full() for t in again]) == dumps([t.full() for t in TASKS])
    assert dumps(manifest) == dumps(MANIFEST)
    other, _ = generate_suite(REF, base_seed=1)
    assert [t.input for t in other] != [t.input for t in TASKS]


def test_split_is_keyed_without_the_revision_segment():
    """§8.5: a rev bump that leaves content unchanged leaves the split unchanged."""
    for t in TASKS:
        assert split_key(t.task_id) == t.task_id.replace(f".{SUITE_REV}.", ".")
        assert t.scorer_notes["split"] == _split_of(split_key(t.task_id), 0.2)
    assert split_key("hla_phasing.B9-r9.T4.family_phase.0003") == "hla_phasing.T4.family_phase.0003"


def test_oracle_scores_100_percent():
    for t in TASKS:
        s = grade(t.full(), oracle_response(t.full()), REF)
        assert s.correct and s.calibrated and s.failure_modes == ["clean_correct"], (t.task_id, s.failure_modes)
        assert s.grader_version == GRADER_VERSION == "B-0.2" and s.hallucinated_names == []
    rep = summarize([grade(t.full(), oracle_response(t.full()), REF) for t in TASKS])
    assert rep["overall"]["acc"] == 1.0 and set(rep["by_subtype"]) == set(COUNTS)
    # the set task's oracle answers in the ranked form with probabilities that sum to one
    o = oracle_response(BY["phase_ambiguous"][0].full())
    assert len(o["answer"]["ranked"]) == 2 and sum(e["probability"] for e in o["answer"]["ranked"]) == 1.0


def test_agent_view_hides_the_answer_and_the_plant():
    for t in TASKS:
        a = t.agent()
        assert "answer" not in a and "scorer_notes" not in a
        assert set(a["input"]) >= {"loci", "genotype", "population"}
        for l in a["input"]["loci"]:
            pair = a["input"]["genotype"][l]
            if pair is None:
                assert t.subtype == "impute_missing_locus"
                continue
            assert len(pair) == 2 and pair == sorted(pair)            # unphased: no positional phase
            if t.subtype == "resolution_lift":                          # §8.2: the loosened invariant
                assert all(_fields(x) == 2 and REF.expand(x) for x in pair), pair
            else:
                assert all(REF.exists(x) for x in pair), pair           # every name is a real release name
        for who, rel in a["input"].get("relatives", {}).items():
            if "haplotypes" in rel:
                assert t.subtype == "impute_missing_locus"
                assert all(REF.exists(x) for h in rel["haplotypes"] for x in h)
            else:
                for l in a["input"]["loci"]:
                    assert rel[l] == sorted(rel[l]) and all(REF.exists(x) for x in rel[l])
        text = json.dumps(a)
        assert "UNRESOLVABLE" not in a["subtype"] and "planted" not in text and "truth" not in text
    # every subtype that shows relatives reads identically to the agent, bar the data
    texts = {t.instructions for t in TASKS if t.subtype != "phase_trivial"}
    assert len(texts) == 1
    assert "ranked" in next(iter(texts)) and "null_allele" in next(iter(texts))


# ------------------------------------------------------------- subtype construction
def test_phase_trivial_is_two_loci_one_heterozygous_and_forced():
    for t in BY["phase_trivial"]:
        loci, g = t.input["loci"], t.input["genotype"]
        assert len(loci) == 2 and "relatives" not in t.input
        assert sum(g[l][0] != g[l][1] for l in loci) == 1
        h1, h2 = _truth(t)
        assert [h1, h2] == sorted([h1, h2])
        for i, l in enumerate(loci):
            assert sorted([h1[i], h2[i]]) == g[l]
        assert t.full()["answer"]["expected_flags"] == []


def test_family_phase_is_decidable_by_mendel_alone():
    for t in BY["family_phase"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert set(rel) == {"father", "mother"} and len(loci) == 3
        assert sum(g[l][0] != g[l][1] for l in loci) >= 2            # not trivial by homozygosity
        allowed = mendelian_phasings(g, rel["father"], rel["mother"], loci)
        h1, h2 = _truth(t)
        assert allowed == {(tuple(h1), tuple(h2))}
        for who in rel.values():
            for l in loci:
                assert who[l] == sorted(who[l])                      # parents are unphased too


def test_consistency_check_is_mendel_impossible_with_real_names():
    variants = Counter()
    for t in BY["consistency_check"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert mendelian_phasings(g, rel["father"], rel["mother"], loci) == set()
        assert t.full()["answer"]["canonical"] == "UNRESOLVABLE"
        assert t.full()["answer"]["expected_flags"] == ["inconsistent_genotype"]
        assert all(REF.exists(a) for l in loci for a in g[l])        # Mendelian, not nomenclature
        variants[t.slices[0]] += 1
    assert set(variants) == {"foreign_allele", "impossible_combination"} and min(variants.values()) >= 5


def test_impute_missing_locus_is_determinate_from_phased_parents():
    """§8.2: one locus null, parents phased, exactly one pair matches the typed loci,
    never both parents homozygous at the untyped locus, and the untyped locus rotates."""
    untyped = Counter()
    for t in BY["impute_missing_locus"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        X = [l for l in loci if g[l] is None]
        assert len(X) == 1 and t.scorer_notes["untyped_locus"] == X[0] and t.slices == ["family_determinate"]
        untyped[X[0]] += 1
        fh = [tuple(h) for h in rel["father"]["haplotypes"]]
        mh = [tuple(h) for h in rel["mother"]["haplotypes"]]
        assert fh == sorted(fh) and mh == sorted(mh)                 # phased, but the order carries nothing
        i = loci.index(X[0])
        assert len({fh[0][i], fh[1][i]}) == 2 or len({mh[0][i], mh[1][i]}) == 2     # non-trivial
        h1, h2 = _truth(t)
        assert phased_pairs(fh, mh, g, loci) == {(tuple(h1), tuple(h2))}
        assert all(len(g[l]) == 2 for l in loci if l != X[0])
        assert t.full()["answer"]["expected_flags"] == []
    assert set(untyped) == {"A", "B", "DRB1"} and min(untyped.values()) >= 8


def test_resolution_lift_is_two_field_input_with_a_forced_nontrivial_lift():
    for t in BY["resolution_lift"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert all(_fields(a) == 2 for l in loci for a in g[l])
        assert all(_fields(a) >= 2 for who in rel.values() for l in loci for a in who[l])
        h1, h2 = _truth(t)
        assert lifted_phasings(g, rel["father"], rel["mother"], loci) == {(tuple(h1), tuple(h2))}
        for i, l in enumerate(loci):                                  # the truth truncates to the input
            assert sorted([truncate(h1[i], 2), truncate(h2[i], 2)]) == g[l]
        nontrivial = any(len({a for who in rel.values() for a in who[l] if truncate(a, 2) == x}) >= 2
                         for l in loci for x in g[l])
        assert nontrivial, t.task_id
        assert t.full()["answer"]["expected_flags"] == ["low_resolution_input"]
        assert t.scorer_notes["full_resolution_genotype"] and t.slices == ["family_determinate"]


def test_phase_ambiguous_is_exactly_the_mendel_set_of_two():
    for t in BY["phase_ambiguous"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        allowed = mendelian_phasings(g, rel["father"], rel["mother"], loci)
        pairs = _truth_set(t)
        assert len(allowed) == 2 == len(pairs)
        assert {(tuple(a), tuple(b)) for a, b in pairs} == allowed
        assert pairs == sorted(pairs) and t.slices == ["mendelian_set"]
        assert t.full()["answer"]["expected_flags"] == ["phase_ambiguous"]


def test_pedigree_phase_needs_the_grandparents():
    for t in BY["pedigree_phase"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        assert set(rel) == {"father", "mother", *GRANDPARENTS}
        parents_only = mendelian_phasings(g, rel["father"], rel["mother"], loci)
        assert len(parents_only) >= 2 == t.scorer_notes["parents_only_pairs"] or len(parents_only) >= 2
        gp = {k: rel[k] for k in GRANDPARENTS}
        h1, h2 = _truth(t)
        assert pedigree_phasings(g, rel["father"], rel["mother"], gp, loci) == {(tuple(h1), tuple(h2))}
        for who in rel.values():
            for l in loci:
                assert who[l] == sorted(who[l])                      # everyone is unphased
        assert t.full()["answer"]["expected_flags"] == []


def test_null_in_haplotype_flags_only_the_carried_slice():
    slices = Counter()
    for t in BY["null_in_haplotype"]:
        loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
        h1, h2 = _truth(t)
        assert mendelian_phasings(g, rel["father"], rel["mother"], loci) == {(tuple(h1), tuple(h2))}
        carried = any(split_allele(a)[2] == "N" for h in (h1, h2) for a in h)
        in_parent = any(split_allele(a)[2] == "N" for who in rel.values() for l in loci for a in who[l])
        assert in_parent
        assert t.slices == ["carried" if carried else "decoy"]
        assert t.full()["answer"]["expected_flags"] == (["null_allele"] if carried else [])
        slices[t.slices[0]] += 1
    assert slices == {"carried": 20, "decoy": 10}                     # §8.2: roughly two to one


def test_mendelian_phasings_enumerates_and_detects():
    loci = ["A", "B"]
    father = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"]}
    mother = {"A": ["A*03:01", "A*11:01"], "B": ["B*35:01", "B*44:02"]}
    child = {"A": ["A*01:01", "A*03:01"], "B": ["B*08:01", "B*35:01"]}
    assert mendelian_phasings(child, father, mother, loci) == {
        (("A*01:01", "B*08:01"), ("A*03:01", "B*35:01"))}
    # both parents carry both alleles at both loci: two heterozygous loci -> two pairings
    same = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"]}
    assert len(mendelian_phasings(same, same, same, loci)) == 2
    # an allele neither parent carries
    assert mendelian_phasings({"A": ["A*01:01", "A*24:02"], "B": child["B"]}, father, mother, loci) == set()
    # both alleles from the father while the mother carries neither
    assert mendelian_phasings({"A": ["A*01:01", "A*02:01"], "B": child["B"]}, father, mother, loci) == set()


def test_supply_guard_fails_loudly():
    """§8.5: a subtype whose supply falls under its count fails generation."""
    from sci_envs.families.phasing import tasks as T
    saved = dict(T.COUNTS)
    T.COUNTS["phase_ambiguous"] = (3, 10_000)
    try:
        with pytest.raises(RuntimeError, match="phase_ambiguous: only"):
            generate_suite(REF)
    finally:
        T.COUNTS.clear()
        T.COUNTS.update(saved)


# ------------------------------------------------------------------------ the grader
def _three_locus_het():
    return BY["family_phase"][0]


def test_haplotype_order_prefix_and_object_form_are_forgiven():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    loci = t.input["loci"]
    assert grade(t.full(), _resp({"haplotypes": [h2, h1]}), REF).correct
    assert grade(t.full(), _resp([h1, h2]), REF).correct
    assert grade(t.full(), _resp({"haplotypes": [["HLA-" + a for a in h1], h2]}), REF).correct
    as_obj = [dict(zip(loci, h1)), {f"hla-{l}": a for l, a in zip(loci, h2)}]
    assert grade(t.full(), _resp({"haplotypes": as_obj}), REF).correct
    assert normalize_pair({"haplotypes": [h2, h1]}, loci) == (tuple(h1), tuple(h2))
    # §8.3: a one-entry ranked list is graded as the pair
    s = grade(t.full(), _resp(_ranked([h2, h1], probabilities=[1.0])), REF)
    assert s.correct and s.failure_modes == ["clean_correct"]


def test_phase_flip_is_right_alleles_wrong_pairing():
    t = _three_locus_het()
    h1, h2 = (list(h) for h in _truth(t))
    loci = t.input["loci"]
    i = next(i for i, l in enumerate(loci) if h1[i] != h2[i])
    h1[i], h2[i] = h2[i], h1[i]                                       # swap one heterozygous locus
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert not s.correct and s.primary_failure_mode == "phase_flip"
    assert "wrong_but_overconfident" in s.failure_modes and s.hallucinated_names == []
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, confidence="low"), REF)
    assert s.primary_failure_mode == "phase_flip" and "wrong_calibrated" in s.failure_modes


def test_impossible_pair_is_an_allele_the_individual_does_not_carry():
    t = _three_locus_het()
    h1, h2 = (list(h) for h in _truth(t))
    h1[0] = "A*01:01:01:01" if h1[0] != "A*01:01:01:01" else "A*02:01:01:01"   # real name, not carried
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert not s.correct and s.primary_failure_mode == "impossible_pair" and s.hallucinated_names == []
    # a fabricated name in the answer outranks it
    h1[0] = "A*99:999"
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert s.primary_failure_mode == "hallucinated_answer" and s.hallucinated_names == ["A*99:999"]
    assert "impossible_pair" in s.failure_modes


def test_blanket_unresolvable_scores_only_the_inconsistent_tasks():
    scores = [grade(t.full(), _resp("UNRESOLVABLE", flags=["inconsistent_genotype"]), REF) for t in TASKS]
    assert sum(s.correct for s in scores) == COUNTS["consistency_check"][1]
    for s in scores:
        if s.subtype == "consistency_check":
            assert s.failure_modes == ["clean_correct"]
        else:
            assert s.primary_failure_mode == "refused" and not s.correct
    # and the lower-case / prefixed spellings of the sentinel are the same answer
    t = BY["consistency_check"][0]
    assert grade(t.full(), _resp(" unresolvable ", flags=["inconsistent_genotype"]), REF).correct


def test_inconsistent_task_answered_with_a_pair_is_wrong_and_missed_the_flag():
    t = BY["consistency_check"][0]
    loci, g = t.input["loci"], t.input["genotype"]
    pair = [[g[l][0] for l in loci], [g[l][1] for l in loci]]        # reproduces the (impossible) genotype
    s = grade(t.full(), _resp({"haplotypes": pair}), REF)
    assert not s.correct and "missed_ambiguity" in s.failure_modes and s.flags_missed == ["inconsistent_genotype"]
    assert "phase_flip" not in s.failure_modes and "impossible_pair" not in s.failure_modes
    assert s.primary_failure_mode == "wrong_but_overconfident"
    # a ranked list on an inconsistent task is wrong the same way, never a hedge
    s = grade(t.full(), _resp(_ranked(pair, [pair[1], pair[0]])), REF)
    assert not s.correct and "hedged_answer" not in s.failure_modes


def test_flags_are_soft_and_confidence_is_one_sided():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, flags=["phase_ambiguous", "not_a_flag"]), REF)
    assert s.correct and s.flags_spurious == ["phase_ambiguous"]
    assert s.failure_modes == ["false_positive_flag"] and s.primary_failure_mode == "false_positive_flag"
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, confidence="low"), REF)
    assert s.correct and s.calibrated and s.failure_modes == ["clean_correct"]     # under-confidence tolerated
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, reasoning="recalls A*98:765 from memory"), REF)
    assert s.correct and s.primary_failure_mode == "correct_with_hallucinated_reasoning"
    assert s.hallucinated_names == ["A*98:765"]
    # null_allele is in the vocabulary now: expected on the carried slice, spurious on the decoy
    carried = next(t for t in BY["null_in_haplotype"] if t.slices == ["carried"])
    decoy = next(t for t in BY["null_in_haplotype"] if t.slices == ["decoy"])
    s = grade(carried.full(), _resp({"haplotypes": _truth(carried)}), REF)
    assert s.correct and s.flags_missed == ["null_allele"] and s.primary_failure_mode == "missed_ambiguity"
    s = grade(decoy.full(), _resp({"haplotypes": _truth(decoy)}, flags=["null_allele"]), REF)
    assert s.correct and s.flags_spurious == ["null_allele"] and s.primary_failure_mode == "false_positive_flag"


@pytest.mark.parametrize("answer", [
    "not json at all", {"answer": {"haplotypes": [["A*01:01"]]}}, {"answer": {"haplotypes": "x"}},
    {"answer": None}, {"answer": {"haplotypes": [["A*01:01", "B*07:02", "DRB1*01:01"]] * 3}},
    {"answer": {"haplotypes": [["A*01:01", "B*07:02"], ["A*01:01", "B*07:02"]]}},   # two loci where three asked
    {"nope": 1},
    {"answer": {"ranked": []}}, {"answer": {"ranked": "x"}}, {"answer": {"ranked": [{"haplotypes": "x"}]}},
])
def test_malformed_answers(answer):
    t = _three_locus_het()
    s = grade(t.full(), answer, REF)
    assert not s.correct and s.failure_modes == ["malformed_response"]


def test_response_parsed_out_of_prose():
    t = _three_locus_het()
    h1, h2 = _truth(t)
    text = "Here you go:\n" + json.dumps(_resp({"haplotypes": [h1, h2]})) + "\nDone."
    assert grade(t.full(), text, REF).failure_modes == ["clean_correct"]


# ------------------------------------------------------------------- §8.3 additions
def test_ranked_set_task_is_graded_as_a_set():
    t = BY["phase_ambiguous"][0]
    p1, p2 = _truth_set(t)
    for answer in (_ranked(p1, p2), _ranked(p2, p1), _ranked([p1[1], p1[0]], p2, probabilities=[0.6, 0.4])):
        s = grade(t.full(), _resp(answer, flags=["phase_ambiguous"]), REF)
        assert s.correct and s.failure_modes == ["clean_correct"], s.failure_modes
    # the right set without the flag is correct but missed the flag
    s = grade(t.full(), _resp(_ranked(p1, p2)), REF)
    assert s.correct and s.primary_failure_mode == "missed_ambiguity"
    # a single pair, even one of the two, is wrong — and missed the flag when absent
    s = grade(t.full(), _resp({"haplotypes": p1}), REF)
    assert not s.correct and s.primary_failure_mode == "wrong_but_overconfident"
    assert "missed_ambiguity" in s.failure_modes and "phase_flip" not in s.failure_modes
    s = grade(t.full(), _resp({"haplotypes": p1}, confidence="low", flags=["phase_ambiguous"]), REF)
    assert not s.correct and s.primary_failure_mode == "wrong_calibrated"
    # members all reproduce the genotype but the set is not the truth set: phase_flip
    loci = t.input["loci"]
    g = t.input["genotype"]
    other = [[g[l][0] for l in loci], [g[l][1] for l in loci]]
    if sorted(other) in (sorted(p1), sorted(p2)):
        other = [[g[l][1 if i == 0 else 0] for i, l in enumerate(loci)], [g[l][0 if i == 0 else 1] for i, l in enumerate(loci)]]
    assert sorted(other) not in (sorted(p1), sorted(p2))
    s = grade(t.full(), _resp(_ranked(p1, other), flags=["phase_ambiguous"]), REF)
    assert not s.correct and s.primary_failure_mode == "phase_flip"
    # a member that does not reproduce the genotype: impossible_pair
    bad = [list(p1[0]), list(p1[1])]
    bad[0][0] = "A*01:01:01:01" if bad[0][0] != "A*01:01:01:01" else "A*02:01:01:01"
    s = grade(t.full(), _resp(_ranked(bad, p2), flags=["phase_ambiguous"]), REF)
    assert s.primary_failure_mode == "impossible_pair"
    # UNRESOLVABLE on a set task is a refusal
    assert grade(t.full(), _resp("UNRESOLVABLE"), REF).primary_failure_mode == "refused"


def test_hedged_answer_on_a_single_pair_task():
    t = _three_locus_het()
    h1, h2 = (list(h) for h in _truth(t))
    f1, f2 = list(h1), list(h2)
    i = next(i for i, l in enumerate(t.input["loci"]) if h1[i] != h2[i])
    f1[i], f2[i] = f2[i], f1[i]
    s = grade(t.full(), _resp(_ranked([h1, h2], [f1, f2]), flags=["phase_ambiguous"]), REF)
    assert not s.correct and s.primary_failure_mode == "hedged_answer"
    assert "false_positive_flag" in s.failure_modes and "wrong_but_overconfident" in s.failure_modes
    s = grade(t.full(), _resp(_ranked([f1, f2], [h1, h2], [h2, h1])), REF)      # three, truth inside
    assert s.primary_failure_mode == "hedged_answer"
    # a list that does not contain the truth is diagnosed by its top member
    s = grade(t.full(), _resp(_ranked([f1, f2], [f2, f1])), REF)
    assert s.primary_failure_mode == "phase_flip" and "hedged_answer" not in s.failure_modes
    # a hedge that includes a fabricated pair is impossible_pair first
    bad = list(f1)
    bad[0] = "A*01:01:01:01" if bad[0] != "A*01:01:01:01" else "A*02:01:01:01"
    s = grade(t.full(), _resp(_ranked([h1, h2], [bad, f2])), REF)
    assert s.primary_failure_mode == "impossible_pair" and "hedged_answer" in s.failure_modes
    # more than three entries breaks the contract
    s = grade(t.full(), _resp(_ranked([h1, h2], [f1, f2], [h1, h2], [f1, f2])), REF)
    assert s.failure_modes == ["malformed_response"]


@pytest.mark.parametrize("probs, ok", [
    ([0.5, 0.5], True), ([0.6, 0.41], True), ([None, 0.3], True), ([0.0, 1.0], True),
    ([0.7, 0.4], False), ([1.2, None], False), ([-0.1, 0.5], False), (["0.5", 0.5], False), ([True, 0.5], False),
])
def test_probabilities_must_be_in_range_and_sum_to_at_most_one(probs, ok):
    t = BY["phase_ambiguous"][0]
    p1, p2 = _truth_set(t)
    answer = _ranked(p1, p2)
    for e, p in zip(answer["ranked"], probs):
        if p is not None:
            e["probability"] = p
    s = grade(t.full(), _resp(answer, flags=["phase_ambiguous"]), REF)
    if ok:
        assert s.correct and s.failure_modes == ["clean_correct"]
    else:
        assert s.failure_modes == ["malformed_response"]
    assert PROB_EPS == 0.01


def test_resolution_lift_modes():
    t = BY["resolution_lift"][0]
    loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
    h1, h2 = _truth(t)
    # the truth at full resolution with the flag: clean
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}, flags=["low_resolution_input"]), REF)
    assert s.correct and s.failure_modes == ["clean_correct"]
    s = grade(t.full(), _resp({"haplotypes": [h1, h2]}), REF)
    assert s.correct and s.primary_failure_mode == "missed_ambiguity"
    # the two-field pair itself: phase may be right, the lift was not attempted
    two = [[truncate(a, 2) for a in h1], [truncate(a, 2) for a in h2]]
    s = grade(t.full(), _resp({"haplotypes": two}, flags=["low_resolution_input"]), REF)
    assert not s.correct and s.primary_failure_mode == "resolution_not_lifted" and s.hallucinated_names == []
    # a flip at full resolution: phase_flip
    f1, f2 = list(h1), list(h2)
    i = next(i for i, l in enumerate(loci) if h1[i] != h2[i])
    f1[i], f2[i] = f2[i], f1[i]
    s = grade(t.full(), _resp({"haplotypes": [f1, f2]}, flags=["low_resolution_input"]), REF)
    assert s.primary_failure_mode == "phase_flip"
    # a parental, two-field-consistent allele that Mendel does not force: wrong_lift
    for j, l in enumerate(loci):
        parental = {a for who in rel.values() for a in who[l]}
        for a in (h1[j], h2[j]):
            alt = [x for x in parental if x != a and truncate(x, 2) == truncate(a, 2)]
            if alt:
                w1, w2 = list(h1), list(h2)
                (w1 if a == h1[j] else w2)[j] = alt[0]
                s = grade(t.full(), _resp({"haplotypes": [w1, w2]}, flags=["low_resolution_input"]), REF)
                assert s.primary_failure_mode == "wrong_lift", s.failure_modes
                break
        else:
            continue
        break
    else:
        pytest.fail("no non-trivial lift locus found")
    # a full-resolution name consistent at two fields but carried by neither parent: impossible_pair
    for j, l in enumerate(loci):
        parental = {a for who in rel.values() for a in who[l]}
        foreign = [x for x in REF.expand(truncate(h1[j], 2)) if x not in parental and _fields(x) >= 3]
        if foreign:
            w1 = list(h1)
            w1[j] = foreign[0]
            s = grade(t.full(), _resp({"haplotypes": [w1, h2]}, flags=["low_resolution_input"]), REF)
            assert s.primary_failure_mode == "impossible_pair", s.failure_modes
            break
    else:
        pytest.fail("no foreign sibling name found")
    # a pair that does not reproduce the two-field input is impossible, lifted or not
    w1 = list(h1)
    w1[0] = "A*01:01:01:01" if truncate(h1[0], 2) != "A*01:01" else "A*02:01:01:01"
    assert grade(t.full(), _resp({"haplotypes": [w1, h2]}), REF).primary_failure_mode == "impossible_pair"


def test_impute_missing_locus_modes():
    t = BY["impute_missing_locus"][0]
    loci, g, rel = t.input["loci"], t.input["genotype"], t.input["relatives"]
    X = next(l for l in loci if g[l] is None)
    i = loci.index(X)
    h1, h2 = _truth(t)
    assert grade(t.full(), _resp({"haplotypes": [h2, h1]}), REF).failure_modes == ["clean_correct"]
    # typed loci exactly right, untyped locus wrong but parental: wrong_imputation
    parental = {h[i] for who in rel.values() for h in who["haplotypes"]}
    alt = [a for a in parental if a not in (h1[i], h2[i])]
    w1, w2 = list(h1), list(h2)
    if alt:
        w1[i] = alt[0]
    else:
        w1[i], w2[i] = h2[i], h1[i]                                  # same two alleles, swapped
        if w1 == h2 and w2 == h1:
            pytest.skip("imputed locus is homozygous in truth and no alternative parental allele")
    s = grade(t.full(), _resp({"haplotypes": [w1, w2]}), REF)
    assert not s.correct and s.primary_failure_mode in ("wrong_imputation", "phase_flip"), s.failure_modes
    if alt:
        assert s.primary_failure_mode == "wrong_imputation"
    # an allele at the untyped locus that neither parent carries: impossible_pair
    w1 = list(h1)
    w1[i] = next(a for a in REF.alleles(X) if a not in parental)
    s = grade(t.full(), _resp({"haplotypes": [w1, h2]}), REF)
    assert s.primary_failure_mode == "impossible_pair" and s.hallucinated_names == []
    # a typed locus that does not reproduce the genotype: impossible_pair
    j = next(j for j, l in enumerate(loci) if l != X)
    w1 = list(h1)
    w1[j] = next(a for a in REF.alleles(loci[j]) if a not in g[loci[j]])
    assert grade(t.full(), _resp({"haplotypes": [w1, h2]}), REF).primary_failure_mode == "impossible_pair"
    # a phase flip across the typed loci with the imputed locus right: phase_flip, not wrong_imputation
    het = [j for j, l in enumerate(loci) if l != X and h1[j] != h2[j]]
    if het:
        f1, f2 = list(h1), list(h2)
        f1[het[0]], f2[het[0]] = f2[het[0]], f1[het[0]]
        if sorted([f1, f2]) != sorted([list(h1), list(h2)]):
            assert grade(t.full(), _resp({"haplotypes": [f1, f2]}), REF).primary_failure_mode == "phase_flip"


def test_pedigree_and_null_grade_like_family_phase():
    for t in (BY["pedigree_phase"][0], BY["null_in_haplotype"][0]):
        h1, h2 = _truth(t)
        flags = t.full()["answer"]["expected_flags"]
        assert grade(t.full(), _resp({"haplotypes": [h2, h1]}, flags=flags), REF).failure_modes == ["clean_correct"]
        f1, f2 = list(h1), list(h2)
        i = next(i for i, l in enumerate(t.input["loci"]) if h1[i] != h2[i])
        f1[i], f2[i] = f2[i], f1[i]
        assert grade(t.full(), _resp({"haplotypes": [f1, f2]}, flags=flags), REF).primary_failure_mode == "phase_flip"
        assert grade(t.full(), _resp("UNRESOLVABLE"), REF).primary_failure_mode == "refused"


def test_precedence_is_total_over_every_mode_the_grader_emits():
    emitted = set()
    for t in TASKS[:3] + [BY[s][0] for s in LAYER3]:
        a = t.full()["answer"]["canonical"]
        h = a["haplotypes"] if "haplotypes" in a else a["ranked"][0]["haplotypes"]
        for r in (_resp("UNRESOLVABLE"), _resp({"haplotypes": h}, flags=["rare_haplotype"]),
                  _resp({"haplotypes": [h[1], h[0]]}, confidence="medium"), _resp(_ranked(h, [h[1], h[0]]))):
            emitted |= set(grade(t.full(), r, REF).failure_modes)
    assert emitted <= set(PRECEDENCE)
    order = ["malformed_response", "hallucinated_answer", "impossible_pair", "phase_flip", "resolution_not_lifted",
             "wrong_lift", "wrong_imputation", "hedged_answer", "wrong_but_overconfident", "wrong_calibrated",
             "refused", "correct_but_overconfident", "correct_with_hallucinated_reasoning", "missed_ambiguity",
             "false_positive_flag", "clean_correct"]
    assert PRECEDENCE == order                                        # §8.3, verbatim
