# pi-schedule reliability model

This document captures the failure modes we design against and the mitigations
implemented in the MVP. It is grounded in research on prospective memory,
silent failures in production agent runtimes, multi-agent failure taxonomies,
and durable-execution practice.

## Thesis

> Reliable agent scheduling is an OS problem with an LLM payload: deterministic
> due detection, durable state, isolation, and verifiable outcomes — the model
> only does task content, never owns the clock, the lock, or the success bit.

## Separation of concerns

| Concern | Owner | LLM involved? |
|---------|--------|---------------|
| Is it due? | `nextRunAt` + runner | no |
| Missed window? | `missedWindow` policy | no |
| Single-flight? | lock manager | no |
| Already delivered this slot? | ledger idempotency key | no |
| What kind of fire? | job `action` (`prompt`/`shell`/`notify`/`message`) | no |
| What to do? | job `prompt` + agent (prompt / shell-wake) | yes when agent wakes |
| Shell command run | `pi.exec` in runner | no |
| Shell wake decision | `wakeOn` + exit code | no |
| Privilege expectation | prompt contract + `tool_call` block | yes (structural; only if agent woke) |

## Pitfalls → mitigations

### 1. Prospective-memory failure (wrong *when*)

**Research:** PM-Bench, TriggerBench — models miss due tasks or false-alarm;
precision/recall hard to calibrate; PM ≠ retrospective memory.

**Mitigation:**
- External `nextRunAt` / simple interval + daily math in `schedule.ts`
- Runner decides due/not-due; agent never polls “should I run?”

### 2. Attention hijack / user-task collision

**Research:** TriggerBench overload; production agents interrupting users.

**Mitigation:**
- Skip due checks only on process **`startup`** when pi was launched with a CLI
  initial prompt (`pi "…"`). `/new` and `/resume` still process due jobs.
- Tick fires only when `ctx.isIdle()`
- Subsequent multi-job deliveries use `deliverAs: "followUp"`

### 3. Missed window / backlog storm

**Research:** cron catch-up without policy; durable workflow missed-window guides.

**Mitigation — `missedWindow` per job:**

| Policy | Behavior when `nextRunAt` is in the past |
|--------|------------------------------------------|
| `catch_up_one` (default) | Fire once for the miss, then reschedule from now |
| `skip` | Fire only if still within grace of the planned slot; otherwise advance without firing |

Grace (must stay ≥ ticker latency):
- interval: `max(2 × tickMs, 25% of period)`, capped at 15m  
  (default tick = 30s → floor 60s; a 1m skip job is not spuriously skipped)
- daily: `max(2 × tickMs, 1 hour)`

**Fire caps (anti-storm):**
- max 5 automatic fires per `session_start` wave
- max 3 automatic fires per tick wave  
Overflow stays due for the next wave.

**v0.2 note:** TriggerBench finds accuracy degrades under overloaded concurrent
triggers. Consider a single digest message (“3 jobs due…”) instead of N stacked
prompts.

### 4. Double-fire / overlap

**Research:** cron+REST races; idempotent agent patterns.

**Mitigation:**
- **Idempotency key** = `jobId:nextRunAt` (force-run uses unique key)
- **Primary durable signal:** `job.lastIdempotencyKey` + `lastStatus===ok` on the store row
- Ledger `wasDelivered` is secondary (last 200 lines only)
- Re-check idempotency **after** lock acquire (check-then-act fix)
- **Single-flight lock** per job id:
  - in-process map
  - file lock via O_EXCL (`wx`); stale takeover via **rename** (not unlink) so one racer wins
  - release is token-scoped
- Store upserts take a per-file lock and re-read before write (cross-session RMW)
- transient `locked` does **not** flood the ledger
- Ledger `append` never throws; store advances **before** ledger write

### 5. Fail-plausible / polluted context

**Research:** *When Errors Become Narratives* (arXiv:2606.14589) — LLMs turn
errors into fluent false digests; ~70% of silent failures found by humans.

**Mitigation:**
- Isolated fire prompt (`prompt.ts`) with explicit contract:
  - report tool failures; do not invent findings
  - say “No findings” when empty
  - prefer evidence over claims
  - do not rewrite other schedules unless required
- Privilege tier block in every fire
- Labeled header: `runId`, `jobId`, `source`, `tier`
- **Tool honesty:** `run_now` reports actual `lastStatus` (`ok` / `locked` / `error` / …), never invents “Fired”

### 6. Forensic blind spots

**Research:** silent-failure class E; MAST verification failures.

**Mitigation — append-only run ledger** `~/.pi-schedule/runs.jsonl`:

```json
{
  "runId": "…",
  "jobId": "…",
  "jobName": "…",
  "idempotencyKey": "jobId:nextRunAt",
  "source": "session_start|tick|run_now",
  "status": "delivered|error|skipped|locked",
  "startedAt": "…",
  "endedAt": "…",
  "detail": "optional reason / shell exit summary",
  "tier": "read_only",
  "missedWindow": "catch_up_one",
  "action": "prompt|shell|notify|message"
}
```

Query via tool: `schedule action=history [id=…] [limit=10]`.

**Honest limitation:** `delivered` means the action ran (prompt injected, shell
finished, notify/message shown) — not that the agent completed a task correctly.
Shell exit codes are recorded in `detail` / `lastShell`; agent outcome verification is future work.

### 7. Privilege / blast radius / self-persistence

**Threat (MAST-adjacent, agent security):** the agent authors `job.prompt`, which
is later replayed as a user message — a **stored-instruction persistence vector**.

**Mitigation — `tier` on create (default `read_only`):**

| Tier | Prompt | Structural (`tool_call`) |
|------|--------|---------------------------|
| `read_only` | no mutations | blocks `edit`, `write`, `bash` until `agent_settled` |
| `suggest` | drafts OK | blocks `bash` |
| `mutate` | changes allowed | none |

Privilege enters **only when an agent turn starts** (prompt jobs, or shell jobs
that wake). `notify` / `message` / quiet shell runs do not push the stack.

**Early terminate (pi ≥ 0.84.1):** privilege blocks also set `terminate: true`
on the `tool_call` result. A scheduled `read_only`/`suggest` turn that attempts
a mutating tool has left its contract — there is nothing useful left to do
inside the fence, so a fully-blocked batch ends the turn without a follow-up
model call (no token burn on a doomed retry or apology). Batch semantics keep
this safe: a mixed batch that also ran allowed read tools does *not* terminate,
so the agent can still report its findings in text. On pi < 0.84.1 the field is
ignored and blocks behave as before.

**Shell jobs** always store `tier=mutate`. The command itself runs via
`pi.exec` (outside the agent tool path) — that is intentional for CI polls,
but it is a real local-execution surface. Prefer narrow commands and
`wakeOn=failure` so the agent only wakes with context when needed.

**Schedule-tool escalation guard:** the `schedule` tool itself is in the
privilege block list. A `read_only` or `suggest` fired turn **cannot** call
`schedule` with `create`/`cancel`/`enable`/`disable`/`run_now` — those persist
state (and `create` of `kind=shell` would be a read_only → mutate-shell
escalation). `list`/`history` stay allowed. To let a scheduled job manage
other schedules, create it as `tier=mutate`.

**Not yet:** interactive confirm gate on `tier=mutate` / shell create; custom tools not in the block list; command allowlists.

### 8. Self-spam / runaway scheduling

**Mitigation:**
- Max **50** jobs per scope file (global or one project)
- Create rate limit **10/min** (in-process)
- Min interval **1m** (parser); `once` allows seconds up to **90d**
- **`maxRuns`** caps deliveries per job (counts ok + error); the job then auto-disables (`terminated: maxRuns`) instead of firing forever
- **`once`** jobs fire exactly once then terminate — no runaway one-shots
- Prompt contract discourages schedule thrash

### 9. Seams / long-latency silent bugs

**Research:** silent-failures paper — longest incidents lived in seams, not
complex modules; governance is a regression engine, not a predictor.

**Mitigation posture:**
- Prefer simple file formats + pure functions (testable)
- Atomic writes for schedule JSON
- **Corrupt / wrong-version store → quarantine** (`*.corrupt-<ts>`), never silent wipe.
  Restore over original path and retry — **no process freeze / restart required**
- **StoreError on auto paths**: notify and return `[]`. UI or `console.error`.
  Rate-limited (5m). `run_now` rethrows only
- **run_now** serializes on the wave chain (never drops when ticker is active)
- **Fire cap** counts `ok` + `error` attempts (not only successes)
- Daily wall-clock: spring-forward gaps walk to next valid day; fall-back still platform-defined
- Document daemon-ready fields now; keep one representation
- “Sunset Law”: do not add layers without retiring complexity

### 10. Prompt submission vs. context compaction

**Failure mode:** pi rejects `sendUserMessage` while context compaction is in
flight ("Cannot submit a prompt while compaction is in progress"). A
scheduled wake lands in exactly that window when a long shell poll finishes
into a session whose context is being compacted — the delivery crashes into
the extension runtime instead of the task reaching the agent.

**Mitigation — bounded busy-wait in `runner.ts` (`sendAgentMessage`):**

- The runner tracks `session_before_compact` / `session_compact` events and
  parks delivery (500ms poll) while compaction is flagged, skipping doomed
  first attempts.
- The thrown compaction error is the authoritative backstop (missed-event
  race): the send is retried on a fixed cadence until it lands.
- The wait is bounded by `compactionWaitMs` (default **120s**, ~longest sane
  compaction). A stuck or cancelled compaction degrades to the normal
  delivery-error path — job marked `error`, `nextRunAt` advanced (no hot-loop),
  ledger row — never a hung wave.
- `session_start` / `session_shutdown` reset the flag so a stale hint cannot
  park later sessions; a successful send also clears it.

## Undocumented-but-important choices (now documented)

| Choice | Behavior |
|--------|----------|
| Daily schedule timezone | **Local** wall clock (`setHours`); DST shift days can be off by ~1h (daily grace covers skip within 1h) |
| Interval anchoring | Reschedule from **now** after fire → load-anchored, not fixed wall-clock phase; drift accumulates |
| `runs.jsonl` growth | Append-only, **no rotation** in MVP. Operators may truncate the **head** (keep the tail — `wasDelivered` only scans the last 200 lines, so a head-truncate is safe and preserves recent idempotency) |
| Idempotency scan window | Last **200** JSONL lines only; heavy backlog can age out a `delivered` record |
| Project root / scope | `.pi/schedule.json` under **`ctx.cwd` only** — no upward walk. Launch pi from project root. Note: `.pi/` is gitignored, so **project-scoped jobs are machine-local**, not team-shared via git (treat "project" as "namespaced to this directory on this machine") |
| File locks | Best-effort single-host; not a multi-machine consensus lock |
| Global shell `cwd` | A global shell job has no `projectPath`, so it runs in the session `cwd` — a relative command is session-dependent. Use a project-scoped job or an absolute command for a deterministic cwd |
| Compaction collision | Prompt delivery during context compaction waits up to **120s** (`compactionWaitMs` in the runner), then fails via the normal error path — the task is never silently dropped, but a compaction longer than 120s loses that slot to the next schedule |

## Storage layout

```
~/.pi-schedule/
  schedules.json          # global jobs
  schedules.json.corrupt-*  # quarantined bad files (if any)
  runs.jsonl              # append-only run ledger
  locks/<jobId>.lock      # O_EXCL single-flight

<project>/.pi/schedule.json   # project jobs
```

## Tool surface (reliability-related)

```
schedule action=create … missedWindow=catch_up_one|skip tier=read_only|suggest|mutate
schedule action=list
schedule action=history [id=…] [limit=10]
schedule action=run_now id=…   # reports actual status, never invents success
```

## What MVP deliberately does NOT do yet

| Deferred | Why |
|----------|-----|
| OS daemon / durable workflow engine | In-session first; storage is ready |
| True tool sandbox by tier | Needs pi platform support |
| Confirm gate on `mutate` create | UX + platform dialogs |
| Agent outcome verification / empty-result detector | Needs post-turn hooks or structured agent reply |
| Digest multi-due into one message | v0.2 research-aligned improvement |
| Cron expressions | Simple intervals + daily first |
| Distributed locks across machines | File lock is single-host best-effort |
| `runs.jsonl` rotation | Operator-managed for now |
| `/schedule` user command | Tools-only MVP |

## Status vocabulary

| Job `lastStatus` | Meaning |
|------------------|---------|
| `ok` | Prompt delivered |
| `error` | Delivery threw |
| `skipped` | Missed-window skip or idempotent replay |
| `locked` | Could not acquire single-flight lock |
| `null` | Never attempted |

| Ledger `status` | Meaning |
|-----------------|---------|
| `delivered` | `sendUserMessage` succeeded |
| `error` | Delivery failed |
| `skipped` | Policy or idempotency |
| `locked` | Lock contention |

## References (selected)

- Liu & Gabriel, *PM-Bench* — arXiv:2607.12385 (COLM 2026)
- Zhang et al., *TriggerBench* — arXiv:2606.23459
- Wu, *When Errors Become Narratives* — arXiv:2606.14589
- Cemri et al., *MAST* — arXiv:2503.13657 (NeurIPS 2025 D&B)
- Huang et al., *Gray Failure: The Achilles' Heel of Cloud-Scale Systems* — **HotOS’17**
- Durable execution patterns (Temporal / Inngest / similar)
