# HLA-Verify pipeline (CRM)

*Starter table, top 10 targets from `TARGETS.md`'s "Top 10 first calls" ranking. Owner
"outreach agent" means: draft the day-0 email from `OUTREACH.md` as a Gmail draft in
Jason's account and update this row; do not send. Update `Date` on every change. Stage
vocabulary: draft -> sent -> replied -> call-scheduled -> pilot -> closed -> dead.*

| # | Organization | Contact route | Stage | Next step | Owner | Date |
|---|---|---|---|---|---|---|
| 1 | NMDP (Bioinformatics / py-ard) | network.nmdp.org bioinformatics pages; GitHub nmdp-bioinformatics | draft | Draft C1 day-0 email as a Gmail draft; find a named bioinformatics contact via the GitHub org or network.nmdp.org | outreach agent | 2026-09-11 |
| 2 | Thermo Fisher One Lambda (HistoTrac + TypeStream Visual) | thermofisher.com One Lambda contact form; LinkedIn "HistoTrac product manager" | draft | Draft B1 day-0 email as a Gmail draft; identify HistoTrac product manager via LinkedIn search | outreach agent | 2026-09-11 |
| 3 | Werfen (Omixon HLA Twin + Immucor MIA FORA) | omixon.com contact; transfusionandtransplant.werfen.com contact | draft | Draft B1/B3 day-0 email (Omixon route first) as a Gmail draft | outreach agent | 2026-09-11 |
| 4 | Anthony Nolan (labs + registry) | anthonynolan.org cell-therapy-laboratory-services | draft | Draft A1 day-0 email as a Gmail draft, addressed to head of laboratories | outreach agent | 2026-09-11 |
| 5 | DKMS Life Science Lab / DKMS registry | dkms-lab.de/about; professional.dkms.org | draft | Draft A1 day-0 email as a Gmail draft (lab route first) | outreach agent | 2026-09-11 |
| 6 | CareDx (AlloSeq Tx / Assign) | caredx.com HLA typing page; labproducts.caredx.com | draft | Draft B1 day-0 email as a Gmail draft; identify VP product, transplant lab products | outreach agent | 2026-09-11 |
| 7 | GenDx (Eurobio Scientific) | gendx.com contact; labproducts.gendx.com | draft | Draft B1 day-0 email as a Gmail draft | outreach agent | 2026-09-11 |
| 8 | CIBMTR | cibmtr.org bioinformatics research page | draft | Draft C1 day-0 email as a Gmail draft, addressed to bioinformatics research director | outreach agent | 2026-09-11 |
| 9 | Anthropic (Claude for Life Sciences / Claude Science) | anthropic.com contact; Claude for Life Sciences partner form | draft | Draft C1 day-0 email as a Gmail draft; also note the MCP server as a ready-made connector | outreach agent | 2026-09-11 |
| 10 | Fred Hutch Clinical Immunogenetics Laboratory | fredhutch.org clinical-labs page; LinkedIn "Clinical Immunogenetics Laboratory Fred Hutch" | draft | Draft A1 day-0 email as a Gmail draft, addressed to lab director | outreach agent | 2026-09-11 |

## Notes for the agent updating this table

- Email bodies (day 0, day 5, day 12, LinkedIn DM) are in `docs/sales/OUTREACH.md` by
  tier (A = labs, B = LIMS/software vendors, C = registries/AI platforms). Fill in
  `[Name]`, `[Lab]`, `[Product]`, `[Org]` from public sources before drafting; do not
  invent a named contact you cannot verify — address the draft generically
  ("Hi there," / role title) if no name is confirmed.
- Every draft is created with the Gmail connector's `create_draft` tool, never sent.
  Move the row to `sent` only after Jason sends it himself and tells the agent (or the
  daily routine confirms the draft left the Drafts folder).
- Re-check the numbers cited in the email against `STATUS.md` before drafting; if a
  newer bench run has landed, update the figures in the draft, not just this table.
- Add rows for Tier A/B/C targets 11+ from `TARGETS.md` once the first 10 move past
  `draft`.
