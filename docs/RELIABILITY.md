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
| What to do? | job `prompt` + agent | yes |
| Privilege expectation | prompt contract + `tool_call` block | yes (structural for built-ins) |

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
- `busy` / transient `locked` do **not** flood the ledger
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
  "status": "delivered|error|skipped|locked|busy",
  "startedAt": "…",
  "endedAt": "…",
  "detail": "optional reason",
  "tier": "read_only",
  "missedWindow": "catch_up_one"
}
```

Query via tool: `schedule action=history [id=…] [limit=10]`.

**Honest limitation:** `delivered` means the prompt was injected successfully,
not that the agent completed the task correctly. Outcome verification is future work.

### 7. Privilege / blast radius / self-persistence

**Threat (MAST-adjacent, agent security):** the agent authors `job.prompt`, which
is later replayed as a user message — a **stored-instruction persistence vector**.

**Mitigation — `tier` on create (default `read_only`):**

| Tier | Prompt | Structural (`tool_call`) |
|------|--------|---------------------------|
| `read_only` | no mutations | blocks `edit`, `write`, `bash` until `agent_settled` |
| `suggest` | drafts OK | blocks `bash` |
| `mutate` | changes allowed | none |

**Not yet:** interactive confirm gate on `tier=mutate` create; custom tools not in the block list.

### 8. Self-spam / runaway scheduling

**Mitigation:**
- Max **50** jobs per scope file (global or one project)
- Create rate limit **10/min** (in-process)
- Min interval **1m** (parser)
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

## Undocumented-but-important choices (now documented)

| Choice | Behavior |
|--------|----------|
| Daily schedule timezone | **Local** wall clock (`setHours`); DST shift days can be off by ~1h (daily grace covers skip within 1h) |
| Interval anchoring | Reschedule from **now** after fire → load-anchored, not fixed wall-clock phase; drift accumulates |
| `runs.jsonl` growth | Append-only, **no rotation** in MVP; operators may truncate |
| Idempotency scan window | Last **200** JSONL lines only; heavy backlog can age out a `delivered` record |
| Project root | `.pi/schedule.json` under **`ctx.cwd` only** — no upward walk. Launch pi from project root |
| File locks | Best-effort single-host; not a multi-machine consensus lock |

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
| `busy` | Wave fire-cap (job remains due) |

## References (selected)

- Liu & Gabriel, *PM-Bench* — arXiv:2607.12385 (COLM 2026)
- Zhang et al., *TriggerBench* — arXiv:2606.23459
- Wu, *When Errors Become Narratives* — arXiv:2606.14589
- Cemri et al., *MAST* — arXiv:2503.13657 (NeurIPS 2025 D&B)
- Huang et al., *Gray Failure: The Achilles' Heel of Cloud-Scale Systems* — **HotOS’17**
- Durable execution patterns (Temporal / Inngest / similar)
