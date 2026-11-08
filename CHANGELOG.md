# Changelog

All notable changes to `pi-schedule`. Versions are tag-driven: pushing `vX.Y.Z` triggers CI to publish with OIDC + provenance (see `docs/PUBLISHING.md`). Date format: YYYY-MM-DD.

## 0.6.1 - 2026-11-08

### Changed

- **CHANGELOG.md now ships in the npm tarball** — `files` previously excluded it, so pi ≥ 1.5.0's "Extension Updates" feature (which reads `CHANGELOG.md` from the installed package after an update) stayed silently off. Why: this package has kept a full changelog since 0.3.0, but none of it was ever installed for users to see. With this release pi records its version baseline; from the next release onward, release notes appear in the pi launcher under "Extension Updates".

## 0.6.0 - 2026-11-06

### Added

- **Anchored intervals**: `every="2h at 09:00"` (keyword `from` accepted) pins interval ticks to a wall-clock phase instead of counting from creation. First run is the *next* anchored tick, even when less than one full interval away.
  - Why: plain `every` phases were an accident of creation time. A job made at 10:37 with `every="2h"` fired 12:37, 14:37 … with no way to choose the grid.
  - **Guarantees**: next tick is always strictly after the current one and at most one interval away, including across DST days (phase can shift ~1h on those; `dailyAt` remains the DST-exact option for daily times).
  - **No new tool param**: the anchor rides inside the `every` string. Stored jobs stay compatible (`anchor` is optional).
- 10 new tests: parse forms and rejections, phase math (including a 5h interval that does not divide 24h), midnight rollover, exact-tick behavior, DST invariants, store round-trip. 275 total.

## 0.5.0 - 2026-10-19

### Fixed

- **Turn-scoped privilege fence**: arms at the fire prompt's `message_start` (runId-matched against this session's delivery registry) instead of at delivery time. A mid-turn `run_now` no longer blocks or terminates the calling interactive turn's bash/edit/write.
- **Single-slot fence keyed by runId**: replaces the per-delivery stack. pi emits one `agent_settled` per agent run, so the old stack leaked N-1 tiers per multi-fire wave and pinned `read_only` session-wide.
- **Completion accounting**: an agent-run settle appends a `status=ok` ledger row under the same runId; `history` collapses per runId so runs visibly flip `delivered → ok`.

## 0.4.0 - 2026-09-08

Security-hardening drop from the deep review (`docs/SECURITY-REVIEW.md`, all findings resolved).

### Security

- **P1 trust gate**: project-scope jobs auto-fire only in trusted projects (#11).
- **P2 fire-prompt sanitization**: fences against ANSI/C1 escapes in untrusted text (#12).
- **P2 strict read_only allowlist**: scheduled read_only turns get a fixed tool set; peer messaging blocked (#13).
- **P3 create-time warnings** for shell/mutate jobs, on every available channel (#14).
- **P3 secret redaction** in persisted shell output, plus `runs.jsonl` rotation (#15).

### Fixed

- **P3 robustness**: corrupt-row quarantine, length caps, `run_now` cwd drift, `notifyLabel` escapes (#16).

## 0.3.6 - 2026-08-21

### Fixed

- **Compaction probe-send**: the first send attempt doubles as the probe. While compaction runs, parking is event-paced (500ms poll) and a real send retries every 5s: a cancelled compaction never emits an end event, so only a probe can discover it. Bound stays 120s, then the normal delivery-error path (#9).

## 0.3.5 - 2026-08-21

### Fixed

- **Compaction wait**: scheduled wakes wait out context compaction instead of crashing (#8).
- **Store lock staleness**: mtime-based detection + DST tests (review P1) (#3), runner/store/privilege follow-ups (P2) (#4), P3 polish (#5).

## 0.3.4 - 2026-08-11

### Changed

- **Privilege blocks terminate the turn** (`terminate: true`, pi >= 0.84.1): an off-contract read_only/suggest scheduled turn that hits a mutating tool ends without a wasted follow-up model call. Degrades gracefully to plain blocks on older pi (#2).

## 0.3.3 - 2026-08-10

### Fixed

- **Windows shell jobs**: resolve Git Bash (MSYS) explicitly. Bare `bash` could resolve to the WSL launcher, which exits non-zero without executing, so shell jobs silently never fired. `PI_SCHEDULE_SHELL` overrides the binary (#1).
- CI: `actions/checkout` and `actions/setup-node` bumped to v7 (Node 24 runtime).

## 0.3.2 - 2026-08-03

### Changed

- **Skill invocation broadened** to polling/watch/monitor intent ("check every N minutes", "keep an eye on", …).

## 0.3.1 - 2026-07-27

### Changed

- **OIDC trusted-publisher pipeline** verified end-to-end: npm >= 11.5.1, no empty `_authToken` written.

## 0.3.0 - 2026-07-20

First npm release, tag-driven via CI with provenance.

### Added

- **Initial extension**: schedules (`every`, `dailyAt`, `once`), job kinds (prompt / shell / notify / message), `maxRuns`, privilege tiers with tool-call enforcement, append-only run ledger, file locks, missed-window policies, and the `schedule` skill.
