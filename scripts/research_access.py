#!/usr/bin/env python3
"""Review and approve research and education access applications.

WHAT THIS IS FOR. `POST /v1/research-access` (edge/src/handlers.js) files one
application per address in the Worker's KEYS KV namespace under `research/`.
Nothing in the Worker decides anything: approval is a person reading the
application and choosing. This script is that person's side of it. It lists what
is waiting, and on approval it mints a single-use Stripe promotion code on the
research coupon, writes the decision back onto the KV record, and prints the
code with a message ready to paste into an email.

WHY THE WORKER DOES NOT DO THIS. The Worker's Stripe key is restricted to
reading prices and creating Checkout Sessions. Minting a discount is a
different power, and an approval is a judgement, not a request handler. Keeping
it here means a bug in the public endpoint cannot give anyone free access: the
worst it can do is write a row this script will show you.

WHAT THE APPLICANT DOES NEXT. They go to https://api.hlaverify.com/pricing,
pick a tier, and enter the code at Stripe Checkout. The coupon is 100% off
repeating for 12 months, so the total is $0, Stripe collects no card, and the
key is issued by the same webhook that issues a paid one.

REQUIREMENTS: python3 and npx wrangler. No third-party packages, by design:
this runs on the owner's Mac, and a script that needs a working virtualenv to
approve one lab is a script that does not get run.

CREDENTIALS. The Stripe secret key is read from $STRIPE_API_KEY, or from
~/.config/hlaverify/stripe.key (first line). It is never printed, never logged,
never written to KV, and never passed on a command line where `ps` could see
it. It must be a key that can write promotion codes; the Worker's restricted
key cannot, and is the wrong key to use here.

USAGE
  python3 scripts/research_access.py list
  python3 scripts/research_access.py list --status all
  python3 scripts/research_access.py show pi@lab.example
  python3 scripts/research_access.py approve pi@lab.example --dry-run
  python3 scripts/research_access.py approve pi@lab.example
  python3 scripts/research_access.py approve pi@lab.example --days 90
  python3 scripts/research_access.py approve pi@lab.example --force   # re-approve

Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import secrets
import subprocess
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request

# The live coupon for this programme: "Academic and nonprofit research",
# 100% off, repeating for 12 months. Promotion codes are minted ON it; the
# coupon itself is never created or modified here.
COUPON = "zeL42tao"

# The Worker's KEYS namespace (edge/wrangler.jsonc). Applications live under
# RESEARCH_PREFIX; API keys, Stripe indexes and the beta list share the space.
NAMESPACE_ID = "8360bbe6d4904699ab019702427fc19d"
RESEARCH_PREFIX = "research/"

STRIPE_API = "https://api.stripe.com"
KEY_FILE = pathlib.Path.home() / ".config" / "hlaverify" / "stripe.key"

# Promotion codes are shown to a person and typed by a person, so the alphabet
# leaves out the characters that get misread: 0/O, 1/I/L, 2/Z, 5/S, 8/B.
CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"
CODE_PREFIX = "HLVRES"
CODE_BODY_LEN = 10

PRICING_URL = "https://api.hlaverify.com/pricing"


# --------------------------------------------------------------------- output

def out(msg: str = "") -> None:
    print(msg)


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ------------------------------------------------------------------ the KV side
# Everything goes through `npx wrangler kv key ...` rather than the Cloudflare
# REST API, so this script needs no Cloudflare credential of its own: it borrows
# whatever `wrangler login` already established, the same way a deploy does.

def wrangler(args: list[str], where: str) -> str:
    """Run one wrangler command and return stdout. Raises on failure."""
    cmd = ["npx", "--yes", "wrangler@4", "kv", *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=where, timeout=180)
    except FileNotFoundError:
        die("npx not found on PATH; install Node.js and try again")
    except subprocess.TimeoutExpired:
        die("wrangler timed out after 180s")
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        die(f"wrangler failed ({' '.join(args[:3])}):\n{detail}")
    return proc.stdout


def _parse_json(raw: str, opener: str, closer: str):
    """wrangler sometimes prints a banner alongside the payload; take the payload."""
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    start, end = raw.find(opener), raw.rfind(closer)
    if start < 0 or end < start:
        return None
    try:
        return json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        return None


class KV:
    def __init__(self, namespace_id: str, remote: bool, where: str) -> None:
        self.flags = ["--namespace-id", namespace_id, "--remote" if remote else "--local"]
        self.where = where

    def list_keys(self, prefix: str) -> list[str]:
        raw = wrangler(["key", "list", "--prefix", prefix, *self.flags], self.where)
        rows = _parse_json(raw, "[", "]")
        if rows is None:
            die(f"could not read a key list out of wrangler's output:\n{raw.strip()[:400]}")
        return [r["name"] for r in rows if isinstance(r, dict) and "name" in r]

    def get(self, key: str) -> dict | None:
        raw = wrangler(["key", "get", key, *self.flags], self.where)
        if not raw.strip():
            return None
        rec = _parse_json(raw, "{", "}")
        if rec is None:
            die(f"record {key} is not JSON:\n{raw.strip()[:400]}")
        return rec

    def put(self, key: str, value: dict) -> None:
        wrangler(["key", "put", key, json.dumps(value, separators=(",", ":")), *self.flags], self.where)


# -------------------------------------------------------------- the Stripe side

def stripe_key() -> str:
    """The secret key, from the environment or the key file. Never returned to output."""
    env = os.environ.get("STRIPE_API_KEY", "").strip()
    if env:
        return env
    if KEY_FILE.exists():
        first = KEY_FILE.read_text(encoding="utf-8").strip().splitlines()
        if first and first[0].strip():
            return first[0].strip()
    die(f"no Stripe key: set $STRIPE_API_KEY or put one in {KEY_FILE}")


def stripe_base() -> str:
    """Local-testing seam, loopback only, exactly as edge/src/pricing.js allows.

    A stub is how this script is tested without touching the live account. The
    loopback check is what stops a mis-set or hostile value from posting the
    secret key somewhere else.
    """
    override = os.environ.get("STRIPE_API_BASE", "").strip()
    if not override:
        return STRIPE_API
    host = urllib.parse.urlparse(override).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        die(f"STRIPE_API_BASE must address the loopback interface, not {host!r}")
    return override.rstrip("/")


def stripe_post(path: str, form: list[tuple[str, str]], key: str) -> dict:
    """POST form-encoded to Stripe. The key travels in a header and nowhere else."""
    url = f"{stripe_base()}{path}"
    body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "authorization": f"Bearer {key}",
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2024-06-20",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(raw)["error"]["message"]
        except Exception:
            message = raw[:400]
        raise StripeError(e.code, message) from None
    except urllib.error.URLError as e:
        raise StripeError(0, f"Stripe was unreachable: {e.reason}") from None


class StripeError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def new_code() -> str:
    return CODE_PREFIX + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_BODY_LEN))


# ------------------------------------------------------------------- formatting

def parse_ts(value) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def age(value) -> str:
    when = parse_ts(value)
    if when is None:
        return "?"
    days = (dt.datetime.now(dt.timezone.utc) - when).days
    if days <= 0:
        return "today"
    return f"{days}d ago"


def wrap(text: str, indent: str, width: int = 96) -> str:
    return textwrap.fill(str(text), width=width, initial_indent=indent, subsequent_indent=indent)


def email_of(rec: dict, key: str) -> str:
    return rec.get("email") or key[len(RESEARCH_PREFIX):]


def show_record(key: str, rec: dict, full: bool = False) -> None:
    status = rec.get("status", "?")
    out(f"{email_of(rec, key)}  [{status}]  {age(rec.get('ts'))}  ({rec.get('country') or 'country unknown'})")
    out(wrap(rec.get("institution") or "(no institution given)", "    institution:  "))
    use_case = rec.get("use_case") or "(none given)"
    if not full and len(use_case) > 300:
        use_case = use_case[:300] + " ..."
    out(wrap(use_case, "    use case:     "))
    if rec.get("expected_volume"):
        out(wrap(rec["expected_volume"], "    volume:       "))
    if rec.get("source"):
        out(f"    came from:    {rec['source']}")
    out(f"    applied:      {rec.get('ts') or '?'}")
    if status == "approved":
        out(f"    approved:     {rec.get('approved_at') or '?'} by {rec.get('approved_by') or '?'}")
        out(f"    code:         {rec.get('promotion_code') or '?'}  "
            f"(expires {rec.get('code_expires_at') or '?'}, one redemption)")
    out()


def approval_email(email: str, code: str, expires: dt.datetime, days: int) -> str:
    return f"""    To: {email}
    Subject: HLA-Verify research access approved

    Your application for HLA-Verify research and education access is approved.

    Your code: {code}

    To use it: go to {PRICING_URL}, pick the tier you want, and enter the code
    at checkout. It takes 100% off for 12 months. The total is $0, so Stripe will
    not ask you for a card. Your API key is shown once on the page you land on
    after checkout, and is also saved to your Stripe customer record.

    The code works once and expires on {expires.date().isoformat()} ({days} days from now).
    It is tied to your application, so please do not pass it on.

    After 12 months the subscription renews at the normal price for that tier
    unless you cancel or reapply. Cancel any time from the customer portal link
    in your receipt; that also revokes the API key.

    Questions: hello@hlaverify.com"""


# ---------------------------------------------------------------- the commands

def load_all(kv: KV) -> list[tuple[str, dict]]:
    keys = kv.list_keys(RESEARCH_PREFIX)
    rows = []
    for k in keys:
        rec = kv.get(k)
        if rec is not None:
            rows.append((k, rec))
    rows.sort(key=lambda kr: kr[1].get("ts") or "")
    return rows


def cmd_list(args, kv: KV) -> int:
    rows = load_all(kv)
    if args.status != "all":
        rows = [(k, r) for k, r in rows if r.get("status", "pending") == args.status]
    if not rows:
        out(f"No {args.status} research access applications.")
        return 0
    out(f"{len(rows)} {args.status} application(s), oldest first:")
    out()
    for k, rec in rows:
        show_record(k, rec)
    out("Approve one with:")
    out(f"  python3 {sys.argv[0]} approve {email_of(rows[0][1], rows[0][0])} --dry-run")
    return 0


def cmd_show(args, kv: KV) -> int:
    key = RESEARCH_PREFIX + args.email.strip().lower()
    rec = kv.get(key)
    if rec is None:
        die(f"no application on file for {args.email}")
    show_record(key, rec, full=True)
    return 0


def cmd_approve(args, kv: KV) -> int:
    email_arg = args.email.strip().lower()
    key = RESEARCH_PREFIX + email_arg
    rec = kv.get(key)
    if rec is None:
        die(f"no application on file for {args.email} (run `list` to see what is waiting)")

    email = email_of(rec, key)
    status = rec.get("status", "pending")
    if status == "approved" and not args.force:
        out(f"{email} was already approved on {rec.get('approved_at') or '?'} "
            f"with code {rec.get('promotion_code') or '?'}.")
        out("Nothing was changed. To mint a second code anyway, re-run with --force.")
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    expires = now + dt.timedelta(days=args.days)
    code = args.code.upper() if args.code else new_code()

    out("Application")
    out()
    show_record(key, rec, full=True)
    verb = "Would create" if args.dry_run else ("Recording" if args.record_only else "Creating")
    out(f"{verb} a Stripe promotion code on coupon {COUPON} "
        f"(100% off, repeating 12 months):")
    out(f"    code:            {code}")
    out("    max_redemptions: 1")
    out(f"    expires:         {expires.isoformat()} ({args.days} days)")
    out(f"    metadata:        email={email}, program=research, approved_by={args.by}")
    out()

    if args.dry_run:
        out("--dry-run: nothing was sent to Stripe and nothing was written to KV.")
        out("Re-run without --dry-run to approve.")
        return 0

    if args.record_only:
        # The code was created by hand in the Stripe dashboard. Record it and
        # make no Stripe call at all.
        created = {"code": code, "id": None}
        out(f"--record-only: recording {code} as an existing Stripe code; no Stripe call made.")
        return _write_back(kv, key, rec, email, created, code, now, expires, args)

    form = [
        ("coupon", COUPON),
        ("code", code),
        ("max_redemptions", "1"),
        ("expires_at", str(int(expires.timestamp()))),
        ("metadata[email]", email),
        ("metadata[program]", "research"),
        ("metadata[approved_by]", args.by),
    ]
    if rec.get("institution"):
        form.append(("metadata[institution]", str(rec["institution"])[:450]))

    try:
        created = stripe_post("/v1/promotion_codes", form, stripe_key())
    except StripeError as e:
        # Nothing is written to KV on a Stripe failure: a record marked approved
        # with no code is worse than one still marked pending, because the next
        # `list` would hide it.
        out("Stripe would not create the promotion code. Nothing was written to KV, "
            "so this application is still pending and will show up in `list` again.")
        out()
        out(f"    Stripe said ({e.status or 'no response'}): {e.message}")
        out()
        if e.status in (401, 403):
            out("    A 401 or 403 here almost always means the key cannot write promotion")
            out("    codes. The Worker's restricted key is scoped to Prices and Checkout")
            out("    Sessions and cannot; use a key with Promotion Codes write, or create")
            out("    the code by hand in the Stripe dashboard on coupon " + COUPON + " with")
            out("    max redemptions 1 and an expiry, then record it here without asking")
            out("    Stripe for anything:")
            out(f"      python3 {sys.argv[0]} approve {email} --code THECODE --record-only")
        elif e.status == 400:
            out("    A 400 is usually a code that already exists. Re-run to get a new one,")
            out("    or pass --code with a different string.")
        return 1

    return _write_back(kv, key, rec, email, created, code, now, expires, args)


def _write_back(kv: KV, key: str, rec: dict, email: str, created: dict, code: str,
                now: dt.datetime, expires: dt.datetime, args) -> int:
    """Put the decision on the KV record and print the code and the email."""
    actual = created.get("code") or code
    promo_id = created.get("id")

    record = dict(rec)
    record.update({
        "status": "approved",
        "promotion_code": actual,
        "promotion_code_id": promo_id,
        "coupon": COUPON,
        "approved_at": now.isoformat(),
        "approved_by": args.by,
        "code_expires_at": expires.isoformat(),
        "code_max_redemptions": 1,
    })
    try:
        kv.put(key, record)
    except SystemExit:
        # The code exists in Stripe now, so the operator must not lose it.
        out()
        out("The promotion code WAS created in Stripe but could not be written back to KV.")
        out(f"    code: {actual}   (promotion code id {promo_id})")
        out("Send it anyway; re-run this command later to record the approval.")
        raise

    out(f"Approved. Code {actual} is live on coupon {COUPON}, good for one redemption, "
        f"expiring {expires.date().isoformat()}.")
    out(f"The KV record {key} now reads status=approved.")
    out()
    out("Send this:")
    out()
    out(approval_email(email, actual, expires, args.days))
    out()
    return 0


# ---------------------------------------------------------------------- wiring

def main(argv: list[str] | None = None) -> int:
    repo_edge = str(pathlib.Path(__file__).resolve().parent.parent / "edge")

    p = argparse.ArgumentParser(
        prog="research_access.py",
        description="List and approve HLA-Verify research and education access applications.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            The Stripe key is read from $STRIPE_API_KEY or ~/.config/hlaverify/stripe.key
            and is never printed. --dry-run writes nothing, to Stripe or to KV.
        """),
    )
    p.add_argument("--namespace-id", default=NAMESPACE_ID, help="KEYS KV namespace id")
    p.add_argument("--local", action="store_true",
                   help="talk to the local wrangler KV (testing) instead of the real one")
    p.add_argument("--cwd", default=repo_edge, help="directory to run wrangler in (default: the repo's edge/)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="show applications, oldest first")
    pl.add_argument("--status", default="pending", choices=["pending", "approved", "all"])
    pl.set_defaults(func=cmd_list)

    ps = sub.add_parser("show", help="show one application in full")
    ps.add_argument("email")
    ps.set_defaults(func=cmd_show)

    pa = sub.add_parser("approve", help="mint a single-use promotion code and record the approval")
    pa.add_argument("email")
    pa.add_argument("--days", type=int, default=60, help="days until the code expires (default 60)")
    pa.add_argument("--by", default=os.environ.get("HLV_APPROVER", "hello@hlaverify.com"),
                    help="who approved it, recorded on the record and on the code")
    pa.add_argument("--code", default=None,
                    help="use this code string instead of a generated one (also records a code made by hand)")
    pa.add_argument("--record-only", action="store_true",
                    help="the code already exists in Stripe (you made it by hand): record it, call Stripe not at all. Needs --code.")
    pa.add_argument("--dry-run", action="store_true", help="show what would happen; write nothing anywhere")
    pa.add_argument("--force", action="store_true", help="approve again even though this one is already approved")
    pa.set_defaults(func=cmd_approve)

    args = p.parse_args(argv)
    if getattr(args, "days", 1) is not None and getattr(args, "days", 1) < 1:
        die("--days must be at least 1")
    if getattr(args, "record_only", False) and not getattr(args, "code", None):
        die("--record-only needs --code: it records a code you already created in Stripe")
    kv = KV(args.namespace_id, remote=not args.local, where=args.cwd)
    return args.func(args, kv)


if __name__ == "__main__":
    raise SystemExit(main())
