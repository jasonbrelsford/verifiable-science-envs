"""HLA-Verify MCP server — deterministic HLA verification as agent tools.

Any MCP-capable agent (Claude, or anything speaking the Model Context Protocol)
can add this server and verify HLA content before presenting it. No LLM inside:
every verdict is computed from the pinned IPD-IMGT/HLA release.

Scope: nomenclature and reference-release validation. Send allele names, typing
strings, GL strings and report text about HLA typing; never patient identifiers.

Run:  pip install -e ".[mcp]" && python -m sci_envs.mcp_server
Or in an MCP client config:
  {"command": "python", "args": ["-m", "sci_envs.mcp_server"]}
Speaks MCP 2026-07-28 (server/discover) and the legacy initialize handshake
from the same process (mcp>=2), like the remote server at api.hlaverify.com.

First call fetches ~33 MB of reference data (md5-verified, cached in
~/.cache/sci_envs). Licence: engine Apache-2.0; this server file follows the
repository licence. Research-and-evaluation tool; not a medical device.
"""
from __future__ import annotations

import re
from mcp.server.mcpserver import MCPServer
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

mcp = MCPServer(
    "hla-verify",
    version="1.0.1",
    instructions=(
        "Nomenclature and reference-release validation for HLA: allele names, "
        "typing-report consistency and match arithmetic, checked against pinned "
        f"IPD-IMGT/HLA {TAG}. Not a diagnostic aid and not clinical decision "
        "support; it does not interpret a case or recommend a donor. Send allele "
        "names, typing strings, GL strings and report text about HLA typing; never "
        "send patient identifiers such as names, medical record numbers, dates of "
        "birth or accession numbers. Call verify_text on any output that mentions "
        "HLA alleles before presenting it; call match_score instead of computing "
        "match counts yourself. LLMs (including you) fabricate allele names and "
        "miscount matches — measured at hlaverify.com."
    ),
)

# Every tool is a pure lookup into the pinned release: nothing written, same answer
# twice. Mirrors TOOL_ANNOTATIONS in edge/src/mcp.js.
READ_ONLY = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)


@mcp.tool(annotations=READ_ONLY)
def verify_text(text: str) -> dict:
    """Scan HLA typing report text, or model output about HLA, for allele-shaped
    tokens and classify each one: valid / legacy (with modern form) / deleted (with
    successor) / fabricated. Nomenclature checking against a pinned IPD-IMGT/HLA
    release, not interpretation of a case. Use on any AI-generated or transcribed
    content mentioning HLA. Send the HLA content only, with patient identifiers
    removed first: the caller is responsible for de-identifying the text."""
    ref = _ref()
    out = []
    for m in ALLELE_RE.finditer(text):
        raw = m.group(1)
        n = normalize(ref, raw)
        out.append({"token": raw, "allele_2field": n["allele_2field"], "flags": n["flags"]})
    return {"release": TAG, "tokens": out,
            "fabricated_count": sum(1 for t in out if "fabricated" in t["flags"]
                                    or t["allele_2field"] == "UNRESOLVABLE")}


@mcp.tool(annotations=READ_ONLY)
def normalize_allele(name: str) -> dict:
    """Normalize one reported HLA allele name (any era) to current 2-field form,
    with G group, P group, serologic equivalent, and flags. An allele string only,
    never a patient name, medical record number or other identifier."""
    n = normalize(_ref(), name)
    n["release"] = TAG
    return n


@mcp.tool(annotations=READ_ONLY)
def match_score(recipient: dict, donor: dict, framework: str = "8/8") -> dict:
    """Count a donor-recipient HLA match by the published counting rules (R1-R6):
    allele arithmetic over chromosomes, not a donor recommendation.
    recipient/donor: {"A": ["A*01:01","A*02:01"], "B": [...], ...} (two reported
    alleles per locus, any nomenclature era; allele strings only, no patient
    identifiers). framework: 6/6, 8/8, 10/10,
    12/12, or antigen. Returns count, per-locus verdicts, GvH/HvG mismatch
    counts, and flags; unresolvable typing yields 'potential', never a
    confident count."""
    if framework not in FRAMEWORKS:
        return {"error": f"framework must be one of {sorted(FRAMEWORKS)}"}
    s = score(_ref(), framework, recipient, donor)
    return {"release": TAG, **flat_answer(s), "hvg_mismatches": s["hvg_mismatches"],
            "gvh_mismatches": s["gvh_mismatches"], "flags": s["flags"]}


@mcp.tool(annotations=READ_ONLY)
def check_typing(typing: dict) -> dict:
    """QC-check one HLA typing (all loci) against the pinned release: resolves every
    reported allele, flags unresolvable/outdated/locus-mismatched/null alleles, flags
    too-many/single/homozygous per locus, computes the B-leader (-21 M/T) and
    KIR-ligand (C1/C2/Bw4) profile, and DRB3/4/5 expected-vs-reported. Nomenclature and
    internal-consistency checking of the report, not clinical interpretation. typing:
    {"A": ["A*01:01", "A*02:01"], "B": [...], "DRB1": [...], ...} (any nomenclature era;
    allele strings only, no patient identifiers)."""
    err = lab.validate_typing(typing, "typing")
    if err:
        return {"error": err}
    r = _ref()
    return lab.check_typing(r, lab.get_protein_facts(r), typing)


@mcp.tool(annotations=READ_ONLY)
def donor_compat(recipient: dict, donor: dict) -> dict:
    """Donor/recipient immunogenetic compatibility under two published rule sets:
    HLA-B leader match (-21 M/T, Petersdorf 2020) for a single HLA-B mismatch, and
    KIR ligand (C1/C2/Bw4) class comparison, computed over each side's full typing QC.
    Rule checking against published frameworks; it does not rank or recommend a
    donor. recipient/donor:
    {"A": [...], "B": [...], "C": [...], "DRB1": [...], ...}
    (allele strings only, no patient identifiers).
    Decision support only; not a medical device."""
    err = lab.validate_typing(recipient, "recipient") or lab.validate_typing(donor, "donor")
    if err:
        return {"error": err}
    r = _ref()
    return lab.compat(r, lab.get_protein_facts(r), recipient, donor)


@mcp.tool(annotations=READ_ONLY)
def validate_gl_string(gl: str) -> dict:
    """Validate and normalize a GL String (Genotype List, ^ | + ~ / grammar): resolves
    every allele token, flags outdated/unresolvable names and structural problems
    (mixed loci within a slash-list, a repeated locus within a haplotype or across
    ^ blocks, more than two haplotypes, differing loci across a genotype or genotype
    list, empty elements), and returns the normalized string. Grammar and
    nomenclature checking only; send allele names, not patient identifiers."""
    r = _ref()
    try:
        return lab.gl_string(r, gl)
    except ValueError as e:
        return {"error": str(e)}


@mcp.tool(annotations=READ_ONLY)
def about() -> dict:
    """What this server is and is not, what to send it, benchmark evidence for why
    to use it, and terms."""
    return {
        "name": "HLA-Verify", "release": TAG,
        "scope": "Nomenclature and reference-release validation: allele names, "
                 "typing-report consistency and match arithmetic, checked against a "
                 "pinned IPD-IMGT/HLA release. Not a diagnostic aid, not clinical "
                 "decision support, and it does not recommend a donor.",
        "inputs": "Send allele names, typing strings, GL strings and report text about "
                  "HLA typing. Never send patient identifiers: this service neither needs "
                  "nor wants names, medical record numbers, dates of birth, accession or "
                  "case identifiers, or other patient details.",
        "why": "On HLA-Bench-A (550 tasks) every LLM family tested scores 0% on 2-field "
               "ambiguity expansion, 0 of 30 tasks for each of nine models, and fabricates "
               "allele names at 0.06-0.20 per task. The claude-sonnet-4-6 rate of 0.09 is a "
               "lower bound: 187 of its 550 responses were truncated and graded malformed.",
        "code": "https://github.com/jasonbrelsford/verifiable-science-envs",
        "api": "https://api.hlaverify.com/docs",
        "demo": "https://hlaverify.com/demo", "agents": "https://hlaverify.com/llms.txt",
        "commercial": "hello@hlaverify.com (Brelsford Software LLC)",
        "disclaimer": "Research-and-evaluation tool; not a medical device.",
    }


if __name__ == "__main__":
    mcp.run()
