# pi-schedule — Code Review

A deep, theme-grouped review of the `pi-schedule` codebase (`src/` 13 files /
~3,037 lines, `test/` 13 files / ~2,800 lines, plus docs, CI, README/SKILL).

**Health check:** `tsc --noEmit` ✅ · `vitest run` → 173/173 ✅ (162 at
review time; +4 DST, +1 fresh-lock, +6 P2, net 0 P3) · `npm pack` guard
enforced in CI ✅

Overall this is a **well-engineered, reliability-focused** package. The
`docs/RELIABILITY.md` threat-model → mitigation mapping is excellent, the
"never invents success" discipline in `run_now` is rare and commendable, and
the privilege escalation guard is thoughtful. The findings below are
refinements, not fundamental flaws.

---

## Status tracker

All findings resolved. P1–P3 merged to `master` via #3, #4, #5.

| Pri | Finding | Location | Status |
|-----|---------|----------|--------|
| 🔴 P1 | Store file lock force-steals non-stale locks (no staleness check; `LOCK_STALE_MS` dead) | `store.ts:45,223-244,253` | ✅ done |
| 🔴 P1 | DST spring-forward logic in `localWallClock` is untested | `schedule.ts:138` / no test | ✅ done |
| 🟡 P2 | `message` action hard-throws if `pi.sendMessage` absent (siblings use `?.`) | `runner.ts:315` | ✅ done |
| 🟡 P2 | Error path records stale `job`, success path uses `fresh` | `runner.ts:578` vs `:541/:504` | ✅ done |
| 🟡 P2 | Spin-wait blocks event loop up to 500 ms | `store.ts:247` | ✅ done |
| 🟡 P2 | Privilege stack couples to host's 1-settle-per-turn invariant (no defensive cap/TTL) | `privilege.ts:101` | ✅ done |
| 🟡 P2 | Cross-session RMW merge + run_now/tick serialization + ledger eviction untested | `test/` | ✅ done |
| 🟢 P3 | `"busy"` RunStatus declared but never written | `types.ts:86` / `runner.ts:486` | ✅ done (removed) |
| 🟢 P3 | `markRan` deprecated-and-only-tested; dead `LOCK_STALE_MS`+`void` | `store.ts:405,253` | ✅ done |
| 🟢 P3 | Global shell job cwd is implicit/session-dependent | `runner.ts:367` | ✅ done (documented) |
| 🟢 P3 | `runs.jsonl` never rotated; doc-only mitigation | `ledger.ts` / docs | ✅ done (doc clarified) |
| 🟢 P3 | `.pi/` gitignored vs "project scope" shareability expectation | `.gitignore` / README | ✅ done (doc clarified) |
| 🟢 P3 | `formatRelative` hours/days boundary jump (47.5h → "2d") | `schedule.ts` | ✅ done (fixed + test) |
| 🏠 | Delete local `bash.exe.stackdump` (untracked clutter) | repo root | ✅ done |

Legend: ⬜ open · 🔄 in progress · ✅ done · ⏭ deferred

---

## 1. Architecture & Separation of Concerns — *Strong*

Clean layering; each module has a single, well-documented job.

| Module | Responsibility | Verdict |
|---|---|---|
| `schedule.ts` | Pure parsing + next-run math | Excellent, fully pure & tested |
| `policy.ts` | Limits, grace, idempotency keys | Clean |
| `store.ts` | Hybrid JSON storage + RMW locking | Solid, see §2 |
| `lock.ts` | Single-flight job locks | Solid, see §2 |
| `ledger.ts` | Append-only forensic trail | Good |
| `privilege.ts` | Structural tier enforcement | Good, see §4 |
| `runner.ts` | Orchestration (622 lines — the heaviest) | Works, see §3/§5 |
| `tool.ts` | Agent-facing API | Good |

**One structural smell:** two independent file-lock implementations do the same
job — `lock.ts` `JobLockManager` (proper timestamp staleness, token-scoped
release, rename-takeover) and `store.ts` `withFileLock` (weaker, see §2). The
store lock is the weaker sibling, which is backwards — store RMW is arguably
*more* safety-critical than job single-flight. They should share a primitive.

---

## 2. Reliability & Concurrency — *Good, with two real gaps*

### 🔴 (P1) Store file lock has no real staleness check
`store.ts` declared `LOCK_STALE_MS = 30_000` then suppressed it with
`void LOCK_STALE_MS;`. The takeover path force-renamed on the *last* retry
regardless of age — so a slow-but-active writer could be robbed after ~500 ms,
**losing concurrent RMW writes** (the exact race the lock exists to prevent).
Contrast with `lock.ts` `JobLockManager`, which correctly gates takeover on
staleness.

**Fix:** read staleness from the lock file's **mtime** (robust across body
formats and legacy locks); only rename-takeover when genuinely stale; write a
structured JSON body with `pid`/`token`/`at`; release with token-match guard.
Drop the dead `void LOCK_STALE_MS`.

> ✅ **Resolved.** `withFileLock` now writes a `{pid,token,at}` body, gates
takeover on `mtime > LOCK_STALE_MS` (via `statSync`), releases only on token
match, and the dead `void LOCK_STALE_MS` is gone. New regression test
(`store-corrupt.test.ts`) proves a **fresh** lock is never stolen (fails loudly
as `StoreError` after retries), and the stale-takeover test now backdates the
lock mtime so it is genuinely stale. Suite 162 → 167, all green.

### 🟡 (P2) Spin-wait burns the event loop
`withFileLock` retries use a busy spin (up to 20 × 25 ms = 500 ms synchronous
full-CPU block). File locks are inherently sync here, but a pure spin is the
worst option. Consider `Atomics.wait` or shorter sleep slices.

> ✅ **Resolved.** `backoff()` now uses `Atomics.wait` on a module-level
> `SharedArrayBuffer`-backed `Int32Array` — a true blocking sleep with no CPU
> spin (allowed on Node's main thread, verified), with a spin fallback if SAB
> is unavailable.

### 🟢 Strengths
- **At-most-once is durable:** primary signal is `job.lastIdempotencyKey` on the
  store row (survives ledger eviction), re-checked *after* lock acquire. Correct
  check-then-act.
- **`run_now` serializes on `waveChain`** — never silently no-ops behind a tick.
- **Ledger `append` never throws; store advances first.** Disk-full can't brick
  scheduling.

---

## 3. Correctness — *Three latent bugs + nits*

### 🟡 (P2) `message` action hard-requires `pi.sendMessage` while siblings degrade
`runner.ts` — inconsistent optional chaining: notify (`sendMessage?.`) and shell
(`sendMessage?.`) degrade gracefully; `message` (`sendMessage(`) throws if
absent → error path. Make consistent or validate `sendMessage` at `attach()`.

> ✅ **Resolved.** The `message` branch now guards `if (pi.sendMessage)` and
> falls back to `console.log(notifyLabel(job))` when the channel is absent —
> matching notify/shell's optional treatment. New test covers the no-channel
> path (still `lastStatus: ok`).

### 🟡 (P2) Error path records stale `job`, success path records `fresh`
`runner.ts` re-reads into `fresh` after lock acquire and uses it on the **ok**
and **post-lock-skip** paths, but the **error catch** and **pre-lock skips**
still pass the original stale `job`. If `tier`/`schedule`/`action` changed
between candidate-read and lock-acquire, the error ledger entry and computed
`nextRunAt` reflect old values.

> ✅ **Resolved.** The error catch now re-reads `errorSubject = store.get(...) ??
> job` inside the lock and derives `errorKey`/tier/missedWindow/action from it,
> so the advance + forensic ledger reflect the freshest job (consistent with
> the success path).

### 🟢 (P3) `JobRun.status = "busy"` is defined but never written
`types.ts` declares `"busy"` and `RELIABILITY.md` documents it, but the over-cap
path returns `null` without recording it. Either record it (rate-limited) or
remove the dead enum value + doc row.

### 🟢 Nits
- `runner.ts` `at` captured once and reused after long async shell delivery →
  `nextRunAt` anchors to fire-*start*. Probably intentional; worth a comment.
- `store.ts` `normalizeJob` does no deep validation of `schedule` shape; a
  hand-edited corrupt schedule yields `NaN` nextRunAt and a silently-bricked job.

---

## 4. Security & Privilege Model — *Strong, one coupling to watch*

### 🟢 The escalation guard is correctly designed
`privilege.ts` blocks `schedule create/cancel/enable/disable/run_now` under
`read_only`/`suggest`, closing the **read_only → shell-job → mutate** escalation
vector. `list`/`history` stay allowed. Shell jobs force `tier=mutate` at create.

### 🟡 (P2) Privilege stack couples to "exactly one `agent_settled` per fired turn"
The stack pops on **every** `agent_settled`, including interactive turns. It
relies on a host invariant (one turn at a time, one settle per fired prompt)
that this code does not enforce. Double-settle → under-enforcement; no-settle →
tier leaks until `session_shutdown.clear()`. Consider a defensive cap + the host
invariant stated in a comment.

> ✅ **Resolved.** `enter()` now caps the stack at `MAX_DEPTH = 16` (drops
> oldest-first) as a safety valve against a host-invariant breach, and the
> `agent_settled` handler comment states the invariant explicitly. New test
> verifies the cap (30 enters → depth 16).

### 🟢 `enter()` is called synchronously after `sendUserMessage`
Single-threaded JS guarantees the tool_call hook can't fire before `enter`
lands. No race.

### 🟡 (P3) Shell `cwd` for global jobs is implicit
A **global** shell job runs in whatever `ctx.cwd` is at fire time. A global job
with a relative command is cwd-dependent and surprising. Document or require
absolute commands for global shell jobs.

---

## 5. Error Handling & Forensics — *Good*

### 🟢 Strengths
- `emitError` is rate-limited (5 min) and keyed — a broken store can't spam.
- `run_now` **never invents success** — reports actual `lastStatus` across the
  full matrix (ok/locked/error/skipped/not_fired/not_found/terminated). Best
  correctness property in the package; has a dedicated test suite.
- Store corrupt → **quarantine, never silent wipe**; recovery without restart.

### 🟡 (P3) `runs.jsonl` grows unbounded
No rotation; `wasDelivered` scans last 200 lines only. A very active system can
age out a `delivered` record (defense-in-depth only — the primary
`lastIdempotencyKey` on the row still holds). Doc-only mitigation today.

---

## 6. Code Quality & Maintainability — *A few cleanups*

### 🟡 Dead / leftover code
- `store.ts` `LOCK_STALE_MS` + `void LOCK_STALE_MS;` — ✅ resolved by P1 fix (the
  constant is now genuinely used as the mtime staleness threshold).
- `store.ts` `markRan` — `@deprecated`, used only by tests. ✅ dropped (P3,
  along with its test).
- `bash.exe.stackdump` (repo root) — local crash artifact, untracked but
  cluttering the working tree. ✅ deleted (P3).

### 🟡 Minor inconsistencies
- `formatRelative` boundary hiccup: `Math.round(47.6h)` → 48 → falls through to
  "2d" while 47.4h → "47h".
- `defaultScope` does a sync `existsSync` — a side effect in a "resolver".
- Fire-cap ordering is implicit (last-in-array deferred, not least-overdue). Fine
  as a storm guard; deserves a comment.

### 🟢 Strengths
- Consistent error-class taxonomy (`StoreError`/`ActionError`/`ScheduleParseError`)
  caught at the tool boundary.
- `noUncheckedIndexedAccess: true` is on and respected.
- Pure helpers cleanly separable and heavily unit-tested.

---

## 7. Testing — *Solid breadth, targeted gaps*

162 tests, 3.3s. The `runner.test.ts` harness (fake pi/ctx + controllable clock)
is excellent and covers the hard guarantees: at-most-once, caps, idle gate,
run_now bypass, missed-window skip, error-advance, lock contention, termination.

### 🔴 Untested but tricky areas (P1-P2)
1. **DST transitions** — `localWallClock` has explicit spring-forward
   walk-forward logic with zero tests. Most likely place for a silent bug.
   ✅ **Resolved** — `schedule.test.ts` now pins `TZ=America/New_York` and
   covers the spring-forward gap (02:30 on 2025-03-09 walks to Mar 10), a
   non-gap time firing same-day, exclusive reschedule, and fall-back (01:30 on
   2025-11-02 resolves without error).
2. **Cross-session RMW merge under contention** — takeover is tested, not that
   two stores doing interleaved `upsert` of *different* jobs never lose writes.
   ✅ **Resolved** — `store.test.ts` now writes two jobs via two `ScheduleStore`
   instances on the same files and asserts both persist (re-read-inside-lock).
3. **`run_now` ↔ active-tick serialization** — `waveChain` chaining untested.
   ✅ **Resolved** — `runner.test.ts` fires two concurrent `run_now` waves and
   asserts both deliver (never drop, unlike auto waves).
4. **Ledger eviction** — no test that `wasDelivered` returns false after a
   delivered key ages out of the 200-line window.
   ✅ **Resolved** — `ledger.test.ts` fills past `MAX_HISTORY` and asserts the
   early `delivered` key ages out while a recent one is still seen.
5. **Privilege ↔ runner end-to-end** — no integration test that a tool_call
   *during* a fired read_only turn is actually blocked.
   ✅ **Resolved** — `runner.test.ts` now attaches the runner, fires a
   read_only job, and drives the captured `tool_call` hook: `bash` is blocked
   (+`terminate`), reads + schedule reads allowed, schedule mutations blocked.
6. **Windows Git-Bash discovery** — untestable on Linux CI by nature; the
   `PI_SCHEDULE_SHELL` override is tested (right tradeoff).

### 🟢 Test-quality notes
- `tool-ratelimit.test.ts` isolates the module-singleton limiter. Good discipline.
- The "never invents success" matrix in `tool.test.ts` is exemplary.
- `store-corrupt.test.ts` covers quarantine + recovery-without-restart.

---

## 8. Build / Release / CI — *Correct, follows owned-packages rules*

Per `AGENTS.md`, `pi-schedule` (`pungggi/pi-schedule`) uses tag-driven OIDC
publishing — and it does:

- ✅ `release.yml`: `id-token: write`, upgrades npm to `@latest`, no empty
  `_authToken`, `--provenance` on public repo, version-sync guard.
- ✅ `prepublishOnly` blocks manual publish.
- ✅ `ci.yml` verifies the packed tarball excludes dev paths and *includes* the
  real payload (`src/extension.ts`, `skills/`, `docs/RELIABILITY.md`).
- ✅ `engines.node >= 22` matches the CI matrix.

### 🟢 Minor
- `release.yml` `workflow_dispatch` with manual `version` bypasses the tag;
  version-sync still runs. Acceptable escape hatch.
- CI is ubuntu/Node-22 only; package is Windows-conscious. Optional: a `tsc`
  job on windows.

---

## 9. Documentation — *Excellent*

`RELIABILITY.md` is the standout — threat-model→mitigation table with research
citations and an honest "does NOT do" + "undocumented-but-important" section.

### 🟡 One design-vs-doc tension
`.gitignore` excludes `.pi/`, so **project-scoped jobs (`.pi/schedule.json`)
are machine-local, never committed**. "Project" scope implies shareable-in-repo,
but these are effectively per-machine. Document explicitly or un-ignore
`.pi/schedule.json` if shareability is desired.

---

## Changelog

- **2026-08-11** — review created; P1 items marked in progress.
- **2026-08-11** — ✅ P1 done. Store file lock now uses mtime staleness (no
  more fresh-lock stealing / lost RMW writes); added fresh-lock regression test.
  DST spring-forward & fall-back now covered by TZ-pinned tests. `LOCK_STALE_MS`
  dead code removed. Suite 162 → 167, typecheck clean. Branch:
  `fix/p1-store-lock-and-dst-tests`.
- **2026-08-11** — ✅ P2 done (branch `fix/p2-review-followups`, stacked on P1).
  `message` action degrades to console when `sendMessage` is absent; error path
  re-reads the fresh job for the advance + ledger; lock `backoff()` now uses
  `Atomics.wait` (no CPU spin); `PrivilegeGuard.enter()` caps stack growth at
  `MAX_DEPTH=16` + documents the host invariant. New tests: ledger eviction,
  privilege cap, message fallback, run_now serialization, privilege↔runner e2e,
  cross-session RMW. Suite 167 → 173, typecheck clean.
- **2026-08-11** — ✅ P3 done (branch `chore/p3-review-polish`, #5). Removed
  dead code (`"busy"` RunStatus, `markRan`); fixed the `formatRelative` hours/days
  boundary jump (47.5h → "2d") with a regression test; documented global shell
  cwd, project-scope machine-locality, and `runs.jsonl` head-truncation safety
  in `RELIABILITY.md`; deleted the local `bash.exe.stackdump`. Suite net 0
  (-1 markRan test, +1 boundary test), typecheck clean.
- **2026-08-12** — Consolidation: all P1–P3 findings resolved and merged to
  `master` (#3, #4, #5). Status tracker fully green; suite 173, typecheck clean.
