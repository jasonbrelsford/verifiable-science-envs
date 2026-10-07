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
    generate_dataset, dumps,
)
from sci_envs.families.phasing.mendelian import main

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
