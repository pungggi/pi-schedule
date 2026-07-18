/**
 * Shared types for pi-schedule.
 *
 * Storage is intentionally daemon-ready: a future headless runner can read
 * the same JSON files and fire jobs outside an interactive pi session.
 *
 * Reliability model: see docs/RELIABILITY.md
 */

export type ScheduleScope = "global" | "project";

/** Interval schedule: every N minutes / hours / days. */
export interface IntervalSchedule {
  type: "interval";
  /** Duration in milliseconds. */
  everyMs: number;
  /** Original human string, e.g. "30m", "2h", "1d". */
  every: string;
}

/** Daily wall-clock schedule (local timezone). */
export interface DailySchedule {
  type: "daily";
  /** Hour 0-23 local. */
  hour: number;
  /** Minute 0-59 local. */
  minute: number;
  /** Original human string, e.g. "09:00". */
  at: string;
}

export type ScheduleSpec = IntervalSchedule | DailySchedule;

/**
 * What to do when a job is overdue (nextRunAt far in the past).
 * - catch_up_one: fire once for the miss, then reschedule from now (default)
 * - skip: do not fire; advance nextRunAt to the next future slot
 */
export type MissedWindowPolicy = "catch_up_one" | "skip";

/**
 * Privilege tier for scheduled turns.
 * Enforced two ways: prompt contract + tool_call hook (blocks edit/write/bash
 * for read_only, bash for suggest) while the scheduled turn is active.
 */
export type PrivilegeTier = "read_only" | "suggest" | "mutate";

/** Job-level last-run status (summary on the job row). */
export type JobStatus = "ok" | "error" | "skipped" | "locked" | null;

/** Per-run ledger status (append-only forensic trail). */
export type RunStatus =
  | "delivered"
  | "error"
  | "skipped"
  | "locked"
  | "busy";

export type FireSource = "session_start" | "tick" | "run_now";

export interface ScheduledJob {
  id: string;
  name: string;
  /** Prompt text injected as a user message when the job fires. */
  prompt: string;
  schedule: ScheduleSpec;
  scope: ScheduleScope;
  /**
   * Absolute project root for project-scoped jobs.
   * Undefined for global jobs.
   */
  projectPath?: string;
  enabled: boolean;
  /** Overdue handling. Default catch_up_one. */
  missedWindow: MissedWindowPolicy;
  /** Privilege contract for fired prompts. Default read_only. */
  tier: PrivilegeTier;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of last fire attempt (any status), or null if never. */
  lastRunAt: string | null;
  /** ISO timestamp of next planned fire (daemon-ready). */
  nextRunAt: string;
  runCount: number;
  lastStatus: JobStatus;
  /** Optional last error / skip reason. */
  lastError?: string;
  /** Last idempotency key that was successfully delivered. */
  lastIdempotencyKey?: string;
}

export interface ScheduleStoreFile {
  version: 1;
  jobs: ScheduledJob[];
}

export interface CreateJobInput {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  scope: ScheduleScope;
  projectPath?: string;
  missedWindow?: MissedWindowPolicy;
  tier?: PrivilegeTier;
  /** Optional fixed start; defaults to now → next occurrence. */
  now?: Date;
}

/** Append-only run ledger entry (forensic trail). */
export interface JobRun {
  runId: string;
  jobId: string;
  jobName: string;
  scope: ScheduleScope;
  projectPath?: string;
  /** Stable key for this due slot; prevents double-fire. */
  idempotencyKey: string;
  source: FireSource;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  /** Human reason for skip/lock/error. */
  detail?: string;
  tier: PrivilegeTier;
  missedWindow: MissedWindowPolicy;
}

export interface DueDecision {
  job: ScheduledJob;
  action: "fire" | "skip";
  reason: string;
  idempotencyKey: string;
}
