"""sci_envs.service.pgx_export: the deploy gate for the vendored hla-pgx-open table.

Offline — bundle() is pure, export() is exercised with the fetch monkeypatched. The
Worker-side behaviour over a real bundle is edge/test/pgx.test.mjs.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

from sci_envs.service import pgx_export
from sci_envs.service.pgx_export import PgxExportError, bundle, export, MAX_AGE_DAYS, BUNDLE_VERSION

NOW = dt.date(2026, 10, 13)


def row(**over):
    base = {"source": "cpic", "source_record_id": "r1", "gene": "HLA-B", "allele": "HLA-B*57:01",
            "allele_status": "positive", "drug": "abacavir", "evidence_level": "CPIC A",
            "hlaverify_2field": "HLA-B*57:01", "hlaverify_current_name": "B*57:01:01:01"}
    base.update(over)
    return base


def manifest(**over):
    m = {"snapshot_date": "2026-10-12", "git_commit": "35bcc18deadbeef", "built_at": "2026-10-12T06:00:00Z",
         "license": "CC-BY-SA-4.0",
         "sources": {"cpic": {"ok": True, "base_url": "https://api.cpicpgx.org/v1", "pairs": 7, "recommendations": 40,
                              "secret": "never-shipped"},
                     "pharmgkb": {"ok": True, "url_used": "https://api.pharmgkb.org/v1/download/file/data/clinicalAnnotations.zip",
                                  "created_stamp": "2026-10-07", "annotations": 300, "allele_rows": 311},
                     "hlaverify": {"ok": True, "ipd_release": "3.65.0", "alleles_checked": 51}}}
    m.update(over)
    return m


def test_bundle_shapes_the_worker_file():
    b = bundle([row(), row(source="pharmgkb", drug="carbamazepine", allele="HLA-A*31:01")], manifest(),
               "hla-pgx-open attribution text\n", now=NOW)
    assert b["bundle_version"] == BUNDLE_VERSION
    assert b["snapshot"] == {"date": "2026-10-12", "commit": "35bcc18deadbeef", "built_at": "2026-10-12T06:00:00Z"}
    assert b["license"] == "CC-BY-SA-4.0"
    assert b["attribution"] == "hla-pgx-open attribution text"
    assert len(b["rows"]) == 2 and b["rows"][0]["allele"] == "HLA-B*57:01"
    # only the documented source fields are carried; nothing else from upstream leaks into the bundle
    assert b["sources"]["cpic"] == {"ok": True, "base_url": "https://api.cpicpgx.org/v1", "pairs": 7, "recommendations": 40}
    assert "secret" not in json.dumps(b)
    assert b["sources"]["hlaverify"]["ipd_release"] == "3.65.0"


def test_bundle_falls_back_to_a_named_attribution():
    b = bundle([row()], manifest(), None, now=NOW)
    assert "CPIC" in b["attribution"] and "PharmGKB" in b["attribution"] and "CC BY-SA" in b["attribution"]
    assert bundle([row()], manifest(), "   \n", now=NOW)["attribution"] == b["attribution"]


@pytest.mark.parametrize("src", ["cpic", "pharmgkb"])
def test_bundle_refuses_a_half_built_table(src):
    m = manifest()
    m["sources"][src]["ok"] = False
    with pytest.raises(PgxExportError, match=f"sources.{src}.ok"):
        bundle([row()], m, None, now=NOW)
    del m["sources"][src]
    with pytest.raises(PgxExportError, match=f"sources.{src}.ok"):
        bundle([row()], m, None, now=NOW)


def test_bundle_refuses_a_stale_snapshot():
    assert bundle([row()], manifest(snapshot_date=str(NOW - dt.timedelta(days=MAX_AGE_DAYS))), None, now=NOW)
    with pytest.raises(PgxExportError, match="days old"):
        bundle([row()], manifest(snapshot_date=str(NOW - dt.timedelta(days=MAX_AGE_DAYS + 1))), None, now=NOW)
    with pytest.raises(PgxExportError, match="ISO date"):
        bundle([row()], manifest(snapshot_date="last tuesday"), None, now=NOW)
    with pytest.raises(PgxExportError, match="ISO date"):
        bundle([row()], manifest(snapshot_date=None), None, now=NOW)


def test_bundle_refuses_rows_without_the_joined_columns():
    with pytest.raises(PgxExportError, match="non-empty list"):
        bundle([], manifest(), None, now=NOW)
    with pytest.raises(PgxExportError, match="non-empty list"):
        bundle({"rows": [row()]}, manifest(), None, now=NOW)  # type: ignore[arg-type]
    bad = row()
    del bad["evidence_level"]
    with pytest.raises(PgxExportError, match="1 rows lack the required columns \\(first: row 1\\)"):
        bundle([row(), bad], manifest(), None, now=NOW)


def _patch_fetch(monkeypatch, files: dict[str, bytes] | Exception):
    def fake(url, timeout=60.0):
        if isinstance(files, Exception):
            raise files
        path = url.split("/main/", 1)[1]
        if path not in files:
            raise OSError(f"404 {url}")
        return files[path]
    monkeypatch.setattr(pgx_export, "_fetch", fake)


def test_export_writes_the_bundle_and_pins_the_commit(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, {"data/hla_pgx.json": json.dumps([row()]).encode(),
                               "data/manifest.json": json.dumps(manifest(snapshot_date=str(dt.date.today()))).encode()})
    b = export(tmp_path)
    on_disk = json.loads((tmp_path / "pgx.json").read_text(encoding="utf-8"))
    assert on_disk == b
    assert on_disk["snapshot"]["commit"] == "35bcc18deadbeef"
    assert "CPIC" in on_disk["attribution"]  # ATTRIBUTION.md missing -> fallback, not a failure


def test_export_fails_closed_on_first_deploy_and_open_on_refresh(tmp_path, monkeypatch, capsys):
    _patch_fetch(monkeypatch, ConnectionError("proxy down"))
    with pytest.raises(PgxExportError, match="no previous"):
        export(tmp_path)
    assert not (tmp_path / "pgx.json").exists()
    previous = {"bundle_version": BUNDLE_VERSION, "snapshot": {"date": "2026-10-01", "commit": "abc"}, "rows": [row()]}
    (tmp_path / "pgx.json").write_text(json.dumps(previous), encoding="utf-8")
    assert export(tmp_path) == previous
    assert "keeping the previous" in capsys.readouterr().err
    assert json.loads((tmp_path / "pgx.json").read_text(encoding="utf-8")) == previous


def test_export_never_keeps_a_previous_bundle_over_a_bad_manifest(tmp_path, monkeypatch):
    # A stale upstream is a deploy failure even when a previous bundle exists: the
    # fail-open rule is for the network, not for the table's own gates.
    (tmp_path / "pgx.json").write_text("{}", encoding="utf-8")
    _patch_fetch(monkeypatch, {"data/hla_pgx.json": json.dumps([row()]).encode(),
                               "data/manifest.json": json.dumps(manifest(snapshot_date="2020-01-01")).encode()})
    with pytest.raises(PgxExportError, match="days old"):
        export(tmp_path)
    assert (tmp_path / "pgx.json").read_text(encoding="utf-8") == "{}"
