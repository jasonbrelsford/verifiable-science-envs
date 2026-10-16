"""Retrying HTTP GET for the export-time downloads (IPD-IMGT/HLA files, hla-pgx-open).

One slow upstream read must not fail a deploy or an evaluation run: each URL gets
``tries`` attempts with exponential backoff, a read timeout of at least ``MIN_TIMEOUT``
seconds, and the URL is logged to stderr on every failure.  Pure transport: the bytes
returned are exactly what the host sent, so pinned-release checksums still apply.
"""
from __future__ import annotations

import sys
import time
import urllib.request

MIN_TIMEOUT = 120.0
TRIES = 3
BACKOFF = 2.0


def fetch_bytes(url: str, headers: dict | None = None, timeout: float = MIN_TIMEOUT,
                tries: int = TRIES, backoff: float = BACKOFF, sleep=time.sleep) -> bytes:
    timeout = max(timeout, MIN_TIMEOUT)
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers=headers or {})
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed https hosts
                return r.read()
        except Exception as e:  # noqa: BLE001 - timeouts, resets, 5xx: all retried alike
            print(f"fetch failed ({attempt}/{tries}) {url}: {e!r}", file=sys.stderr)
            if attempt == tries:
                raise
            sleep(backoff ** attempt)
