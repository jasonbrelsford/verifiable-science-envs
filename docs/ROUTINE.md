# VP standup — daily operating procedure

*This is the script a scheduled agent ("VP standup") runs every weekday morning, unattended.
It reads `docs/PROJECTS.md`, does the smallest useful slice of agent-owned work, and leaves
the board and the repo in a state the next run (human or agent) can pick up from.*

## Preconditions

- Working directory: `C:\Users\jason\Downloads\high-valuation-startup\verifiable-science-envs`.
- Start on `main`, pulled clean. If the tree is dirty or `main` fails to fast-forward, stop
  and write the failure into "if anything goes wrong" below instead of proceeding.
- Model: use the smallest model that can do the picked action (Haiku for mechanical
  edits/doc updates, Sonnet for anything touching code or grader logic). Never use Opus for
  routine work; escalate only if a Sonnet session reports it is stuck.

## Steps

1. **Read** `docs/PROJECTS.md` in full, then `.tower-queue.json` and the latest CI run
   status (`gh run list --limit 5` if `gh` is available; otherwise skip and note it).
2. **Pick work.** For each project section in order (a) through (f), take the first
   next-agent-action that is not blocked-on-human and not already in flight. Cap the
   session to **at most 3 actions total across all projects**, smallest-effort first, so one
   run stays reviewable. Skip any action whose section lists it under "blocked on human."
3. **Do the work** in a normal edit/commit cycle, one action at a time:
   - Make the change.
   - Run the relevant tests locally (`pytest -q` for anything under `sci_envs/`; `cd edge &&
     node --test test/golden.test.mjs` for anything under `edge/`). If a test suite is
     unrelated to the change, still run the fast one (`pytest -q -k <touched-area>` or the
     full edge golden test) as a smoke check.
   - **If tests fail, do not commit that action.** Revert the change, leave the next-action
     line in `PROJECTS.md` unchanged (do not mark it done), and add one line to that
     project's "blocked" area or done log noting the failure and the date, then move to the
     next candidate action instead.
4. **Commit and push** each successful action separately (small commits, not one giant
   diff at the end):
   ```
   git add -A
   git commit -m "<concise summary of the action>

   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
   git push origin main
   ```
   A push to `main` is what triggers `edge-deploy.yml` and `cloudflare.yml` — this is the
   intended deploy path. Never push if the local test run in step 3 failed.
5. **Update `docs/PROJECTS.md`** for every action taken, in the same commit as the action
   or a fast-follow doc commit:
   - Move the completed line out of "next agent actions" and into that project's "done log"
     with today's date, prepended (keep only the last 5 entries, drop the oldest).
   - Add a fresh next-agent-action if the completed one revealed a follow-on step.
   - If an action turned out to be blocked on something human-only that was not already
     listed, add it to that project's "blocked on human" list and to the top-level
     "Waiting on Jason" section.
6. **Regenerate "Waiting on Jason."** Re-scan every project's "blocked on human" list and
   rewrite the top-level numbered list from scratch so it stays in sync (don't just append).
   Keep the priority ordering rule: security/credential exposure first, revenue-blocking
   items next, legal/compliance next, then everything else, oldest-flagged first within a
   tier.
7. **Never**, under any circumstance in this routine:
   - touch a secret (no `wrangler secret put`, no editing `.env`, no reading secret values),
   - take a payment action or touch Stripe live-mode configuration,
   - send an email, Slack message, or any external message (drafts are fine; sending is not),
   - deploy anything that failed its tests, or push directly to a branch other than `main`,
   - mark an item done that a human needs to verify (trademark filed, PAT rotated, pilot
     signed) — those move only when Jason or the overseer says so.
8. **Write the human note.** At the end of the run, if anything new needs Jason (a new
   blocked-on-human item, a failed deploy, a test that has been red for 2+ runs), write a
   short plain-language paragraph (no jargon, 3-6 sentences) and append it, dated, to a
   `## Latest note to Jason` section at the very top of `docs/PROJECTS.md`'s "Waiting on
   Jason" section, replacing the previous note. If nothing new needs him, replace it with
   one line: "Nothing new for you today — see the numbered list above for standing items."
9. **Final commit.** If steps 5-8 produced doc-only changes not already pushed with an
   action commit, commit and push them:
   ```
   git add docs/PROJECTS.md docs/sales/PIPELINE.md
   git commit -m "vp-standup: update board and waiting-on-Jason list [skip ci]

   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
   git push origin main
   ```

## Suggested cron

Weekday mornings, US Central time, after Jason's typical overnight window and before he
starts his day: **07:15 America/Chicago, Monday-Friday** (cron: `15 7 * * 1-5` in Central
time, or `15 12 * * 1-5` UTC during CDT / `15 13 * * 1-5` UTC during CST — set the schedule
in UTC and adjust twice a year for daylight saving, or use a scheduler that accepts an IANA
timezone directly). Use `mcp__scheduled-tasks__create_scheduled_task` (or the `schedule`
skill) to create this once; do not recreate it every run.

## On failure

- **Git push rejected / diverged from origin:** `git pull --rebase origin main`, resolve
  trivially or abort and leave a note; never force-push.
- **Test suite red before any change was made:** do not attempt a fix as one of the 3
  capped actions unless the fix is one-line and obviously correct (e.g. a typo in a test
  fixture); otherwise log it as the top item in the human note and stop touching that area
  for the rest of the run.
- **A workflow (`edge-deploy`, `cloudflare`, `hf-publish`, `hf-space`) fails after push:**
  do not retry blindly. Read the failure via `gh run view <id> --log-failed` if available,
  add one line to the relevant project's done log describing the failure, and surface it in
  the human note. Do not push a second speculative fix in the same run — one diagnosis pass,
  then stop and let a human or the next run pick it up.
- **Uncertain whether an action needs a human:** default to treating it as blocked-on-human
  and list it; a false positive costs Jason 10 seconds of reading, a false negative costs a
  bad deploy or an unauthorized message.
- **Scheduler itself fails to fire:** this is visible from the gap in the done logs; the
  overseer's own periodic review is the backstop, not this document.
