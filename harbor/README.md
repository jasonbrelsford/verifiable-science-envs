# Harbor-format tasks (Terminal-Bench-Science submissions)

Each subdirectory follows the Harbor Task Format from `github.com/harbor-framework/terminal-bench-science` (CONTRIBUTING.md):
`instruction.md`, `task.toml`, `environment/` (Dockerfile + data), `solution/` (reference solve.sh), `tests/` (separate verifier container).

| Task | Domain / field | What the agent must do | Verifier |
|---|---|---|---|
| `hla-typing-report-normalize` | life-sciences / immunogenetics | Normalize 200 mixed-era HLA typing strings (legacy, deleted, renamed, null, nonexistent) to current 2-field names + G groups + flags against IPD-IMGT/HLA 3.65.0, offline | exact match on all 200 rows; truth rebuilt at verifier build time |

Dry run without Harbor (Linux, writable `/app`, `/tests`, `/logs`):
```bash
mkdir -p /app/results /tests /logs/verifier; ln -s ~/.cache/sci_envs/imgt/v3.65.0-alpha /app/imgt; ln -s $PWD/harbor/hla-typing-report-normalize/environment/data /app/data; cp -r harbor/hla-typing-report-normalize/tests/* /tests/
mkdir -p /solution && cp harbor/hla-typing-report-normalize/solution/* /solution/ && bash /solution/solve.sh
python3 /tests/build_truth.py --imgt /app/imgt --typing /tests/typing_reports.csv --out /tests/expected.csv --selfcheck && bash /tests/test.sh   # reward.txt = 1
```
With Harbor + Docker: `uv tool install harbor && harbor run -p harbor/hla-typing-report-normalize -a oracle` — this is what `.github/workflows/harbor-oracle.yml` runs on every change under `harbor/`.

Submission path (v0.2 window, target Oct 5 2026): Task Proposal Form (Airtable) → approval on the Task Proposal Board → PR to `tasks/life-sciences/immunogenetics/hla-typing-report-normalize/`.
Data licence: the environment downloads the pinned IPD-IMGT/HLA files verbatim at build time (CC-BY-ND, attributed); nothing from the database is committed here. The 200-row typing file is synthetic.
