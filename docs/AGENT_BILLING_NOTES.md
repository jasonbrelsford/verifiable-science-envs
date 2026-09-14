# Agent pay-per-call billing — design notes (not implemented)

*Design only. No billing code changes in this document's commit. Do not implement
against live Stripe until Waiting on Jason #3 (live Stripe activation) is done — see
`docs/PROJECTS.md`.*

## Why this exists

Today's tiers (free/starter/pro/enterprise, `edge/src/keys.js`) are flat-fee
subscriptions bought once on `/pricing` and enforced per request by
`edge/src/index.js`'s `authorize()` / `limiterFor()`. That fits a human buying a seat.
It fits an autonomous agent (an MCP client, a lab's pipeline bot) worse: an agent
calling `/mcp` or `/v1/*` a handful of times a month has no reason to commit to a
monthly subscription, and a platform integrator wants to pass the API's marginal
cost straight through to *their* end user rather than provision a shared key. Both
want to pay per call.

## Two candidate mechanisms

### Option A — Stripe metered billing (usage-based subscription)

- A customer still goes through Stripe Checkout once, but to a **metered price**
  (`billing_scheme: "per_unit"`, `usage_type: "metered"`) instead of the current
  flat recurring price. Stripe bills them at the end of each period for units
  reported via `POST /v1/subscription_items/{id}/usage_records`.
- The Worker already meters every request (`meter()` in `edge/src/index.js` and
  `edge/src/stripe.js`, writing to the `USAGE` Analytics Engine dataset). The new
  work would be a scheduled job (Cron Trigger or a GitHub Actions workflow, *not*
  triggered from the request path) that reads `USAGE` per key-label since the last
  report and calls Stripe's usage-record endpoint once per billing period.
- Pros: reuses Stripe's existing invoicing, dunning, and customer portal — no new
  ledger to build or reconcile; a customer's payment method is already on file from
  the same Checkout flow the flat tiers use.
- Cons: still requires a Stripe customer object and a card on file up front, so it
  does not remove the "create a subscription before you can call anything" step —
  it only changes what gets billed. Doesn't fit an agent that wants to try one call
  with no account at all (today's anonymous free tier already covers that case at
  60 req/min, so this is a smaller gap than it first looks).
- Where it plugs in: `resolveTier()` / `onCheckoutCompleted()` in `edge/src/stripe.js`
  would need a `metered` tier alongside the existing four; `authorize()` would treat
  it like `starter`/`pro` for rate-limit purposes but skip the flat-price assumption
  baked into `PRICING_HTML()`.

### Option B — x402-style micropayment (HTTP 402 + on-chain or off-chain settlement)

- The request path: an unauthenticated agent call to a metered endpoint gets back
  `402 Payment Required` with a machine-readable price and a payment address/token
  in the response body (the emerging `x402` convention: a stablecoin transfer on an
  L2, settled per call, no account or card required). The agent's own HTTP client
  retries the same request with a payment proof header; the Worker verifies the
  proof (a facilitator service or on-chain lookup) and serves the request.
- Pros: genuinely account-less — an agent can discover the price and pay in one
  round trip with no Checkout session, no Stripe customer, no key provisioning.
  Fits the MCP/agent-platform audience better than a subscription does.
- Cons: real integration weight for a small API — a payment-verification
  dependency (facilitator API or an RPC call to a chain), no dunning/refund
  tooling, exposes the Worker to a new class of correctness bug (double-spend /
  replay of a payment proof) that the current design has zero surface for. Would
  need its own settlement ledger (at minimum: which payment proofs have already
  been redeemed) — Workers KV could hold that, keyed by proof hash, same shape as
  the existing `KEYS` store.
- Where it plugs in: a new branch in `authorize()` for the `402` challenge/response,
  parallel to the existing keyed/anonymous branches; would **not** touch the
  existing Stripe code path at all, so it's additive rather than a change to
  Option A.

## Recommendation (for later, not now)

Start with **Option A** if agent demand materializes before x402 tooling matures on
the client side most agent platforms actually use — it is a few days of Worker
+ scheduled-job code on top of an already-proven Stripe integration, versus a new
payment-verification dependency for Option B. Revisit Option B specifically if a
prospect (see `docs/sales/PIPELINE.md` row 9, Anthropic/Claude for Life Sciences, or
row 19, OpenAI) asks for it directly — that is the signal worth building account-less
micropayment for, not a guess.

Either option is blocked on Waiting on Jason #3 (live Stripe secrets) for real
revenue; sandbox testing of Option A's metered-price flow could happen against the
Stripe *sandbox* key already proven end-to-end, without needing live secrets, if
this becomes a priority before #3 lands. Nothing here should be implemented until
Jason has read this document and picked a direction — this is a menu, not a plan.
