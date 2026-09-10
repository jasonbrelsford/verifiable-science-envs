"""HLA-Verify service tests (offline once the reference cache is warm)."""
import pytest
from fastapi.testclient import TestClient

from sci_envs.service.app import app

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["release"] == "3.65.0"


def test_verify_mixed_text():
    text = "A*0101 and B*15:504:01 are fine; DQB1*05:03:26:99 and DQB1*99:99 are not; DQB1*05:03:01G is a group."
    d = client.post("/v1/verify", json={"text": text}).json()
    by = {t["token"]: t for t in d["tokens"]}
    assert by["B*15:504:01"]["status"] == "valid"
    assert by["DQB1*05:03:26:99"]["status"] == "hallucinated"
    assert by["DQB1*99:99"]["status"] == "hallucinated"
    assert by["DQB1*05:03:01G"]["status"] == "group"
    assert d["clean"] is False and d["counts"]["hallucinated"] == 2


def test_verify_deleted_has_successor():
    d = client.post("/v1/verify", json={"text": "old name A*01:34N in a report"}).json()
    tok = {t["token"]: t for t in d["tokens"]}["A*01:34N"]
    assert tok["status"] == "deleted" and tok["successor"] == "A*01:01:38L"
    assert d["clean"] is False


def test_verify_clean_true_on_valid_only():
    d = client.post("/v1/verify", json={"text": "HLA-A*01:01 with DRB1*14:06"}).json()
    assert d["clean"] is True


def test_normalize_batch():
    d = client.post("/v1/normalize", json={"typings": ["A*0101", "DRB1*1406", "B*9999"]}).json()
    rows = {r["reported"]: r for r in d["rows"]}
    assert rows["A*0101"]["current_name"] == "A*01:01"
    assert "deprecated_name" in rows["A*0101"]["flags"]
    assert rows["DRB1*1406"]["allele_2field"] == "DRB1*14:06"
    assert rows["B*9999"]["current_name"] == "UNRESOLVABLE"


def test_allele_endpoints():
    d = client.get("/v1/allele/A*01:01:01:01").json()
    assert d["status"] == "assigned" and d["g_group"]
    d = client.get("/v1/allele/A*01:01").json()
    assert d["status"] in ("assigned", "valid_prefix")
    assert client.get("/v1/allele/A*99:99").status_code == 404
    assert client.get("/v1/allele/notanallele").status_code == 404


def test_api_key_gate(monkeypatch):
    monkeypatch.setenv("HLA_VERIFY_API_KEYS", "sekret")
    assert client.post("/v1/verify", json={"text": "A*01:01"}).status_code == 401
    ok = client.post("/v1/verify", json={"text": "A*01:01"}, headers={"X-API-Key": "sekret"})
    assert ok.status_code == 200


def test_demo_page():
    r = client.get("/")
    assert r.status_code == 200 and "HLA-Verify" in r.text and "3.65.0" in r.text


def test_match_endpoint_null_trap():
    body = {"framework": "8/8",
            "recipient": {"A": ["A*02:01", "A*24:02"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]},
            "donor": {"A": ["A*02:01", "A*24:09N"], "B": ["B*07:02", "B*44:02"], "C": ["C*07:02", "C*05:01"], "DRB1": ["DRB1*15:01", "DRB1*04:01"]}}
    d = client.post("/v1/match", json=body).json()
    assert d["count"] == "7/8" and d["verdicts"]["A"] == "mismatch" and "null_allele" in d["flags"]
    assert client.post("/v1/match", json={**body, "framework": "9/9"}).status_code == 422


def test_allele_suffixed_prefix_no_crash():
    d = client.get("/v1/allele/A*24:09N").json()
    assert d["status"] in ("assigned", "valid_prefix")
