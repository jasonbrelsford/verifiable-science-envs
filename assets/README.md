# assets/

Brand assets used by this repo, plus the source the public pages were migrated from.

`landing.html`, `product.html`, `demo.template.html` and `llms.txt` were served at
hlaverify.com by `cloudflare.yml`, which uploaded them as the `hlaverify-landing`
Worker. That Worker — and every page on hlaverify.com, including `/product`, `/demo`
and `/llms.txt` — is now deployed from
[jasonbrelsford/hlaverify-website](https://github.com/jasonbrelsford/hlaverify-website),
so **editing these four files no longer changes anything on the web**; edit them there.

They stay here as the migration source and as rollback material: `/demo` inlines
`sci_envs/reference/imgt.py` and `sci_envs/families/nomenclature/normalize.py`, which the
website build fetches from a pinned commit of this repo (`ENGINE_REF` in its `build.py`).
Bump that pin there when the demo should pick up engine changes.

`llms.txt` is also checked by `edge/test/docs-tools.test.mjs`, which fails if it stops
listing the tools the MCP server actually exposes.
