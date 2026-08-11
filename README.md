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
| **Kinds** | `prompt` (default) · `shell` · `notify` · `message` — what fires when due |
| **Storage** | Hybrid: global `~/.pi-schedule/schedules.json` + project `.pi/schedule.json` |
| **Syntax** | Intervals (`30m`, `2h`, `1d`) and daily wall-clock (`09:00`) |
| **Fire** | On session start when due; also while the session stays open (30s ticker) |
| **Skip** | If pi was launched with an initial prompt (`pi "do X"`), due jobs are **not** checked or triggered for that start |
| **Reliability** | Run ledger, single-flight locks, missed-window policy, privilege tiers, fire caps — see [docs/RELIABILITY.md](docs/RELIABILITY.md) |

Storage is **daemon-ready**: each job tracks `nextRunAt` / `lastRunAt` so a future headless runner can share the same files.

**Compatibility:** works on any pi ≥ 0.74. On pi ≥ 0.84.1, privilege blocks also
*terminate* the scheduled turn early — a read-only/suggest job that attempts a
mutating tool ends without a wasted follow-up model call (mixed read+mutate
batches still report findings in text). On older pi the extra field is ignored
and blocks behave as before.

## Agent skill

The package ships a **`schedule` skill** (`skills/schedule/SKILL.md`) that
loads on-demand and teaches the agent *how to schedule well*: when to use
`kind` (prompt / shell / notify / message), `every` vs `dailyAt`, privilege
tier, shell `wakeOn`, the missed-window tradeoff, and self-contained prompts.
The tool is self-describing for mechanics; the skill owns the patterns.

## Agent tool

```text
schedule
  action: create | list | cancel | enable | disable | run_now | history
  name?:          short label (create)
  kind?:          prompt | shell | notify | message   (default prompt)
  prompt?:        task / reminder text; shell follow-up instruction
  command?:       shell only — run via bash -lc
  wakeOn?:        shell only — always | failure | success | never
  successPrompt?: shell only — agent text on exit 0
  failurePrompt?: shell only — agent text on non-zero / killed
  timeoutMs?:     shell only — default 60000, max 600000
  once?:          one-shot relative delay ("10m" / "30s"), then terminate (xor every/dailyAt)
  maxRuns?:       max deliveries (ok+error) before auto-disable
  every?:         "30m" | "2h" | "1d"   (xor dailyAt/once)
  dailyAt?:       "09:00"               (xor every/once)
  scope?:         "global" | "project"  (default: project if .pi exists)
  missedWindow?:  "catch_up_one" | "skip"   (default catch_up_one)
  tier?:          "read_only" | "suggest" | "mutate"  (default read_only; shell→mutate)
  id?:            job id
  limit?:         history row count
```

### Job kinds

| kind | What happens | Agent turn? |
|------|----------------|-------------|
| **prompt** (default) | Inject isolated task contract | yes |
| **shell** | `pi.exec("bash", ["-lc", command])`; optional wake via `wakeOn` | only if wake fires |
| **notify** | UI/console reminder | no |
| **message** | Session custom message (display only) | no |

Shell jobs always store `tier=mutate` (command runs outside the agent tool path). Prefer `wakeOn=failure` for CI polls so success is silent.

### Lifecycle: `once` and `maxRuns`

- **`once`** — fire one time after a relative delay (`once="10m"`, `once="30s"`), then auto-disable. Ideal for reminders and delayed follow-ups. `run_now` won't re-fire a terminated one-shot — recreate it.
- **`maxRuns`** — cap a recurring job to N deliveries (counts ok + error; skips/locks don't count). After the cap, the job auto-disables with `terminated: maxRuns`. Re-enabling clears the flag and resumes counting.

A terminated job is disabled and excluded from due scans. `list` shows `[off/terminated:once]` or `[…:maxRuns]`.

### Examples

```text
# Daily STATIC security review at 09:00, project-scoped, read-only.
# (Static = read/search only. A git-driven "recent changes" review would need
#  bash, which read_only blocks — use tier="mutate" for that.)
schedule action=create name="security-review"
  prompt="Review the code under src/ for security issues (injection, auth bypass, exposed secrets). Summarize findings with file:line. If none, say 'No findings'."
  dailyAt="09:00" scope="project" tier="read_only"

# Direct shell poll — no agent turn on green; wake only on failure.
schedule action=create name="ci-poll" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure"
  failurePrompt="Latest CI run failed. Inspect logs and propose or apply fixes."
  every="5m" missedWindow="skip"

# Human reminder (no model tokens).
schedule action=create name="stretch" kind="notify"
  prompt="Stand up and stretch." every="1h"

# One-shot reminder in 5 minutes, then done.
schedule action=create name="break" kind="notify"
  prompt="Eye break — look 20ft away for 20s." once="5m"

# Bounded CI poll — stop after 10 checks even if still failing.
schedule action=create name="deploy-watch" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure" failurePrompt="Deploy failed — investigate."
  every="5m" maxRuns=10 missedWindow="skip"

# Check package versions every day via an agent prompt that must use the shell.
schedule action=create name="pkg-versions"
  prompt="Run `npm outdated` for prod dependencies. Report only meaningful updates as current→latest with a one-line rationale. If nothing meaningful, reply 'No findings'."
  every="1d" tier="mutate" missedWindow="skip"

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

Forward-looking design notes:

- **[docs/RELIABILITY.md](docs/RELIABILITY.md)** — failure modes & mitigations
- **[docs/FUTURE-per-job-models.md](docs/FUTURE-per-job-models.md)** — per-job model selection spike (upstream-blocked on pi)

Summary of MVP mitigations:

- External clock (`nextRunAt`), not LLM timing
- Missed-window policy + fire caps
- Single-flight locks + idempotency keys
- Append-only run ledger (`history`)
- Privilege tiers in the fire prompt
- Create rate limit + max jobs per scope

## MVP scope

- tool + skill (a `schedule` skill ships in `skills/`, teaching kind/tier/scope/missed-window choices and self-contained prompt writing); no dedicated `/schedule` slash command yet
- action kinds: prompt / shell / notify / message (shell via `bash -lc`, optional `wakeOn`)
- lifecycle: `once` one-shots + `maxRuns` bounded polling
- no cron expressions yet
- no background OS daemon (in-session only; storage is ready)
- `delivered` = action executed (prompt injected / shell finished / notify shown), not “agent finished correctly”

## Dev

```bash
npm install
npm test
npm run typecheck
```

## Publishing

Releases are CI-driven: push a `v*.*.*` tag and GitHub Actions publishes to
npm with provenance. One-time setup (npm token + `NPM_TOKEN` secret) and the
per-release flow are documented in **[docs/PUBLISHING.md](docs/PUBLISHING.md)**.

```bash
npm version patch -m "release: %s"   # bumps package.json + tags
git push origin master --follow-tags   # triggers release.yml
```

## License

MIT
