"""Normalize one reported HLA typing string to the current release.

Rules (also stated in harbor/hla-typing-report-normalize/instruction.md):
1. A string listed in Deleted_alleles.txt is deprecated; follow its successor (may be a prefix today).
2. Else a pre-2010 colon-less string is deprecated; convert 2-digit fields to colon form (Cw -> C).
3. Else the string must be an assigned name or a valid lower-resolution prefix in this release.
4. Otherwise it is unresolvable.
Then: members = the full alleles the name identifies; allele_2field = 2-field name + the expression
suffix all members share (if any); g_group = the single shared G group, NONE if none, AMBIGUOUS if mixed.
"""
from __future__ import annotations

from sci_envs.reference.imgt import ImgtReference, ImgtError, split_allele, is_legacy_name, LEGACY_RE

SUFFIXES = "NLSCAQ"


def legacy_to_colon(s: str):
    m = LEGACY_RE.match(s.strip())
    if not m:
        return None
    loc, digits, suf = m.group(1), m.group(2), m.group(3)
    loc = "C" if loc == "Cw" else loc
    if len(digits) % 2:
        return None
    return f"{loc}*{':'.join(digits[i:i + 2] for i in range(0, len(digits), 2))}{suf}"


def _members(ref: ImgtReference, name: str) -> list[str]:
    if ref.exists(name):
        return [name]
    locus, fields, suffix = split_allele(name)
    base = f"{locus}*{':'.join(fields)}"
    m = ref.expand(base)
    if suffix:
        m = [x for x in m if split_allele(x)[2] == suffix]
    return m


def resolve_name(ref: ImgtReference, reported: str):
    """-> (name_or_None, flags:set)"""
    s = reported.strip()
    flags: set[str] = set()
    if ref.is_deleted(s):
        flags.add("deprecated_name")
        succ = ref.renamed_to(s)
        return (succ, flags) if succ else (None, flags | {"nonexistent_allele"})
    if is_legacy_name(s):
        flags.add("deprecated_name")
        cand = legacy_to_colon(s)
        try:
            ok = cand and (ref.exists(cand) or ref._valid_prefix(cand))
        except ImgtError:
            ok = False
        return (cand, flags) if ok else (None, flags | {"nonexistent_allele"})
    try:
        if ref.exists(s) or ref._valid_prefix(s):
            return s, flags
    except ImgtError:
        pass
    return None, flags | {"nonexistent_allele"}


def normalize(ref: ImgtReference, reported: str) -> dict:
    name, flags = resolve_name(ref, reported)
    if name is None:
        return {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": ";".join(sorted(flags))}
    members = _members(ref, name)
    if not members:
        return {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": ";".join(sorted(flags | {"nonexistent_allele"}))}
    locus, fields, _ = split_allele(name)
    base2 = f"{locus}*{':'.join(fields[:2])}"
    under2 = ref.expand(base2)
    sufs = {split_allele(x)[2] for x in under2}
    two = base2 + (next(iter(sufs)) if len(sufs) == 1 and next(iter(sufs)) else "")
    groups = {ref.g_group(m) for m in members}
    g = (next(iter(groups)) or "NONE") if len(groups) == 1 else "AMBIGUOUS"
    if all(split_allele(m)[2] == "N" for m in members):
        flags.add("null_allele")
    return {"allele_2field": two, "g_group": g, "flags": ";".join(sorted(flags))}
