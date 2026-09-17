// Remote MCP endpoint (Streamable HTTP transport, JSON-RPC 2.0). Stateless: no
// sessions, no SSE — every POST gets exactly one JSON response. Dual-era: a
// request carrying modern per-request _meta (or server/discover) is served per
// the 2026-07-28 revision; an initialize handshake selects legacy semantics for
// 2025-11-25 and earlier clients. Tool names and
// descriptions mirror sci_envs/mcp_server.py (the stdio server) so an agent
// that knows one knows the other; the outputs are the same shapes the REST API
// returns (doVerify/doNormalize/doAllele/doMatch in handlers.js), so results
// are byte-identical between /v1/* and /mcp for the same input.
// Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).

import { FRAMEWORKS } from "./engine.js";
import { doVerify, doNormalize, doAllele, doMatch, doTypingCheck, doCompat, doGlString, doBetaSignup,
  MAX_TEXT, MAX_TYPINGS, MAX_NAME, MAX_GL_CHARS, MAX_EMAIL, MAX_ORG, MAX_USE_CASE, MAX_SOURCE } from "./handlers.js";
import { TIER_LIMITS } from "./keys.js";

// Modern revisions: version, client info and capabilities travel in every request's _meta.
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
// Legacy revisions: negotiated once by the initialize handshake. Newest first.
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...PROTOCOL_VERSIONS];
// The tool catalog only changes on deploy and is identical for every key.
const LIST_TTL_MS = 3600000;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const SERVER_INFO = { name: "hla-verify", version: "1.0.1" };
export const INSTRUCTIONS =
  "Nomenclature and reference-release validation for HLA: allele names, typing-report " +
  "consistency and match arithmetic, checked against a pinned IPD-IMGT/HLA release. No LLM " +
  "inside: every verdict is a table lookup. This is not a diagnostic aid and not clinical " +
  "decision support; it does not interpret a case or recommend a donor. What to send: allele " +
  "names, typing strings, GL strings and report text about HLA typing. What never to send: " +
  "patient identifiers of any kind, including names, medical record numbers, dates of birth, " +
  "accession or case identifiers, and other patient details. The service does not need them " +
  "and does not store request bodies; removing them before sending is the caller's " +
  "responsibility. Call verify_text on any AI-generated " +
  "or transcribed content that mentions HLA alleles before presenting it; call " +
  "normalize_allele or allele_info before asserting an allele name is valid or " +
  "current; call match_score instead of computing a donor-recipient match count " +
  "yourself. LLMs (including you) fabricate allele names and miscount matches — " +
  "verify HLA names before presenting them. The service is in free public beta: " +
  "call beta_signup to put your user on the list for paid keys, or point them at " +
  "hello@hlaverify.com for a beta key now.";

// ------------------------------------------------------------ output schemas
// outputSchema for each tool: the structuredContent shapes engine.js actually
// returns (checked against every fixture in test/mcp.test.mjs). Compliant clients
// REJECT a result that fails its schema, so these are deliberately permissive:
// `required` lists only keys present on every success, nullable keys allow null,
// no additionalProperties:false, and enums only on closed status/verdict sets.
// Keywords are limited to type/properties/required/items/enum/additionalProperties
// (+ description) — the subset the test's validator implements.

const STR = { type: "string" };
const STR_LIST = { type: "array", items: STR };
const RELEASE = { type: "string", description: "IPD-IMGT/HLA release every verdict was computed against." };
const ATTRIBUTION = { type: "string", description: "Data attribution (IPD-IMGT/HLA, CC-BY-ND)." };

// sci_envs/service/lab.py ligands(): row facts for class I (A/B/C) names only.
const LIGANDS = {
  type: "object",
  description: "Class I (A/B/C) ligand facts, aggregated over member alleles: 'ambiguous' when members disagree, 'unknown' when no residue data.",
  required: ["expressed", "leader_21", "residue_80", "bw", "c_group", "kir_ligand"],
  properties: {
    expressed: { type: "boolean", description: "false when every member allele is null (not expressed)." },
    leader_21: { type: "string", description: "Residue at leader position -21 (M or T; another letter is possible), ambiguous, unknown or not_expressed." },
    residue_80: { type: "string", description: "Residue at position 80 (amino-acid letter), ambiguous, unknown or not_expressed." },
    bw: { type: ["string", "null"], description: "Bw4 / Bw6 / non-Bw4 / unclassified / ambiguous / unknown / not_expressed; null for HLA-C." },
    c_group: { type: ["string", "null"], description: "C1 / C2 / unclassified / ambiguous / unknown; null when not applicable." },
    kir_ligand: { type: "string", description: "C1 / C2 / Bw4 / Bw4-80I / Bw4-80T / none / ambiguous / unknown." },
    ambiguities: { type: "object", description: "For each ambiguous field, the distinct member values.", additionalProperties: STR_LIST },
  },
};

const TYPING_ISSUE = {
  type: "object",
  required: ["severity", "locus", "code", "detail"],
  properties: {
    severity: { type: "string", enum: ["error", "warning", "info"], description: "Any error makes the typing invalid." },
    locus: { type: "string", description: "The locus key as reported." },
    code: { type: "string", description: "unresolvable, deprecated_name, locus_mismatch, null_allele, too_many_alleles, single_allele, homozygous, drb345_unexpected or drb345_not_reported." },
    detail: STR,
  },
};
const TYPING_ISSUES = { type: "array", items: TYPING_ISSUE };

const NORMALIZE_OUT = {
  type: "object",
  required: ["reported", "current_name", "allele_2field", "g_group", "flags"],
  properties: {
    reported: { type: "string", description: "The input, verbatim." },
    current_name: { type: "string", description: "Current full name in the pinned release, or UNRESOLVABLE." },
    allele_2field: { type: "string", description: "Current 2-field form, or UNRESOLVABLE. Never present an UNRESOLVABLE name as an allele." },
    g_group: { type: "string", description: "G group; NONE (no group), AMBIGUOUS (members differ) or UNRESOLVABLE." },
    flags: { type: "array", items: STR, description: "e.g. deprecated_name, nonexistent_allele, null_allele." },
  },
};

const VERIFY_OUT = {
  type: "object",
  required: ["release", "tokens", "counts", "clean"],
  properties: {
    release: RELEASE,
    clean: {
      type: "boolean",
      description: "The guardrail: true only when no token is hallucinated, fabricated_group or deleted. Gate on this before presenting the text.",
    },
    counts: {
      type: "object",
      description: "Number of distinct tokens per status.",
      required: ["valid", "deleted", "group", "fabricated_group", "hallucinated"],
      properties: {
        valid: { type: "integer" }, deleted: { type: "integer" }, group: { type: "integer" },
        fabricated_group: { type: "integer" }, hallucinated: { type: "integer" },
      },
    },
    tokens: {
      type: "array",
      description: "Each distinct allele-shaped token found, sorted by token.",
      items: {
        type: "object",
        required: ["token", "status", "note"],
        properties: {
          token: { type: "string", description: "The token without any HLA- prefix." },
          status: {
            type: "string", enum: ["valid", "group", "deleted", "fabricated_group", "hallucinated"],
            description: "valid: assigned (or a valid prefix); group: a real G/P group; deleted: no longer current (see successor); " +
              "fabricated_group: G/P-shaped but no such group; hallucinated: never existed in any release.",
          },
          note: { type: "string", description: "Human-readable meaning of status." },
          successor: { type: "string", description: "deleted: the name it was renamed to, when known." },
          current_2field: { type: "string", description: "valid/deleted tokens that resolve: current 2-field form." },
          g_group: { type: "string", description: "G group; NONE or AMBIGUOUS when there is no single group." },
          flags: STR_LIST,
        },
      },
    },
    attribution: ATTRIBUTION,
  },
};

const ALLELE_OUT = {
  type: "object",
  description: "Found: release, name, status and the status-specific fields. Never assigned: only `detail`.",
  properties: {
    detail: { type: "string", description: "Present only when the name is not assigned in this release (and then no other field is)." },
    release: RELEASE,
    name: STR,
    status: {
      type: "string", enum: ["assigned", "valid_prefix", "deleted"],
      description: "assigned: an exact allele in this release; valid_prefix: a lower-resolution prefix of assigned alleles; deleted: withdrawn or renamed (see successor).",
    },
    successor: { type: ["string", "null"], description: "deleted: the current name, or null if none." },
    g_group: { type: ["string", "null"], description: "assigned: G group, or null." },
    p_group: { type: ["string", "null"], description: "assigned: P group, or null." },
    first_release: { type: ["string", "null"], description: "assigned: first release the exact name appeared in." },
    confirmed: { type: "boolean", description: "assigned: confirmed (vs unconfirmed) allele." },
    serology: {
      type: "object", description: "assigned: WMDA serologic equivalents by column (non-empty columns only).",
      properties: { unambiguous: STR_LIST, possible: STR_LIST, assumed: STR_LIST, expert: STR_LIST },
      additionalProperties: STR_LIST,
    },
    null_allele: { type: "boolean", description: "assigned: true for an N (null, not expressed) allele." },
    ligands: LIGANDS,
    members_count: { type: "integer", description: "valid_prefix: number of assigned alleles under the prefix." },
    members_sample: { type: "array", items: STR, description: "valid_prefix: up to 10 member alleles." },
    attribution: ATTRIBUTION,
  },
};

const MATCH_OUT = {
  type: "object",
  required: ["release", "framework", "count", "verdicts", "hvg_mismatches", "gvh_mismatches", "flags"],
  properties: {
    release: RELEASE,
    framework: { type: "string", enum: Object.keys(FRAMEWORKS) },
    count: {
      type: "string",
      description: "'matched/total' over the resolvable loci only, or UNRESOLVABLE when none resolves. " +
        "Check verdicts for 'potential' loci before quoting it as a confident count.",
    },
    verdicts: {
      type: "object", description: "Framework locus -> verdict.",
      additionalProperties: {
        type: "string", enum: ["match", "mismatch", "potential"],
        description: "potential: typing missing or not resolvable at the framework's level; excluded from count.",
      },
    },
    hvg_mismatches: { type: "integer", description: "Host-versus-graft mismatches over non-potential loci." },
    gvh_mismatches: { type: "integer", description: "Graft-versus-host mismatches over non-potential loci." },
    flags: { type: "array", items: STR, description: "e.g. resolution_insufficient, null_allele, null_allele_mismatch." },
    attribution: ATTRIBUTION,
  },
};

const TYPING_OUT = {
  type: "object",
  required: ["release", "valid", "loci", "issues", "counts", "profile", "drb345"],
  properties: {
    release: RELEASE,
    valid: { type: "boolean", description: "true when there are no error-severity issues. Gate on this before using the typing." },
    loci: {
      type: "object", description: "Reported locus key -> one row per reported allele, in input order.",
      additionalProperties: {
        type: "array",
        items: {
          type: "object",
          required: ["reported", "status", "current_name", "allele_2field", "g_group", "flags", "antigen"],
          properties: {
            reported: STR,
            status: { type: "string", enum: ["ok", "renamed", "unresolvable"] },
            current_name: { type: "string", description: "Current name, or UNRESOLVABLE." },
            allele_2field: { type: "string", description: "Current 2-field form, or UNRESOLVABLE." },
            g_group: { type: "string", description: "G group; NONE, AMBIGUOUS or UNRESOLVABLE." },
            flags: STR_LIST,
            antigen: { type: "string", description: "WMDA serologic antigen, or 'null' (not expressed) / 'uncertain'." },
            ligands: LIGANDS,
          },
        },
      },
    },
    issues: TYPING_ISSUES,
    counts: {
      type: "object", required: ["error", "warning", "info"],
      properties: { error: { type: "integer" }, warning: { type: "integer" }, info: { type: "integer" } },
    },
    profile: {
      type: "object",
      required: ["b_leader_genotype", "c_kir_ligand_genotype", "kir_ligands_present", "kir_ligand_status"],
      properties: {
        b_leader_genotype: { type: ["string", "null"], description: "HLA-B -21 leader genotype such as M/T ('?' unknown); null when B is not typed." },
        c_kir_ligand_genotype: { type: ["string", "null"], description: "HLA-C KIR ligand genotype such as C1/C2 ('none', '?'); null when C is not typed." },
        kir_ligands_present: { type: "array", items: STR, description: "Sorted subset of C1, C2, Bw4, Bw4-80I, Bw4-80T." },
        kir_ligand_status: { type: "string", enum: ["complete", "incomplete"], description: "complete only with two classified alleles at each of A, B and C." },
      },
    },
    drb345: {
      type: ["object", "null"], description: "DRB3/4/5 expected from DRB1 vs reported; null when DRB1 is not typed.",
      required: ["expected", "reported", "determinate"],
      properties: { expected: STR_LIST, reported: STR_LIST, determinate: { type: "boolean" } },
    },
    attribution: ATTRIBUTION,
  },
};

const COMPAT_OUT = {
  type: "object",
  required: ["release", "b_leader", "kir_ligands", "recipient_valid", "donor_valid", "issues"],
  properties: {
    release: RELEASE,
    b_leader: {
      type: "object", required: ["recipient", "donor", "b_mismatches", "leader_match", "rule"],
      properties: {
        recipient: { type: ["string", "null"], description: "Recipient HLA-B leader genotype, e.g. M/T; null when B is not typed." },
        donor: { type: ["string", "null"], description: "Donor HLA-B leader genotype; null when B is not typed." },
        b_mismatches: { type: ["integer", "null"], description: "HLA-B mismatch count; null when B is missing, over-typed or unresolvable on either side." },
        leader_match: {
          type: ["boolean", "null"],
          description: "Set only for exactly one HLA-B mismatch with a known M/T leader on both mismatched alleles; otherwise null (not assessable).",
        },
        rule: STR,
      },
    },
    kir_ligands: {
      type: "object", required: ["recipient", "donor", "missing_in_recipient", "missing_in_donor", "status", "rule"],
      properties: {
        recipient: { type: "array", items: STR, description: "KIR ligand classes present (C1, C2, Bw4)." },
        donor: STR_LIST, missing_in_recipient: STR_LIST, missing_in_donor: STR_LIST,
        status: { type: "string", enum: ["complete", "incomplete"], description: "Treat missing_in_* as provisional unless complete." },
        rule: STR,
      },
    },
    recipient_valid: { type: "boolean", description: "Recipient typing QC had no errors." },
    donor_valid: { type: "boolean", description: "Donor typing QC had no errors." },
    issues: {
      type: "object", required: ["recipient", "donor"],
      properties: { recipient: TYPING_ISSUES, donor: TYPING_ISSUES },
    },
    attribution: ATTRIBUTION,
  },
};

const GL_OUT = {
  type: "object",
  required: ["release", "valid", "normalized_gl", "changed", "loci", "alleles", "issues", "counts"],
  properties: {
    release: RELEASE,
    valid: { type: "boolean", description: "true when there are no error-severity issues." },
    normalized_gl: { type: "string", description: "The GL String with outdated names replaced by current ones." },
    changed: { type: "boolean", description: "normalized_gl differs from the trimmed input." },
    loci: STR_LIST,
    alleles: {
      type: "array", description: "Each distinct allele token, in first-seen order.",
      items: {
        type: "object", required: ["token", "status", "current_name", "locus"],
        properties: {
          token: STR,
          status: { type: "string", enum: ["valid", "renamed", "group", "unresolvable"] },
          current_name: { type: ["string", "null"], description: "null when unresolvable." },
          locus: { type: ["string", "null"] },
        },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object", required: ["severity", "code", "detail"],
        properties: {
          severity: { type: "string", enum: ["error", "warning"] },
          code: {
            type: "string",
            description: "unresolvable_allele, renamed_allele, whitespace_in_name, empty_element, mixed_locus_allele_list, haplotype_repeats_locus, " +
              "genotype_loci_differ, more_than_two_haplotypes, genotype_list_loci_differ or locus_repeated_across_blocks.",
          },
          detail: STR,
        },
      },
    },
    counts: {
      type: "object", required: ["error", "warning"],
      properties: { error: { type: "integer" }, warning: { type: "integer" } },
    },
    attribution: ATTRIBUTION,
  },
};

const ABOUT_OUT = {
  type: "object",
  required: ["name", "release"],
  properties: { name: STR, release: RELEASE, scope: STR, inputs: STR, why: STR, code: STR, api: STR, demo: STR,
    agents: STR, limits: STR, commercial: STR, disclaimer: STR, beta: STR, beta_key: STR, beta_signup: STR },
};

const BETA_OUT = {
  type: "object",
  required: ["ok", "status", "message", "release"],
  properties: {
    ok: { type: "boolean", description: "Always true; a rejected signup comes back as an error result." },
    status: { type: "string", enum: ["recorded", "already_recorded"],
      description: "already_recorded: the address was already on the list. Both are success — do not retry." },
    message: { type: "string", description: "What to tell the user, including how to get a beta key today." },
    release: RELEASE,
  },
};

const OUTPUT_SCHEMAS = {
  verify_text: VERIFY_OUT, normalize_allele: NORMALIZE_OUT, allele_info: ALLELE_OUT, match_score: MATCH_OUT,
  check_typing: TYPING_OUT, donor_compat: COMPAT_OUT, validate_gl_string: GL_OUT, beta_signup: BETA_OUT, about: ABOUT_OUT,
};

// Every typing input is the same shape and carries the same rule about what may
// be in it, so it is written once here rather than five times below.
const TYPING_IN = {
  type: "object",
  description: "locus -> up to 4 reported allele names. Allele strings only: never patient names, " +
    "medical record numbers, dates of birth, or accession or case identifiers.",
  additionalProperties: { type: "array", items: { type: "string" } },
};

function toolDefs() {
  return [
    {
      name: "verify_text",
      description:
        "Scan HLA typing report text, or model output about HLA, for allele-shaped tokens and " +
        "classify each one: valid / legacy (with modern form) / deleted (with successor) / " +
        "fabricated. Nomenclature checking against a pinned IPD-IMGT/HLA release, not " +
        "interpretation of a case. Use on any AI-generated or transcribed content mentioning " +
        "HLA. Send the HLA content only, with patient identifiers removed first.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", maxLength: MAX_TEXT, description:
          "HLA typing report text, or model output about HLA typing, to scan for allele names. " +
          "Send the HLA content only: strip patient names, medical record numbers, dates of birth, " +
          "accession and case identifiers, and any other patient details before sending. The caller " +
          "is responsible for de-identifying the text; this service neither needs nor wants " +
          "identifiers and does not store request bodies." } },
        additionalProperties: false,
      },
    },
    {
      name: "normalize_allele",
      description:
        "Normalize one reported HLA allele name (any era) to current 2-field form, " +
        "with G group, P group, serologic equivalent, and flags.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", maxLength: MAX_NAME, description:
          "One reported HLA allele name, any nomenclature era. An allele string only, never a patient name, " +
          "medical record number or other identifier." } },
        additionalProperties: false,
      },
    },
    {
      name: "allele_info",
      description:
        "Look up one exact name in the pinned release and return what it is: " +
        "assigned (G/P group, first release, confirmed status, WMDA serology, null flag), " +
        "valid_prefix (member count and sample), or deleted (successor). Not found if the " +
        "name has never existed in any release.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", maxLength: MAX_NAME, description:
          "Exact HLA allele name, a lower-resolution prefix, or a deleted name. An allele string only, " +
          "never a patient name, medical record number or other identifier." } },
        additionalProperties: false,
      },
    },
    {
      name: "match_score",
      description:
        "Count a donor-recipient HLA match by the published counting rules (R1-R6): allele " +
        "arithmetic over chromosomes, not a donor recommendation. " +
        'recipient/donor: {"A": ["A*01:01","A*02:01"], "B": [...], ...} (two reported ' +
        "alleles per locus, any nomenclature era; allele strings only, no patient identifiers). " +
        "framework: 6/6, 8/8, 10/10, 12/12, " +
        "or antigen. Returns count, per-locus verdicts, GvH/HvG mismatch counts, and " +
        "flags; unresolvable typing yields 'potential', never a confident count.",
      inputSchema: {
        type: "object",
        required: ["recipient", "donor"],
        properties: {
          recipient: TYPING_IN,
          donor: TYPING_IN,
          framework: { type: "string", enum: Object.keys(FRAMEWORKS), default: "8/8" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "check_typing",
      description:
        "QC-check one HLA typing (all loci) against the pinned release: resolves every " +
        "reported allele, flags unresolvable/outdated/locus-mismatched/null alleles, flags " +
        "too-many/single/homozygous per locus, computes the B-leader (-21 M/T) and " +
        'KIR-ligand (C1/C2/Bw4) profile, and DRB3/4/5 expected-vs-reported. Nomenclature and ' +
        "internal-consistency checking of the report, not clinical interpretation. typing: " +
        '{"A": ["A*01:01", "A*02:01"], "B": [...], "DRB1": [...], ...} (any nomenclature era; ' +
        "allele strings only, no patient identifiers).",
      inputSchema: {
        type: "object",
        required: ["typing"],
        properties: {
          typing: TYPING_IN,
        },
        additionalProperties: false,
      },
    },
    {
      name: "donor_compat",
      description:
        "Donor/recipient immunogenetic compatibility under two published rule sets: HLA-B " +
        "leader match (-21 M/T, Petersdorf 2020) for a single HLA-B mismatch, and KIR ligand " +
        "(C1/C2/Bw4) class comparison, computed over each side's full typing QC. Rule " +
        "checking against published frameworks; it does not rank or recommend a donor. " +
        'recipient/donor: {"A": [...], "B": [...], "C": [...], "DRB1": [...], ...} ' +
        "(allele strings only, no patient identifiers). " +
        "Decision support only; not a medical device.",
      inputSchema: {
        type: "object",
        required: ["recipient", "donor"],
        properties: {
          recipient: TYPING_IN,
          donor: TYPING_IN,
        },
        additionalProperties: false,
      },
    },
    {
      name: "validate_gl_string",
      description:
        "Validate and normalize a GL String (Genotype List, ^ | + ~ / grammar): resolves " +
        "every allele token, flags outdated/unresolvable names and structural problems " +
        "(mixed loci within a slash-list, a repeated locus within a haplotype or across " +
        "^ blocks, more than two haplotypes, differing loci across a genotype or genotype " +
        "list, empty elements), and returns the normalized string. Grammar and nomenclature " +
        "checking only; send allele names, not patient identifiers.",
      inputSchema: {
        type: "object",
        required: ["gl"],
        properties: { gl: { type: "string", maxLength: MAX_GL_CHARS, description:
          "GL String to validate and normalize. Allele names and GL grammar only, never patient identifiers." } },
        additionalProperties: false,
      },
    },
    {
      name: "beta_signup",
      description:
        "Put a user on the free public beta's notification list for paid API keys. " +
        "Ask before calling: it records the address they give you. Re-signing the same " +
        "address is safe (status already_recorded). Someone who needs a higher rate limit " +
        "today should email hello@hlaverify.com for a beta key instead of waiting.",
      inputSchema: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", maxLength: MAX_EMAIL, description: "The user's email address." },
          org: { type: "string", maxLength: MAX_ORG, description: "Lab, company or institution (optional)." },
          use_case: { type: "string", maxLength: MAX_USE_CASE, description: "What they would use the API for (optional). No patient details." },
          source: { type: "string", maxLength: MAX_SOURCE, description: "Where the signup came from, e.g. mcp (optional)." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "about",
      description: "What this server is and is not, what to send it, benchmark evidence for why to use it, the beta state, and terms.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ].map((t) => ({ ...t, outputSchema: OUTPUT_SCHEMAS[t.name],
    annotations: t.name === "beta_signup" ? WRITE_ANNOTATIONS : TOOL_ANNOTATIONS }));
}

// Every lookup tool is a pure read of the pinned release: nothing written, same answer twice.
const TOOL_ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
// beta_signup is the one tool that writes (one address to the beta list). Still
// idempotent — the second call on the same address records nothing new.
const WRITE_ANNOTATIONS = { readOnlyHint: false, idempotentHint: true, openWorldHint: false };

function aboutBody(manifest) {
  return {
    name: "HLA-Verify",
    release: manifest.release,
    scope: "Nomenclature and reference-release validation: allele names, typing-report consistency and match arithmetic, " +
      "checked against a pinned IPD-IMGT/HLA release. Not a diagnostic aid, not clinical decision support, and it does not " +
      "recommend a donor.",
    inputs: "Send allele names, typing strings, GL strings and report text about HLA typing. Never send patient identifiers: " +
      "this service neither needs nor wants names, medical record numbers, dates of birth, accession or case identifiers, or " +
      "other patient details. Request bodies are processed in memory and not stored; de-identifying before sending is the " +
      "caller's responsibility.",
    why: "Every LLM family tested scores 0% on 2-field ambiguity expansion and fabricates allele names at 0.05-0.14/task (HLA-Bench).",
    code: "https://github.com/jasonbrelsford/verifiable-science-envs",
    api: "https://api.hlaverify.com/docs",
    demo: "https://hlaverify.com/demo",
    agents: "https://hlaverify.com/llms.txt",
    limits: "Per UTC day, per tier: " +
      Object.entries(TIER_LIMITS).map(([t, l]) =>
        `${t} (${l.price}) ${l.calls === null ? "uncapped" : l.calls.toLocaleString("en-US")} calls/day, ` +
        `up to ${l.typings.toLocaleString("en-US")} typings per normalize call, ${l.burst}`).join("; ") +
      ". 'pro' is the legacy name for 'lab' and keeps Lab's limits. Every billable response carries " +
      "x-hla-verify-tier, -daily-limit, -daily-remaining, -daily-reset and -max-typings; a spent quota comes " +
      "back as a tool error naming the UTC-midnight reset time — wait for it or upgrade, do not retry in a loop. " +
      "about and beta_signup are free and never consume quota. Pricing: https://api.hlaverify.com/pricing.",
    beta: `Free public beta — verdicts are production-quality and pinned to IPD-IMGT/HLA ${manifest.release}. ` +
      `Anonymous access is ${TIER_LIMITS.free.calls} calls/day per IP and 60 requests/minute with no key; paid keys ` +
      "with higher daily quotas and larger batches arrive within days.",
    beta_key: "A beta key is a hand-issued API key at a paid tier's rate limit, free during the beta: email hello@hlaverify.com.",
    beta_signup: "https://hlaverify.com/beta — or call the beta_signup tool to join the list from here.",
    commercial: "hello@hlaverify.com (Brelsford Software LLC)",
    disclaimer: "Research-and-evaluation tool; not a medical device.",
  };
}

function okResult(structured, units) {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, units };
}
function errResult(detail) {
  return { isError: true, content: [{ type: "text", text: detail }], units: 0 };
}

// `beta` is the only write path's context: {env, country} from handleMcp, so the
// beta_signup tool reaches the same KV namespace and the same cf-ipcountry value
// as POST /v1/beta-signup. Null when this module is driven standalone (tests).
async function callTool(name, args, eng, manifest, beta) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return errResult("arguments must be an object");

  switch (name) {
    case "verify_text": {
      const r = await doVerify(eng, manifest, args.text);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "normalize_allele": {
      if (typeof args.name !== "string") return errResult("name must be a string");
      const r = await doNormalize(eng, manifest, [args.name]);
      return r.ok ? okResult(r.body.rows[0], 1) : errResult(r.detail);
    }
    case "allele_info": {
      if (typeof args.name !== "string") return errResult("name must be a string");
      const r = await doAllele(eng, manifest, args.name);
      return r.ok ? okResult(r.body, 1) : errResult(r.detail);
    }
    case "match_score": {
      const r = await doMatch(eng, manifest, args.framework, args.recipient, args.donor);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "check_typing": {
      const r = await doTypingCheck(eng, manifest, args.typing);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "donor_compat": {
      const r = await doCompat(eng, manifest, args.recipient, args.donor);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "validate_gl_string": {
      if (typeof args.gl !== "string") return errResult("gl must be a string");
      const r = await doGlString(eng, manifest, args.gl);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "beta_signup": {
      const r = await doBetaSignup(beta && beta.env, manifest, args, beta && beta.country);
      return r.ok ? okResult(r.body, r.units) : errResult(r.detail);
    }
    case "about":
      return okResult(aboutBody(manifest), 0);
    default:
      return errResult(`unknown tool: ${name}`);
  }
}

function rpcResult(id, result, status = 200) {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result }, status);
}
function rpcError(id, code, message, { data, status } = {}) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error }, status ?? (code === -32700 || code === -32600 ? 400 : 200));
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// handleMcp(request, engine, who, manifest, onCall?, env?, spend?) -> Response
// onCall(toolName, httpishStatus, units) is an optional metering hook invoked
// once per tools/call so the caller (index.js) can record usage the same way
// it meters REST calls; it is a no-op by default so this module works standalone
// (as it does in the golden tests, which call it directly with a synthetic Request).
// env is the Worker environment, needed only by beta_signup (the KEYS binding);
// omitted, that one tool reports the beta list as unavailable and every other
// tool behaves identically.
// spend(toolName) is the daily-quota hook (index.js): it charges one call
// against the caller's quota and returns null to proceed, or the refusal text
// when the quota is spent. Charged per billable tools/call, so a handshake,
// tools/list or server/discover is free, exactly as /docs is on REST. A refusal
// comes back as an ordinary tool result with isError:true — a frame every MCP
// client can read and every agent can act on — carried on HTTP 429, the status
// this endpoint has always used for a limit.
export async function handleMcp(request, engine, who, manifest, onCall = () => {}, env = null, spend = null) {
  const beta = { env, country: request.headers.get("cf-ipcountry") };
  let raw;
  try {
    raw = await request.text();
  } catch (_) {
    raw = "";
  }

  let msg;
  try {
    msg = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return rpcError(null, -32700, "Parse error");
  }

  if (Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request: batch requests are not supported");
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return rpcError(msg && typeof msg === "object" ? msg.id : null, -32600, "Invalid Request");

  const { method, params, id } = msg;

  const metaVersion = params && params._meta && params._meta[META_VERSION];
  if (metaVersion !== undefined || method === "server/discover")
    return handleModern(request, msg, metaVersion, engine, manifest, onCall, beta, spend);

  if (method === "notifications/initialized") return new Response(null, { status: 202 });

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
    return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: toolDefs() });

  if (method === "tools/call") {
    const name = params && params.name;
    if (typeof name !== "string" || !name) return rpcError(id, -32602, "Invalid params: params.name (string) is required");
    const { out, overQuota } = await runTool(name, params.arguments, engine, manifest, onCall, beta, spend);
    return rpcResult(id, out, overQuota ? 429 : 200);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// Returns { out, overQuota }: the tool result to put in the JSON-RPC frame, and
// whether it is a quota refusal (which the caller renders as HTTP 429).
async function runTool(name, args, engine, manifest, onCall, beta, spend = null) {
  const refusal = spend ? await spend(name) : null;
  if (refusal) {
    onCall(name, 429, 0);
    return { out: { content: [{ type: "text", text: refusal }], isError: true }, overQuota: true };
  }
  const result = await callTool(name, args, engine, manifest, beta);
  onCall(name, result.isError ? 422 : 200, result.units ?? 0);
  const out = { content: result.content, isError: result.isError };
  if (!result.isError) out.structuredContent = result.structuredContent;
  return { out, overQuota: false };
}

// Mcp-Name may carry a non-header-safe name as =?base64?<UTF-8 base64>?=.
function decodeHeaderValue(v) {
  if (v === null || !v.startsWith("=?base64?") || !v.endsWith("?=")) return v;
  try {
    const bytes = Uint8Array.from(atob(v.slice(9, -2)), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    return null;
  }
}

// 2026-07-28: no handshake, no ping. Every request names its protocol version in
// _meta, which must agree with the MCP-Protocol-Version / Mcp-Method / Mcp-Name
// headers so gateways routing on headers and this handler see the same request.
async function handleModern(request, msg, metaVersion, engine, manifest, onCall, beta, spend = null) {
  const { method, params, id } = msg;
  const h = request.headers;
  const mismatch = (message) => rpcError(id, HEADER_MISMATCH, `Header mismatch: ${message}`, { status: 400 });

  // server/discover is the era probe, so answer it even from a client that sent no _meta.
  const version = metaVersion ?? MODERN_PROTOCOL_VERSIONS[0];
  if (metaVersion !== undefined) {
    const hv = h.get("mcp-protocol-version");
    if (hv === null) return mismatch("MCP-Protocol-Version header is required");
    if (hv !== metaVersion) return mismatch(`MCP-Protocol-Version header value '${hv}' does not match body value '${metaVersion}'`);
    const hm = h.get("mcp-method");
    if (hm === null) return mismatch("Mcp-Method header is required");
    if (hm !== method) return mismatch(`Mcp-Method header value '${hm}' does not match body value '${method}'`);
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version))
    return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
      { data: { supported: SUPPORTED_VERSIONS, requested: String(version) }, status: 400 });

  const complete = (result, status = 200) =>
    rpcResult(id, { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } }, status);

  if (method === "server/discover")
    return complete({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS,
      ttlMs: LIST_TTL_MS, cacheScope: "public" });

  if (method === "tools/list") return complete({ tools: toolDefs(), ttlMs: LIST_TTL_MS, cacheScope: "public" });

  if (method === "tools/call") {
    const name = params.name;
    if (typeof name !== "string" || !name) return rpcError(id, -32602, "Invalid params: params.name (string) is required");
    const hn = decodeHeaderValue(h.get("mcp-name"));
    if (hn === null) return mismatch("Mcp-Name header is required for tools/call");
    if (hn !== name) return mismatch(`Mcp-Name header value '${hn}' does not match body value '${name}'`);
    const { out, overQuota } = await runTool(name, params.arguments, engine, manifest, onCall, beta, spend);
    return complete(out, overQuota ? 429 : 200);
  }

  return rpcError(id, -32601, `Method not found: ${method}`, { status: 404 });
}
