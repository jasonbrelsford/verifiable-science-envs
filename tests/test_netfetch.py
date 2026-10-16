"""sci_envs.reference.netfetch: retry, backoff, minimum timeout, URL logged on failure."""
from __future__ import annotations

import pytest

from sci_envs.reference import netfetch


class _Resp:
    def __init__(self, body): self.body = body
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *a): return False


def test_retries_then_succeeds(monkeypatch, capsys):
    calls, sleeps = [], []

    def fake(req, timeout):
        calls.append(timeout)
        if len(calls) < 3:
            raise TimeoutError("The read operation timed out")
        return _Resp(b"ok")

    monkeypatch.setattr(netfetch.urllib.request, "urlopen", fake)
    assert netfetch.fetch_bytes("https://example.test/a", timeout=60, sleep=sleeps.append) == b"ok"
    assert calls == [120.0, 120.0, 120.0]          # short callers are raised to the floor
    assert sleeps == [2.0, 4.0]                    # exponential backoff
    err = capsys.readouterr().err
    assert err.count("https://example.test/a") == 2  # URL logged on every failure


def test_gives_up_after_three_tries(monkeypatch):
    n = []
    monkeypatch.setattr(netfetch.urllib.request, "urlopen", lambda r, timeout: n.append(1) or (_ for _ in ()).throw(OSError("down")))
    with pytest.raises(OSError):
        netfetch.fetch_bytes("https://example.test/b", sleep=lambda s: None)
    assert len(n) == 3


def test_export_prefetch_fetches_only_missing_files(monkeypatch, tmp_path):
    from sci_envs.service import edge_export
    got = []
    monkeypatch.setattr(edge_export, "fetch_bytes", lambda url: got.append(url) or b"x")
    (tmp_path / "v9" ).mkdir()
    (tmp_path / "v9" / edge_export.ALL_FILES[0]).write_bytes(b"have")
    edge_export.prefetch("v9", tmp_path)
    assert len(got) == len(edge_export.ALL_FILES) - 1
    assert all("/v9/" in u for u in got)
    assert (tmp_path / "v9" / edge_export.ALL_FILES[0]).read_bytes() == b"have"
