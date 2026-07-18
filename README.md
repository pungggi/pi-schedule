# pi-schedule

Recurring scheduled tasks for [pi](https://pi.dev) agents.

Give the agent a way to schedule work like:

- security reviews
- package / artifact version checks
- status polls
- any other recurring prompt-driven task

Published as a pi package (`pi install`).

## Install

```bash
pi install npm:pi-schedule
# or local
pi install ./pi-schedule
# or one-shot
pi -e ./src/extension.ts
```

## How it works

| Piece | Behavior |
|-------|----------|
| **Tool** | `schedule` — create / list / cancel / enable / disable / run_now / history |
| **Storage** | Hybrid: global `~/.pi-schedule/schedules.json` + project `.pi/schedule.json` |
| **Syntax** | Intervals (`30m`, `2h`, `1d`) and daily wall-clock (`09:00`) |
| **Fire** | On session start when due; also while the session stays open (30s ticker) |
| **Skip** | If pi was launched with an initial prompt (`pi "do X"`), due jobs are **not** checked or triggered for that start |
| **Reliability** | Run ledger, single-flight locks, missed-window policy, privilege tiers, fire caps — see [docs/RELIABILITY.md](docs/RELIABILITY.md) |

Storage is **daemon-ready**: each job tracks `nextRunAt` / `lastRunAt` so a future headless runner can share the same files.

## Agent tool

```text
schedule
  action: create | list | cancel | enable | disable | run_now | history
  name?:          short label (create)
  prompt?:        full task text injected when due (create)
  every?:         "30m" | "2h" | "1d"   (xor dailyAt)
  dailyAt?:       "09:00"               (xor every)
  scope?:         "global" | "project"  (default: project if .pi exists)
  missedWindow?:  "catch_up_one" | "skip"   (default catch_up_one)
  tier?:          "read_only" | "suggest" | "mutate"  (default read_only)
  id?:            job id
  limit?:         history row count
```

### Examples

```text
# Daily security review at 09:00, project-scoped, read-only
schedule action=create name="security-review"
  prompt="Review recent changes for security issues. Summarize findings."
  dailyAt="09:00" scope="project" tier="read_only"

# Check package versions every day; skip if the session opens long after due
schedule action=create name="pkg-versions"
  prompt="Check npm outdated / new package versions. Report only meaningful updates."
  every="1d" missedWindow="skip"

# List / history / force / cancel
schedule action=list
schedule action=history id=abc123def456
schedule action=run_now id=abc123def456
schedule action=cancel id=abc123def456
```

## Delivery rules

1. **Session start** (`startup` / `new` / `resume`): load hybrid store → process due jobs.
2. **CLI initial prompt**: only on process **`startup`**, if launched with a user message (`pi "check this"`), skip due checks. `/new` and `/resume` still process due jobs.
3. **Missed window**: `catch_up_one` fires once when overdue; `skip` only fires within grace (`max(2×tick, 25% period)`), otherwise advances without firing.
4. **In-session ticker**: every 30s, if the agent is idle, process newly due jobs (capped).
5. **`run_now`**: attempts force delivery; tool reports **actual** status (`ok` / `locked` / `error`), never invents success.
6. **Locks + ledger**: O_EXCL file lock + idempotency key; forensic trail in `~/.pi-schedule/runs.jsonl`.

Fired jobs use an isolated prompt contract:

```text
[scheduled-task]
runId: …
jobId: …
…

## Task
…

## Contract
- isolated run; do not invent findings; say "No findings" if empty
- PRIVILEGE: read_only | suggest | mutate
```

## File layout

```
~/.pi-schedule/
  schedules.json
  runs.jsonl
  locks/

<project>/.pi/schedule.json
```

## Reliability

Deep dive: **[docs/RELIABILITY.md](docs/RELIABILITY.md)**

Summary of MVP mitigations:

- External clock (`nextRunAt`), not LLM timing
- Missed-window policy + fire caps
- Single-flight locks + idempotency keys
- Append-only run ledger (`history`)
- Privilege tiers in the fire prompt
- Create rate limit + max jobs per scope

## MVP scope

- tools-only (no `/schedule` command yet)
- no cron expressions
- no background OS daemon (in-session only; storage is ready)
- `delivered` = prompt injected, not “agent finished correctly”

## Dev

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
