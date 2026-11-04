"""The probe's HLAtools cross-check (#165): the stdlib .rda reader and the comparison rule."""
import gzip
import importlib.util
import struct
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "probe", Path(__file__).resolve().parent.parent / ".github" / "workflows" / "probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


# A minimal RDX3 writer: enough to build the shape of alleleListHistory (a list holding the Version
# and AlleleListHistory data.frames) without R.
def i32(n): return struct.pack(">i", n)
def charsxp(s): return i32(9) + i32(len(s.encode())) + s.encode() if s is not None else i32(9) + i32(-1)
def strsxp(xs): return i32(16) + i32(len(xs)) + b"".join(charsxp(x) for x in xs)
def sym(name, seen):
    if name in seen:
        return i32(255 | (seen[name] << 8))
    seen[name] = len(seen) + 1
    return i32(1) + charsxp(name)
def attrs(pairs, seen):
    out = b""
    for key, val in pairs:
        out += i32(0x402) + sym(key, seen) + val
    return out + i32(254)
def vec(items, pairs, seen): return i32(0x213) + i32(len(items)) + b"".join(items) + attrs(pairs, seen)
def chars(xs, pairs=(), seen=None): return (i32(0x216) + i32(len(xs)) + b"".join(charsxp(x) for x in xs) + attrs(pairs, seen)) if pairs else strsxp(xs)
def ints(xs): return i32(13) + i32(len(xs)) + b"".join(i32(x) for x in xs)


def rda(release, columns):
    seen = {}
    root = sym("alleleListHistory", seen)   # symbols are numbered in stream order
    frame_cls = ("class", strsxp(["data.frame"]))
    version = vec([strsxp(["2025-01-15"]), strsxp([release])],
                  [("names", strsxp(["Date", "Version"])), frame_cls, ("row.names", ints([-2**31, -1]))], seen)
    history = vec([strsxp(v) for v in columns.values()],
                  [("names", strsxp(list(columns))), frame_cls, ("row.names", ints([-2**31, -3]))], seen)
    top = vec([version, history], [("names", strsxp(["Version", "AlleleListHistory"]))], seen)
    body = i32(0x402) + root + top + i32(254)
    raw = b"RDX3\nX\n" + i32(3) + i32(0x40402) + i32(0x30500) + i32(5) + b"UTF-8" + body
    return gzip.compress(raw)


def test_reads_newest_release_column():
    blob = rda("3.59.0", {"HLA_ID": ["HLA00001", "HLA00002", "HLA00003"],
                          "X3590": ["A*01:01:01:01", None, "A*01:03:01:01"],
                          "X3580": ["A*01:01:01:01", "A*01:02:01:01", "A*01:03:01:01"]})
    release, names = probe.read_allele_list_history(blob)
    assert release == "3.59.0"
    assert names == {"A*01:01:01:01", "A*01:03:01:01"}


def test_unreadable_reference_raises():
    with pytest.raises(ValueError):
        probe.read_allele_list_history(b"<html>404</html>")


NAMES = {"A*01:01:01:01", "B*57:01:01:01"}


def test_agreement_is_silent():
    rows = [{"name": "A*01:01:01:01", "status": "unchanged", "to_name": "A*01:01:01:01"},
            {"name": "A*0101", "status": "not_in_from_release", "to_name": None},
            {"name": "A*01:99:99", "status": "unknown", "to_name": None}]
    assert probe.xcheck_translate("3.59.0", NAMES, rows) == []


def test_disagreements_are_reported_both_ways():
    rows = [{"name": "B*57:01:01:01", "status": "renamed", "to_name": "B*57:01:01:02"},
            {"name": "A*0101", "status": "unchanged", "to_name": "A*0101"}]
    problems = probe.xcheck_translate("3.59.0", NAMES, rows)
    assert len(problems) == 2
    assert "B*57:01:01:01" in problems[0] and "A*0101" in problems[1]


def test_panel_is_consistent():
    assert not set(probe.XCHECK_VALID) & set(probe.XCHECK_REFUSED)


def test_unreachable_reference_raises_for_the_caller_to_skip():
    with pytest.raises(Exception):
        probe.fetch_reference("http://127.0.0.1:9/alleleListHistory.rda")
