"""HLA-Verify MCP server — deterministic HLA verification as agent tools.

Any MCP-capable agent (Claude, or anything speaking the Model Context Protocol)
can add this server and verify HLA content before presenting it. No LLM inside:
every verdict is computed from the pinned IPD-IMGT/HLA release.

Run:  pip install -e ".[mcp]" && python -m sci_envs.mcp_server
Or in an MCP client config:
  {"command": "python", "args": ["-m", "sci_envs.mcp_server"]}

First call fetches ~33 MB of reference data (md5-verified, cached in
~/.cache/sci_envs). Licence: engine Apache-2.0; this server file follows the
repository licence. Research-and-evaluation tool; not a medical device.
"""
from __future__ import annotations

import re
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from sci_envs.reference.imgt import ImgtReference
from sci_envs.families.nomenclature.normalize import normalize
from sci_envs.families.matching.rules import FRAMEWORKS, flat_answer, score
from sci_envs.service import lab

TAG = "v3.65.0-alpha"
_REF: ImgtReference | None = None


def _ref() -> ImgtReference:
    global _REF
    if _REF is None:
        _REF = ImgtReference.load(TAG)
    return _REF


ALLELE_RE = re.compile(r"\b(?:HLA-)?((?:[A-Z]+[0-9]?|Cw)\*[0-9:A-Z]+)\b")


# Every tool below is a pure, read-only lookup against the pinned IMGT/HLA release: no
# writes, no external calls, no side effects. Claude Connectors Directory requires a
# `title` and the applicable readOnlyHint/destructiveHint annotation on every tool
# (see docs/CLAUDE-CONNECTOR.md section 5); openWorldHint is False because tools never
# consult the open web, only our own pinned tables.
def _ro(title: str) -> ToolAnnotations:
    return ToolAnnotations(title=title, readOnlyHint=True, destructiveHint=False, openWorldHint=False)

mcp = FastMCP(
    "hla-verify",
    instructions=(
        "Deterministic HLA verification against pinned IPD-IMGT/HLA "
        f"{TAG}. Call verify_text on any output that mentions HLA alleles "
        "before presenting it; call match_score instead of computing match "
        "counts yourself. LLMs (including you) fabricate allele names and "
        "miscount matches — measured at hlaverify.com."
    ),
)


@mcp.tool(title="Verify HLA alleles in text", annotations=_ro("Verify HLA alleles in text"))
def verify_text(text: str) -> dict:
    """Scan free text for HLA allele-shaped tokens and classify each one:
    valid / legacy (with modern form) / deleted (with successor) / fabricated.
    Use on any AI-generated or transcribed content mentioning HLA."""
    ref = _ref()
    out = []
    for m in ALLELE_RE.finditer(text):
        raw = m.group(1)
        n = normalize(ref, raw)
        out.append({"token": raw, "allele_2field": n["allele_2field"], "flags": n["flags"]})
    return {"release": TAG, "tokens": out,
            "fabricated_count": sum(1 for t in out if "fabricated" in t["flags"]
                                    or t["allele_2field"] == "UNRESOLVABLE")}


@mcp.tool(title="Normalize an HLA allele name", annotations=_ro("Normalize an HLA allele name"))
def normalize_allele(name: str) -> dict:
    """Normalize one reported HLA allele name (any era) to current 2-field form,
    with G group, P group, serologic equivalent, and flags."""
    n = normalize(_ref(), name)
    n["release"] = TAG
    return n


@mcp.tool(title="Score a donor-recipient HLA match", annotations=_ro("Score a donor-recipient HLA match"))
def match_score(recipient: dict, donor: dict, framework: str = "8/8") -> dict:
    """Score a donor-recipient HLA match with the published rules (R1-R6).
    recipient/donor: {"A": ["A*01:01","A*02:01"], "B": [...], ...} (two reported
    alleles per locus, any nomenclature era). framework: 6/6, 8/8, 10/10,
    12/12, or antigen. Returns count, per-locus verdicts, GvH/HvG mismatch
    counts, and flags; unresolvable typing yields 'potential', never a
    confident count."""
    if framework not in FRAMEWORKS:
        return {"error": f"framework must be one of {sorted(FRAMEWORKS)}"}
    s = score(_ref(), framework, recipient, donor)
    return {"release": TAG, **flat_answer(s), "hvg_mismatches": s["hvg_mismatches"],
            "gvh_mismatches": s["gvh_mismatches"], "flags": s["flags"]}


@mcp.tool(title="QC-check an HLA typing", annotations=_ro("QC-check an HLA typing"))
def check_typing(typing: dict) -> dict:
    """QC-check one HLA typing (all loci) against the pinned release: resolves every
    reported allele, flags unresolvable/outdated/locus-mismatched/null alleles, flags
    too-many/single/homozygous per locus, computes the B-leader (-21 M/T) and
    KIR-ligand (C1/C2/Bw4) profile, and DRB3/4/5 expected-vs-reported. typing:
    {"A": ["A*01:01", "A*02:01"], "B": [...], "DRB1": [...], ...} (any nomenclature era)."""
    err = lab.validate_typing(typing, "typing")
    if err:
        return {"error": err}
    r = _ref()
    return lab.check_typing(r, lab.get_protein_facts(r), typing)


@mcp.tool(title="Check donor-recipient compatibility", annotations=_ro("Check donor-recipient compatibility"))
def donor_compat(recipient: dict, donor: dict) -> dict:
    """Donor/recipient immunogenetic compatibility: HLA-B leader match (-21 M/T,
    Petersdorf 2020) for a single HLA-B mismatch, and KIR ligand (C1/C2/Bw4)
    comparison, computed over each side's full typing QC. recipient/donor:
    {"A": [...], "B": [...], "C": [...], "DRB1": [...], ...}.
    Decision support only; not a medical device."""
    err = lab.validate_typing(recipient, "recipient") or lab.validate_typing(donor, "donor")
    if err:
        return {"error": err}
    r = _ref()
    return lab.compat(r, lab.get_protein_facts(r), recipient, donor)


@mcp.tool(title="Validate a GL String", annotations=_ro("Validate a GL String"))
def validate_gl_string(gl: str) -> dict:
    """Validate and normalize a GL String (Genotype List, ^ | + ~ / grammar): resolves
    every allele token, flags outdated/unresolvable names and structural problems
    (mixed loci within a slash-list, a repeated locus within a haplotype or across
    ^ blocks, more than two haplotypes, differing loci across a genotype or genotype
    list, empty elements), and returns the normalized string."""
    r = _ref()
    try:
        return lab.gl_string(r, gl)
    except ValueError as e:
        return {"error": str(e)}


@mcp.tool(title="About HLA-Verify", annotations=_ro("About HLA-Verify"))
def about() -> dict:
    """What this server is, benchmark evidence for why to use it, and terms."""
    return {
        "name": "HLA-Verify", "release": TAG,
        "why": "Every LLM family tested scores 0% on 2-field ambiguity expansion "
               "and fabricates allele names at 0.05-0.14/task (HLA-Bench).",
        "code": "https://github.com/jasonbrelsford/verifiable-science-envs",
        "api": "https://api.hlaverify.com/docs",
        "demo": "https://hlaverify.com/demo", "agents": "https://hlaverify.com/llms.txt",
        "commercial": "hello@hlaverify.com (Brelsford Software LLC)",
        "disclaimer": "Research-and-evaluation tool; not a medical device.",
    }


if __name__ == "__main__":
    mcp.run()
