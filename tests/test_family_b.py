"""Family B layer 1 (TASK_SPEC_FAMILY_B §5.1): synthetic Mendelian truth from the pinned release.

Three properties the issue (#84) names, plus the §6-Q1 defaults and the error paths:
  * a fixed seed reproduces byte-identical output,
  * every child allele is present in a parent at the same locus (and, stronger, every
    transmitted haplotype is one the parent carries whole — no recombination in v0),
  * every founder allele exists in the pinned IPD-IMGT/HLA release.
"""
import json
import random

import pytest

from sci_envs.reference.imgt import ImgtReference, split_allele
from sci_envs.families.phasing import (
    DEFAULT_FOUNDERS, DEFAULT_LOCI, DEFAULT_POPULATION, PhasingError,
    draw_founder_pool, simulate_family, unphase, check_mendelian, normalize_loci,
    generate_dataset, dumps, mendelian_phasings, phased_pairs, pedigree_phasings,
)
from sci_envs.families.phasing.mendelian import main, GENERATOR_REV

REF = ImgtReference.load("v3.65.0-alpha")
DATA = generate_dataset(REF)



def test_spec_proposal_is_the_default():
    assert DEFAULT_FOUNDERS == 40 and tuple(DEFAULT_LOCI) == ("A", "B", "DRB1")
    p = DATA["parameters"]
    assert p["founders"] == 40 and p["loci"] == ["A", "B", "DRB1"] and p["population"] == DEFAULT_POPULATION
    assert DATA["pool"]["size"] == 40 and len(DATA["pool"]["haplotypes"]) == 40
    assert DATA["reference"]["release"] == REF.release
    assert DATA["reference"]["md5"] == REF.manifest["md5"]["Allelelist.txt"]


def test_fixed_seed_is_byte_identical():
    again = generate_dataset(REF)
    assert dumps(again) == dumps(DATA)
    # and a fresh process agrees (the CLI path), so the property does not depend on import order
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        assert main(["--tag", "v3.65.0-alpha"]) == 0
    assert buf.getvalue() == dumps(DATA) + "\n"


def test_different_seed_different_pool():
    other = generate_dataset(REF, seed=1)
    assert other["pool"]["haplotypes"] != DATA["pool"]["haplotypes"]


def test_every_founder_allele_exists_in_release():
    loci = DATA["pool"]["loci"]
    for h in DATA["pool"]["haplotypes"]:
        assert len(h["alleles"]) == len(loci)
        for locus, allele in zip(loci, h["alleles"]):
            assert REF.exists(allele), allele
            assert split_allele(allele)[0] == locus
            assert split_allele(allele)[2] == "", f"expression suffix in default pool: {allele}"
    for locus, alleles in DATA["pool"]["alleles_by_locus"].items():
        assert all(REF.exists(a) and a.startswith(locus + "*") for a in alleles)
        assert alleles == sorted(alleles) and len(set(alleles)) == len(alleles)


def test_pool_haplotypes_distinct_and_frequencies_sum_to_one():
    haps = [tuple(h["alleles"]) for h in DATA["pool"]["haplotypes"]]
    assert len(set(haps)) == len(haps)
    freqs = [h["frequency"] for h in DATA["pool"]["haplotypes"]]
    assert freqs == sorted(freqs, reverse=True) and all(f > 0 for f in freqs)
    assert round(sum(freqs), 6) == 1.0
    # alleles recur across haplotypes, so phasing is not forced by uniqueness
    for i, locus in enumerate(DATA["pool"]["loci"]):
        assert len({h[i] for h in haps}) < len(haps)


def test_every_child_allele_comes_from_a_parent_at_the_same_locus():
    loci = DATA["pool"]["loci"]
    pool = {tuple(h["alleles"]) for h in DATA["pool"]["haplotypes"]}
    n_children = 0
    for fam in DATA["families"]:
        members = {m["id"]: m for m in fam["members"]}
        for m in fam["members"]:
            if m["father"] is None:
                assert m["mother"] is None
                for h in m["truth"]["haplotypes"]:
                    assert tuple(h) in pool                      # founders come from the pool
                continue
            n_children += 1
            paternal, maternal = m["truth"]["haplotypes"]
            assert paternal in members[m["father"]]["truth"]["haplotypes"]
            assert maternal in members[m["mother"]]["truth"]["haplotypes"]
            for i, locus in enumerate(loci):
                a, b = m["genotype"][locus]
                father_alleles = {h[i] for h in members[m["father"]]["truth"]["haplotypes"]}
                mother_alleles = {h[i] for h in members[m["mother"]]["truth"]["haplotypes"]}
                assert {a, b} <= father_alleles | mother_alleles
                assert paternal[i] in father_alleles and maternal[i] in mother_alleles
    assert n_children == DATA["counts"]["children"] == 2 * len(DATA["families"]) == 40


def test_unphased_genotype_carries_no_phase():
    loci = DATA["pool"]["loci"]
    for fam in DATA["families"]:
        for m in fam["members"]:
            h1, h2 = m["truth"]["haplotypes"]
            for i, locus in enumerate(loci):
                pair = m["genotype"][locus]
                assert pair == sorted(pair) and sorted(pair) == sorted([h1[i], h2[i]])
    # the same haplotypes in the other order unphase to the same input
    hp = (("A*01:01:01:01", "B*08:01:01:01", "DRB1*03:01:01:01"),
          ("A*02:01:01:01", "B*07:02:01:01", "DRB1*15:01:01:01"))
    assert unphase(hp, loci) == unphase((hp[1], hp[0]), loci)


def test_three_generation_shape_and_checker():
    pool = draw_founder_pool(REF)
    fam = simulate_family(pool, random.Random(7), "fam", n_children=3, grandparents=True)
    assert [m.id for m in fam.members] == ["paternal_grandfather", "paternal_grandmother",
                                           "maternal_grandfather", "maternal_grandmother",
                                           "father", "mother", "child1", "child2", "child3"]
    assert fam.shape == {"children": 3, "generations": 3}
    assert check_mendelian(fam) == []
    # plant an impossible child: the checker must say so (the future inconsistent_genotype oracle)
    bad = fam.by_id()["child1"]
    bad.haplotypes = (("A*01:01:01:01", "B*08:01:01:01", "DRB1*03:01:01:01"), bad.haplotypes[1])
    assert any("paternal haplotype" in p for p in check_mendelian(fam))


def test_parameters_are_flags_not_constants():
    d = generate_dataset(REF, n_founders=12, loci=["DQB1", "A", "C"], population="pop-x",
                         n_families=2, n_children=1, alleles_per_locus=4)
    assert d["parameters"]["founders"] == 12 and d["pool"]["loci"] == ["A", "C", "DQB1"]   # genomic order
    assert d["parameters"]["population"] == "pop-x" and d["counts"]["individuals"] == 6
    assert len(d["pool"]["haplotypes"]) == 12
    assert normalize_loci(["hla-drb1", "b"]) == ("B", "DRB1")


@pytest.mark.parametrize("kwargs", [
    dict(loci=["A"]), dict(loci=["A", "DPB1"]), dict(loci=["A", "A"]),
    dict(n_founders=1), dict(n_founders=1000, alleles_per_locus=3), dict(alleles_per_locus=1),
])
def test_invalid_parameters_are_refused(kwargs):
    with pytest.raises(PhasingError):
        draw_founder_pool(REF, **kwargs)


def test_output_is_plain_json_and_names_the_release():
    text = dumps(DATA)
    back = json.loads(text)
    assert back["family"] == "hla_phasing" and back["layer"] == "synthetic_mendelian_truth"
    assert back["reference"]["tag"] == "v3.65.0-alpha"
    assert back["parameters"]["recombination"].startswith("none")
    assert back["parameters"]["null_per_locus"] == 0 and back["parameters"]["sibling_pairs_per_locus"] == 0
    assert back["generator_rev"] == GENERATOR_REV == "B1-r2"


# ------------------------------------------------------------- layer 3 (§8.1) pool parameters
def _mendel_holds(fam: dict) -> bool:
    members = {m["id"]: m for m in fam["members"]}
    for m in fam["members"]:
        if m["father"] is None:
            continue
        paternal, maternal = m["truth"]["haplotypes"]
        if paternal not in members[m["father"]]["truth"]["haplotypes"]:
            return False
        if maternal not in members[m["mother"]]["truth"]["haplotypes"]:
            return False
    return True


def test_null_per_locus_relabels_exactly_k_slots_with_null_alleles():
    d = generate_dataset(REF, null_per_locus=2)
    base = DATA["pool"]
    for locus in d["pool"]["loci"]:
        alleles = d["pool"]["alleles_by_locus"][locus]
        nulls = [a for a in alleles if split_allele(a)[2] == "N"]
        assert len(nulls) == 2 and all(REF.exists(a) and a.startswith(locus + "*") for a in nulls)
        assert len(alleles) == len(base["alleles_by_locus"][locus]) == 12
        assert len(set(alleles) & set(base["alleles_by_locus"][locus])) == 10   # the other ten slots are the default pool's
    # the relabel is a bijection on names: haplotype structure and frequencies are the default pool's
    assert [h["frequency"] for h in d["pool"]["haplotypes"]] == [h["frequency"] for h in base["haplotypes"]]
    assert len({tuple(h["alleles"]) for h in d["pool"]["haplotypes"]}) == 40
    assert all(_mendel_holds(fam) for fam in d["families"])
    # and the default pool's bytes do not change: zero is the layer-1 pool exactly
    assert dumps(generate_dataset(REF, null_per_locus=0, sibling_pairs_per_locus=0)) == dumps(DATA)


def test_sibling_pairs_per_locus_relabels_pairs_sharing_a_two_field_prefix():
    from sci_envs.reference.imgt import truncate
    d = generate_dataset(REF, sibling_pairs_per_locus=3)

    def sibling_pairs(alleles):
        by_prefix = {}
        for a in alleles:
            by_prefix.setdefault(truncate(a, 2), []).append(a)
        return [v for v in by_prefix.values() if len(v) >= 2]

    for locus in d["pool"]["loci"]:
        alleles = d["pool"]["alleles_by_locus"][locus]
        base = DATA["pool"]["alleles_by_locus"][locus]
        assert len(alleles) == 12 and all(REF.exists(a) and split_allele(a)[2] == "" for a in alleles)
        new = [v for v in sibling_pairs(alleles) if not set(v) & set(base)]
        # exactly three pairs were planted, each two full-resolution names under one two-field
        # prefix the default pool did not use (a prefix the default pool shares by chance stays)
        assert len(new) == 3 and all(len(v) == 2 for v in new)
        assert len(sibling_pairs(alleles)) == len(sibling_pairs(base)) + 3
        assert all(len(split_allele(a)[1]) >= 3 for v in new for a in v)
        assert len(set(alleles) & set(base)) == 6
    # independent of the null parameter: both together leave 12 slots, 2 null + 6 siblings
    both = generate_dataset(REF, null_per_locus=2, sibling_pairs_per_locus=3)
    for locus in both["pool"]["loci"]:
        assert sum(split_allele(a)[2] == "N" for a in both["pool"]["alleles_by_locus"][locus]) == 2
    assert dumps(generate_dataset(REF, sibling_pairs_per_locus=3)) == dumps(d)       # seeded, reproducible


@pytest.mark.parametrize("kwargs", [
    dict(null_per_locus=-1), dict(sibling_pairs_per_locus=-1),
    dict(null_per_locus=4, sibling_pairs_per_locus=5),            # 4 + 10 > 12 slots
    dict(null_per_locus=1, alleles_per_locus=2, sibling_pairs_per_locus=1),
])
def test_pool_parameters_that_do_not_fit_are_refused(kwargs):
    with pytest.raises(PhasingError):
        draw_founder_pool(REF, **kwargs)


def test_cli_exposes_the_pool_parameters():
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        assert main(["--tag", "v3.65.0-alpha", "--null-per-locus", "1", "--sibling-pairs-per-locus", "1",
                     "--families", "2"]) == 0
    out = json.loads(buf.getvalue())
    assert out["parameters"]["null_per_locus"] == 1 and out["parameters"]["sibling_pairs_per_locus"] == 1
    for locus, alleles in out["pool"]["alleles_by_locus"].items():
        assert sum(a.endswith("N") for a in alleles) == 1


# ---------------------------------------------------------------- layer 3 (§8.2) oracles
LOCI = ["A", "B"]
F1, F2 = ("A*01:01", "B*07:02"), ("A*02:01", "B*08:01")
M1, M2 = ("A*03:01", "B*35:01"), ("A*11:01", "B*44:02")


def test_phased_pairs_enumerates_transmission_and_filters_on_typed_loci():
    allp = phased_pairs([F1, F2], [M1, M2])
    assert len(allp) == 4 and all(p == tuple(sorted(p)) for p in allp)
    child = {"A": ["A*01:01", "A*03:01"], "B": ["B*07:02", "B*35:01"]}
    assert phased_pairs([F1, F2], [M1, M2], child, LOCI) == {(F1, M1)}
    # the imputation oracle: one locus untyped, exactly one pair matches the typed locus
    assert phased_pairs([F1, F2], [M1, M2], {"A": None, "B": ["B*08:01", "B*44:02"]}, LOCI) == {(F2, M2)}
    # an untyped locus where both parents are homozygous adds nothing (the trivial case §8.2 excludes)
    assert phased_pairs([F1, F1], [M1, M1], {"A": None, "B": ["B*07:02", "B*35:01"]}, LOCI) == {(F1, M1)}
    # typed loci that match nothing: empty
    assert phased_pairs([F1, F2], [M1, M2], {"A": ["A*24:02", "A*03:01"], "B": None}, LOCI) == set()


def test_pedigree_phasings_resolves_what_unphased_parents_cannot():
    """Both parents carry both alleles at both loci, so the parents alone leave two
    pairs; grandparents who each carry one haplotype whole fix each parent's phase and
    leave one."""
    father = {"A": ["A*01:01", "A*02:01"], "B": ["B*07:02", "B*08:01"]}
    mother = dict(father)
    child = dict(father)
    assert len(mendelian_phasings(child, father, mother, LOCI)) == 2
    gp = {
        "paternal_grandfather": {"A": ["A*01:01", "A*01:01"], "B": ["B*07:02", "B*07:02"]},   # gives (01:01, 07:02)
        "paternal_grandmother": {"A": ["A*02:01", "A*02:01"], "B": ["B*08:01", "B*08:01"]},   # gives (02:01, 08:01)
        "maternal_grandfather": {"A": ["A*01:01", "A*01:01"], "B": ["B*07:02", "B*07:02"]},
        "maternal_grandmother": {"A": ["A*02:01", "A*02:01"], "B": ["B*08:01", "B*08:01"]},
    }
    assert pedigree_phasings(child, father, mother, gp, LOCI) == {(("A*01:01", "B*07:02"), ("A*02:01", "B*08:01"))}
    # grandparents who leave the parents' phase open leave the child's open too
    open_gp = {k: father for k in gp}
    assert len(pedigree_phasings(child, father, mother, open_gp, LOCI)) == 2
    # a parent inconsistent with its own parents: nothing is reachable
    bad_gp = dict(gp, paternal_grandfather={"A": ["A*24:02", "A*24:02"], "B": ["B*07:02", "B*07:02"]})
    assert pedigree_phasings(child, father, mother, bad_gp, LOCI) == set()
