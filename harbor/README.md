# Harbor-format tasks (Terminal-Bench-Science submissions)

Each subdirectory follows the Harbor Task Format from `github.com/harbor-framework/terminal-bench-science` (CONTRIBUTING.md):
`instruction.md`, `task.toml`, `environment/` (Dockerfile + data), `solution/` (reference solve.sh), `tests/` (separate verifier container).

| Task | Domain / field | What the agent must do | Verifier |
|---|---|---|---|
| `hla-typing-report-normalize` | life-sciences / immunogenetics | Normalize 200 mixed-era HLA typing strings (legacy, deleted, renamed, null, nonexistent) to current 2-field names + G groups + flags against IPD-IMGT/HLA 3.65.0, offline | exact match on all 200 rows |

Dry run without Harbor (Linux, as root or with a writable `/root`):
```bash
ln -s ~/.cache/sci_envs/imgt/v3.65.0-alpha /root/imgt; ln -s $PWD/harbor/hla-typing-report-normalize/environment/data /root/data
mkdir -p /solution && cp harbor/hla-typing-report-normalize/solution/* /solution/ && bash /solution/solve.sh
python3 harbor/hla-typing-report-normalize/tests/test_outputs.py     # rows correct: 200/200
```
With Harbor installed: `harbor tasks check harbor/hla-typing-report-normalize` then `harbor run --agent oracle --task harbor/hla-typing-report-normalize`.

Submission path (v0.2 window, target Oct 5 2026): Task Proposal Form (Airtable) → approval on the Task Proposal Board → PR to `tasks/life-sciences/immunogenetics/hla-typing-report-normalize/`.
Data licence: the environment downloads the pinned IPD-IMGT/HLA files verbatim at build time (CC-BY-ND, attributed); nothing from the database is committed here. The 200-row typing file is synthetic.
