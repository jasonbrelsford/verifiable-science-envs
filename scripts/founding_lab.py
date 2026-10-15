#!/usr/bin/env python3
"""Run the Founding Lab programme: 90-day Lab trials, then 60% off for 24 months.

WHAT THE PROGRAMME IS. Up to ten laboratories get the full Lab tier free for 90
days, with no card and no checkout, so they can run their own data through it
(scripts/poc_report.py makes the one-page report). At the end of the trial they
convert at 60% off Lab for 24 months ($119.60 instead of $299 a month) with a
single-use code. The price is agreed at the start so converting is a yes, not a
new negotiation.

HOW IT WORKS.
  issue    writes a Lab-tier API key straight into the Worker's KEYS namespace,
           with `expires` set 90 days out. The Worker refuses it after that date
           (edge/src/index.js authorize), pointing the caller at conversion. A
           record under founding/<email> tracks the trial; it is a reserved
           prefix (handlers.js RESERVED_PREFIXES), so it can never be used as a key.
  convert  mints a single-use Stripe promotion code on the FOUNDING-LAB coupon
           (60% off, repeating 24 months). The lab picks Lab at
           https://api.hlaverify.com/pricing and enters it; the webhook issues
           their permanent key as for any customer. Needs Stripe in live mode.
  extend   moves a trial's end date, for a lab that needs longer.
  list     every trial: lab, contact, days left, converted or not.
  coupon   creates the FOUNDING-LAB coupon once (--product limits it to Lab).

Reuses research_access.py's KV (wrangler) and Stripe plumbing and its credential
rules: the Stripe secret comes from $STRIPE_API_KEY or ~/.config/hlaverify/stripe.key
and is never printed; KV goes through `wrangler login`. --dry-run writes nothing.

USAGE
  python3 scripts/founding_lab.py issue lab@hospital.example --lab "Example Hospital HLA Lab" --dry-run
  python3 scripts/founding_lab.py issue lab@hospital.example --lab "Example Hospital HLA Lab"
  python3 scripts/founding_lab.py list
  python3 scripts/founding_lab.py extend lab@hospital.example --days 30
  python3 scripts/founding_lab.py coupon --product prod_...          # once
  python3 scripts/founding_lab.py convert lab@hospital.example

Licence: PolyForm Noncommercial 1.0.0 (edge/LICENSE).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import os
import pathlib
import secrets
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from research_access import (KV, NAMESPACE_ID, PRICING_URL, CODE_ALPHABET, StripeError, die, out,  # noqa: E402
                             parse_ts, stripe_key, stripe_post)

FOUNDING_PREFIX = "founding/"
COUPON = "FOUNDING-LAB-60"
PERCENT_OFF, MONTHS = 60, 24
TRIAL_DAYS = 90
MAX_LABS = 10
CODE_PREFIX = "HLVLAB"
LAB_LIST_PRICE = 299


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def new_key() -> str:
    """Same shape as edge/src/stripe.js generateApiKey: hlv_ + 32 random bytes, base64url."""
    return "hlv_" + base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def trials(kv: KV) -> list[tuple[str, dict]]:
    rows = [(k, kv.get(k)) for k in kv.list_keys(FOUNDING_PREFIX)]
    return sorted([(k, r) for k, r in rows if r], key=lambda kr: kr[1].get("issued_at") or "")


def days_left(rec: dict) -> int:
    end = parse_ts(rec.get("expires"))
    return (end - now()).days if end else 0


def show(rec: dict) -> None:
    state = rec.get("status", "trial")
    left = days_left(rec)
    when = f"{left} days left" if left > 0 else f"ended {-left} days ago"
    out(f"{rec.get('lab')}  <{rec.get('email')}>  [{state}]  {when}")
    out(f"    issued {rec.get('issued_at', '?')[:10]}, ends {rec.get('expires', '?')[:10]}"
        + (f", code {rec['promotion_code']}" if rec.get("promotion_code") else ""))


# ------------------------------------------------------------------ commands

def cmd_issue(args, kv: KV) -> int:
    email = args.email.strip().lower()
    idx = FOUNDING_PREFIX + email
    if kv.get(idx) and not args.force:
        die(f"{email} already has a founding-lab trial (see `list`); --force issues a second key")
    active = [r for _, r in trials(kv) if r.get("status", "trial") in ("trial", "converted")]
    if len(active) >= MAX_LABS and not args.force:
        die(f"the programme already has {len(active)} labs (limit {MAX_LABS}); --force to add another")
    key, issued = new_key(), now()
    expires = issued + dt.timedelta(days=args.days)
    key_rec = {"label": f"founding:{args.lab}"[:120], "tier": "lab", "status": "active", "email": email,
               "created": iso(issued), "provider": "founding-lab", "expires": iso(expires)}
    trial = {"email": email, "lab": args.lab, "issued_at": iso(issued), "expires": iso(expires),
             "status": "trial", "key_ref": key}
    out(f"Founding-lab trial for {args.lab} <{email}>: Lab tier until {expires.date()} ({args.days} days).")
    if args.dry_run:
        out("--dry-run: nothing written. Re-run without --dry-run to issue the key.")
        return 0
    kv.put(key, key_rec)
    kv.put(idx, trial)
    out()
    out("Send this (the key is shown once; it is also in the trial record):")
    out(f"""
    To: {email}
    Subject: Your HLA-Verify founding-lab key

    Welcome to the HLA-Verify Founding Lab programme. Your Lab-tier key, good until
    {expires.date().isoformat()}:

        {key}

    Lab tier: 10,000 calls a day and up to 5,000 typings per /v1/normalize call.
    Send it as the X-API-Key header. API reference: https://api.hlaverify.com/docs

    To see what it finds in your own data, run the trial report on any export:
        HLAVERIFY_API_KEY={key[:8]}... python3 poc_report.py your_export.csv
    https://github.com/jasonbrelsford/verifiable-science-envs/blob/main/scripts/poc_report.py
    Only the allele names leave your machine; nothing is stored.

    At the end of the trial you can keep Lab at {PERCENT_OFF}% off for {MONTHS} months
    (${LAB_LIST_PRICE * (100 - PERCENT_OFF) / 100:.2f} a month instead of ${LAB_LIST_PRICE}). Anything that looks wrong:
    https://hlaverify.com/support

    Jason, HLA-Verify""")
    return 0


def cmd_list(args, kv: KV) -> int:
    rows = trials(kv)
    if not rows:
        out("No founding-lab trials yet.")
        return 0
    out(f"{len(rows)} founding lab(s) of {MAX_LABS}:")
    out()
    for _, rec in rows:
        show(rec)
    return 0


def _rewrite(kv: KV, idx: str, rec: dict, **changes) -> None:
    key = rec.get("key_ref")
    key_rec = kv.get(key) if key else None
    rec.update(changes)
    kv.put(idx, rec)
    if key_rec is not None and "expires" in changes:
        key_rec["expires"] = changes["expires"]
        kv.put(key, key_rec)


def cmd_extend(args, kv: KV) -> int:
    idx = FOUNDING_PREFIX + args.email.strip().lower()
    rec = kv.get(idx) or die(f"no founding-lab trial for {args.email}")
    base = max(parse_ts(rec.get("expires")) or now(), now())
    expires = base + dt.timedelta(days=args.days)
    out(f"{rec.get('lab')}: trial end {rec.get('expires', '?')[:10]} -> {expires.date()}")
    if args.dry_run:
        out("--dry-run: nothing written.")
        return 0
    _rewrite(kv, idx, rec, expires=iso(expires))
    return 0


def cmd_coupon(args, kv: KV) -> int:
    form = [("id", COUPON), ("percent_off", str(PERCENT_OFF)), ("duration", "repeating"),
            ("duration_in_months", str(MONTHS)), ("name", f"Founding Lab: {PERCENT_OFF}% off for {MONTHS} months")]
    if args.product:
        form.append(("applies_to[products][0]", args.product))
    out(f"Coupon {COUPON}: {PERCENT_OFF}% off, repeating {MONTHS} months"
        + (f", only for product {args.product}" if args.product else ", ANY product (pass --product to limit it to Lab)"))
    if args.dry_run:
        out("--dry-run: nothing sent to Stripe.")
        return 0
    try:
        stripe_post("/v1/coupons", form, stripe_key())
    except StripeError as e:
        die(f"Stripe would not create the coupon: {e.message}")
    out("Created.")
    return 0


def cmd_convert(args, kv: KV) -> int:
    idx = FOUNDING_PREFIX + args.email.strip().lower()
    rec = kv.get(idx) or die(f"no founding-lab trial for {args.email}")
    if rec.get("promotion_code") and not args.force:
        die(f"{rec['lab']} already has code {rec['promotion_code']}; --force mints another")
    code = CODE_PREFIX + "".join(secrets.choice(CODE_ALPHABET) for _ in range(10))
    expires = now() + dt.timedelta(days=args.days)
    out(f"{rec.get('lab')}: single-use code {code} on {COUPON}, valid until {expires.date()}")
    if args.dry_run:
        out("--dry-run: nothing sent to Stripe or written to KV.")
        return 0
    try:
        stripe_post("/v1/promotion_codes", [
            ("coupon", COUPON), ("code", code), ("max_redemptions", "1"),
            ("expires_at", str(int(expires.timestamp()))), ("metadata[email]", rec["email"]),
            ("metadata[program]", "founding-lab"), ("metadata[lab]", str(rec.get("lab"))[:450])], stripe_key())
    except StripeError as e:
        die(f"Stripe would not create the code (nothing written): {e.message}")
    _rewrite(kv, idx, rec, promotion_code=code, code_expires_at=iso(expires), converted_offer_at=iso(now()))
    out(f"""
    To: {rec['email']}
    Subject: Keep HLA-Verify at {PERCENT_OFF}% off

    Thank you for being a founding lab. To keep Lab after your trial: go to
    {PRICING_URL}, choose Lab, and enter {code} at checkout. It takes {PERCENT_OFF}% off
    for {MONTHS} months (${LAB_LIST_PRICE * (100 - PERCENT_OFF) / 100:.2f} a month). The code works once and expires on
    {expires.date().isoformat()}. Your new key is shown after checkout; the trial key stops on
    {str(rec.get('expires', ''))[:10]}.

    Jason, HLA-Verify""")
    return 0


def main(argv=None) -> int:
    edge = str(pathlib.Path(__file__).resolve().parent.parent / "edge")
    p = argparse.ArgumentParser(prog="founding_lab.py", description=__doc__.split("\n\n")[0])
    p.add_argument("--namespace-id", default=NAMESPACE_ID)
    p.add_argument("--local", action="store_true", help="use the local wrangler KV (testing)")
    p.add_argument("--cwd", default=edge)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("issue"); s.add_argument("email"); s.add_argument("--lab", required=True)
    s.add_argument("--days", type=int, default=TRIAL_DAYS); s.add_argument("--force", action="store_true")
    s.add_argument("--dry-run", action="store_true"); s.set_defaults(func=cmd_issue)
    s = sub.add_parser("list"); s.set_defaults(func=cmd_list)
    s = sub.add_parser("extend"); s.add_argument("email"); s.add_argument("--days", type=int, required=True)
    s.add_argument("--dry-run", action="store_true"); s.set_defaults(func=cmd_extend)
    s = sub.add_parser("coupon"); s.add_argument("--product"); s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_coupon)
    s = sub.add_parser("convert"); s.add_argument("email"); s.add_argument("--days", type=int, default=45)
    s.add_argument("--force", action="store_true"); s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_convert)
    args = p.parse_args(argv)
    if getattr(args, "days", 1) < 1:
        die("--days must be at least 1")
    return args.func(args, KV(args.namespace_id, remote=not args.local, where=args.cwd))


if __name__ == "__main__":
    raise SystemExit(main())
