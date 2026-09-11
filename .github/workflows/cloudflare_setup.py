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

# 3. Landing worker (if the token can): serve assets/landing.html at hlaverify.com.
worker_ok = False
if os.environ.get("DEPLOY_WORKER") == "1":
    html = open("assets/landing.html", encoding="utf-8").read()
    product = open("assets/product.html", encoding="utf-8").read()
    llms = open("assets/llms.txt", encoding="utf-8").read()
    demo = open("assets/demo.template.html", encoding="utf-8").read()
    demo = demo.replace("__IMGT_PY__", json.dumps(open("sci_envs/reference/imgt.py", encoding="utf-8").read()))
    demo = demo.replace("__NORMALIZE_PY__", json.dumps(open("sci_envs/families/nomenclature/normalize.py", encoding="utf-8").read()))
    js = ('const HTML = ' + json.dumps(html) + ';\n'
          'const PRODUCT = ' + json.dumps(product) + ';\n'
          'const LLMS = ' + json.dumps(llms) + ';\n'
          'const DEMO = ' + json.dumps(demo) + ';\n'
          'export default { async fetch(req) {\n'
          '  const u = new URL(req.url);\n'
          '  if (u.pathname === "/healthz") return new Response("ok");\n'
          '  if (u.pathname === "/llms.txt") return new Response(LLMS, { headers: {\n'
          '    "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });\n'
          '  if (u.pathname === "/demo" || u.pathname === "/demo/") return new Response(DEMO, { headers: {\n'
          '    "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });\n'
          '  if (u.pathname === "/product" || u.pathname === "/product/") return new Response(PRODUCT, { headers: {\n'
          '    "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });\n'
          '  if (u.pathname === "/pricing") return Response.redirect("https://api.hlaverify.com/pricing", 302);\n'
          '  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8",\n'
          '    "cache-control": "public, max-age=300" } });\n} };')
    import urllib.request as _u
    boundary = "----hlavb"
    meta = json.dumps({"main_module": "worker.js", "compatibility_date": "2026-01-01"})
    parts = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n'
             f'--{boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n{js}\r\n'
             f'--{boundary}--\r\n').encode()
    req = _u.Request(f"https://api.cloudflare.com/client/v4/accounts/{acct}/workers/scripts/hlaverify-landing",
                     method="PUT", data=parts,
                     headers={"Authorization": "Bearer " + TOK,
                              "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        import json as _j
        with _u.urlopen(req, timeout=30) as resp_:
            up = _j.loads(resp_.read())
    except Exception as e:
        up = _j.loads(e.read()) if hasattr(e, "read") else {"success": False, "errors": [{"message": str(e)}]}
    print("worker upload:", up.get("success"), errs(up))
    if up.get("success"):
        routes = cf(f"/zones/{zid}/workers/routes").get("result") or []
        for pat in ("hlaverify.com/*", "www.hlaverify.com/*"):
            hit = [r for r in routes if r.get("pattern") == pat]
            if hit:
                r = cf(f"/zones/{zid}/workers/routes/{hit[0]['id']}", "PUT", {"pattern": pat, "script": "hlaverify-landing"})
            else:
                r = cf(f"/zones/{zid}/workers/routes", "POST", {"pattern": pat, "script": "hlaverify-landing"})
            print("route", pat, r.get("success"), errs(r))
        r = cf(f"/zones/{zid}/rulesets/phases/http_request_dynamic_redirect/entrypoint", "PUT", {"rules": []})
        print("redirect cleared (worker serves the site):", r.get("success"), errs(r))
        worker_ok = True

# 3b. Redirect fallback: dynamic-redirect entrypoint ruleset -> 302 everything to TARGET.
expr = '(http.host eq "hlaverify.com") or (http.host eq "www.hlaverify.com")'
body = {"rules": [{
    "expression": expr, "enabled": True, "action": "redirect",
    "description": "temporary: send visitors to the current product surface",
    "action_parameters": {"from_value": {"status_code": 302,
        "target_url": {"value": TARGET}, "preserve_query_string": False}}}]}
if not worker_ok:
    r = cf(f"/zones/{zid}/rulesets/phases/http_request_dynamic_redirect/entrypoint", "PUT", body)
    print("redirect →", TARGET, ":", r["success"], errs(r))
print("done; zone status:", status, "(rules take effect once the zone is active)")
