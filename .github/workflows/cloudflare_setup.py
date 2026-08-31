"""Idempotent Cloudflare setup for hlaverify.com. Run by .github/workflows/cloudflare.yml."""
import json
import os
import urllib.error
import urllib.request

TOK, TARGET = os.environ["CF"], os.environ["REDIRECT_TO"]


def cf(path, method="GET", body=None):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def errs(r):
    return [e.get("message") for e in r.get("errors", [])]


v = cf("/user/tokens/verify")
print("user-token verify:", v.get("success"), "errors:", errs(v), "(account-owned tokens fail this check but still work — continuing)")
zr = cf("/zones?name=hlaverify.com")
z = zr.get("result") or []
if not z:
    print("zones call errors:", errs(zr))
    raise SystemExit("zone hlaverify.com not visible to this token — it needs Zone:Zone:Read plus the edit scopes, on the hlaverify.com zone")
zid, acct, status = z[0]["id"], z[0]["account"]["id"], z[0]["status"]
print("zone:", zid[:8] + "…", "status:", status)

# 1. DNS: proxied placeholder A records so the redirect rule has something to fire on.
dr = cf(f"/zones/{zid}/dns_records?per_page=100")
if dr.get("result") is None:
    print("dns list FAILED (token missing Zone→DNS→Edit?):", errs(dr))
have = {r["name"]: r for r in dr.get("result") or []}
for name in ("hlaverify.com", "www.hlaverify.com"):
    rec = {"type": "A", "name": name, "content": "192.0.2.1", "proxied": True, "ttl": 1,
           "comment": "placeholder origin; redirect rule handles requests"}
    if name in have and have[name]["type"] in ("A", "AAAA", "CNAME"):
        r = cf(f"/zones/{zid}/dns_records/{have[name]['id']}", "PUT", rec)
    else:
        r = cf(f"/zones/{zid}/dns_records", "POST", rec)
    print("dns", name, r["success"], errs(r))

# 2. Email routing: enable, register destination, hello@ forward rule.
r = cf(f"/zones/{zid}/email/routing/enable", "POST", {})
print("email enable:", r["success"], errs(r))  # 'already enabled' is fine
dest = "jason.brelsford@gmail.com"
ar = cf(f"/accounts/{acct}/email/routing/addresses?per_page=50")
if ar.get("result") is None:
    print("address list FAILED (token missing Account→Email Routing Addresses→Edit?):", errs(ar))
existing = ar.get("result") or []
match = [a for a in existing if a["email"] == dest]
if not match:
    r = cf(f"/accounts/{acct}/email/routing/addresses", "POST", {"email": dest})
    print("destination created (verification email sent to Gmail — click it):", r["success"], errs(r))
else:
    print("destination exists; verified:", bool(match[0].get("verified")))
rules = cf(f"/zones/{zid}/email/routing/rules?per_page=50").get("result") or []
if not any(m.get("value") == "hello@hlaverify.com" for rule in rules for m in rule.get("matchers", [])):
    r = cf(f"/zones/{zid}/email/routing/rules", "POST",
           {"name": "hello forward", "enabled": True,
            "matchers": [{"type": "literal", "field": "to", "value": "hello@hlaverify.com"}],
            "actions": [{"type": "forward", "value": [dest]}]})
    print("hello@ rule:", r["success"], errs(r))
else:
    print("hello@ rule exists")

# 3. Redirect: dynamic-redirect entrypoint ruleset -> 302 everything to TARGET.
expr = '(http.host eq "hlaverify.com") or (http.host eq "www.hlaverify.com")'
body = {"rules": [{
    "expression": expr, "enabled": True, "action": "redirect",
    "description": "temporary: send visitors to the current product surface",
    "action_parameters": {"from_value": {"status_code": 302,
        "target_url": {"value": TARGET}, "preserve_query_string": False}}}]}
r = cf(f"/zones/{zid}/rulesets/phases/http_request_dynamic_redirect/entrypoint", "PUT", body)
print("redirect →", TARGET, ":", r["success"], errs(r))
print("done; zone status:", status, "(rules take effect once the zone is active)")
