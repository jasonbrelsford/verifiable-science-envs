"""Tests for the live-API probe (.github/workflows/probe.py): the retry of over-budget calls and the labelled Hugging Face figures (#162)."""
from __future__ import annotations

import importlib.util
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

PROBE = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "probe.py"


@pytest.fixture()
def probe():
    spec = importlib.util.spec_from_file_location("probe_under_test", PROBE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Server:
    """Local HTTP server: `delays` maps a path to the list of sleeps (s) for successive hits; the rest answer fast."""

    def __init__(self, delays=None, bodies=None):
        self.delays = {k: list(v) for k, v in (delays or {}).items()}
        self.bodies = bodies or {}
        self.hits: dict[str, int] = {}
        outer = self

        class H(BaseHTTPRequestHandler):
            def _do(self):
                path = self.path.split("?")[0]
                outer.hits[path] = outer.hits.get(path, 0) + 1
                if self.command == "POST":
                    self.rfile.read(int(self.headers.get("Content-Length") or 0))
                q = outer.delays.get(path)
                if q:
                    time.sleep(q.pop(0))
                body = json.dumps(outer.bodies.get(path, {"ok": True})).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = _do

            def log_message(self, *a):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"
        self.host = f"127.0.0.1:{self.httpd.server_port}"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_over_budget_call_is_retried_once_and_keeps_both_timings(probe):
    probe.SLOW_FLOOR_MS = 100
    with Server(delays={"/v1/allele/X": [0.3]}) as s:
        probe.CALLS.clear()
        probe.RETRY_HOST = s.host
        r = probe.fetch(s.base + "/v1/allele/X")
        assert s.hits["/v1/allele/X"] == 2
        assert r["first_ms"] >= 300 and r["ms"] < r["first_ms"]
        c = probe.CALLS[-1]
        assert c["retried"] and c["first_ms"] == r["first_ms"] and c["ms"] == r["ms"]
        assert c["retry_over_budget"] is False and c["billable"] is True
        rep, warnings = probe.latency_report([c, {**c, "retried": False, "ms": 10}, {**c, "retried": False, "ms": 12}])
        assert rep["retried"][0]["first_ms"] == c["first_ms"]
        assert any("outlier (retry was fine)" in w and f"{c['first_ms']} ms first try" in w for w in warnings)


def test_call_over_budget_twice_is_reported_as_repeated(probe):
    probe.SLOW_FLOOR_MS = 100
    with Server(delays={"/v1/verify": [0.3, 0.3]}) as s:
        probe.CALLS.clear()
        probe.RETRY_HOST = s.host
        probe.fetch(s.base + "/v1/verify", "POST", {"text": "A*01:01"})
        assert s.hits["/v1/verify"] == 2          # retried once, not more
        c = probe.CALLS[-1]
        assert c["retry_over_budget"] is True
        _, warnings = probe.latency_report([c, {**c, "retried": False, "ms": 10}, {**c, "retried": False, "ms": 12}])
        assert any("repeated on retry" in w and f"first try {c['first_ms']} ms, retry {c['ms']} ms" in w for w in warnings)


def test_fast_call_and_report_post_are_not_retried(probe):
    probe.SLOW_FLOOR_MS = 100
    with Server(delays={"/v1/report": [0.3]}) as s:
        probe.CALLS.clear()
        probe.RETRY_HOST = s.host
        probe.fetch(s.base + "/healthz")
        probe.fetch(s.base + "/v1/report", "POST", {"input": "x"})   # slow, but it stores a record
        assert s.hits == {"/healthz": 1, "/v1/report": 1}
        assert not any(c.get("retried") for c in probe.CALLS)


def test_hf_figures_carry_fixed_labels(probe):
    body = {"id": "jason-brelsford/hla-bench", "downloads": 13, "downloadsAllTime": 188}
    with Server(bodies={"/api/datasets/jason-brelsford/hla-bench": body}) as s:
        hf = probe.hf_downloads("jason-brelsford/hla-bench", base=s.base)
    assert hf["downloads_all_time"] == 188 and hf["downloads_30d"] == 13
    assert "all-time" in hf["windows"]["downloads_all_time"] and "30-day" in hf["windows"]["downloads_30d"]
    line = probe.hf_line(hf)
    assert "downloads_all_time = 188" in line and "downloads_30d = 13" in line


def test_hf_failure_is_reported_not_raised(probe):
    hf = probe.hf_downloads("x/y", base="http://127.0.0.1:1")
    assert hf["downloads_all_time"] is None and hf["downloads_30d"] is None and hf["error"]
    assert "unavailable" in probe.hf_line(hf)
