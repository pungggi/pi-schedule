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

/** One-shot schedule: fire once after a relative delay, then terminate. */
export interface OnceSchedule {
  type: "once";
  /** Delay in milliseconds. */
  delayMs: number;
  /** Original human string, e.g. "10m", "30s". */
  delay: string;
}

export type ScheduleSpec = IntervalSchedule | DailySchedule | OnceSchedule;

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
 *
 * Shell jobs force tier=mutate (command runs outside the agent tool path).
 */
export type PrivilegeTier = "read_only" | "suggest" | "mutate";

/**
 * What fires when a job is due.
 * - prompt: inject isolated agent task (default, original behavior)
 * - shell: run command via pi.exec; optionally wake agent on result
 * - notify: UI/console reminder only (no agent turn)
 * - message: session custom message (display only, no agent turn)
 */
export type JobAction = "prompt" | "shell" | "notify" | "message";

/**
 * When a shell job should wake the agent with a follow-up prompt.
 * Defaults: always if any follow-up text is set, else never.
 */
export type WakeOn = "always" | "failure" | "success" | "never";

/** Why a job stopped firing (terminal state). */
export type TerminatedReason = "maxRuns" | "once";

/** Job-level last-run status (summary on the job row). */
export type JobStatus = "ok" | "error" | "skipped" | "locked" | null;

/** Per-run ledger status (append-only forensic trail). */
export type RunStatus =
  | "delivered"
  | "error"
  | "skipped"
  | "locked";

export type FireSource = "session_start" | "tick" | "run_now";

/** Captured result of a scheduled shell execution (truncated). */
export interface ShellRunResult {
  ok: boolean;
  command: string;
  cwd: string;
  timeoutMs: number;
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

export interface ScheduledJob {
  id: string;
  name: string;
  /**
   * Payload text:
   * - prompt: agent task body
   * - notify / message: reminder/message body
   * - shell: optional default follow-up instruction when waking
   */
  prompt: string;
  /** What fires. Default "prompt" (legacy rows omit this). */
  action: JobAction;
  /** Shell only: command passed to `bash -lc`. */
  command?: string;
  /** Shell only: when to inject an agent follow-up. */
  wakeOn?: WakeOn;
  /** Shell only: follow-up when exit 0 and not killed. */
  successPrompt?: string;
  /** Shell only: follow-up when non-zero exit or killed. */
  failurePrompt?: string;
  /** Shell only: exec timeout in ms. */
  timeoutMs?: number;
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
  /** Privilege contract for agent-waking fires. Default read_only. */
  tier: PrivilegeTier;
  /** Max successful/errored deliveries before auto-disable (terminal). */
  maxRuns?: number;
  /** Terminal state; set when a once job fires or maxRuns is reached. */
  terminated?: TerminatedReason | null;
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
  /** Last shell result (shell jobs only; truncated). */
  lastShell?: ShellRunResult;
}

export interface ScheduleStoreFile {
  version: 1;
  jobs: ScheduledJob[];
}

export interface CreateJobInput {
  name: string;
  /** Required for prompt/notify/message; optional follow-up for shell. */
  prompt?: string;
  action?: JobAction;
  command?: string;
  wakeOn?: WakeOn;
  successPrompt?: string;
  failurePrompt?: string;
  timeoutMs?: number;
  schedule: ScheduleSpec;
  scope: ScheduleScope;
  projectPath?: string;
  missedWindow?: MissedWindowPolicy;
  tier?: PrivilegeTier;
  maxRuns?: number;
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
  /** Human reason for skip/lock/error / shell summary. */
  detail?: string;
  tier: PrivilegeTier;
  missedWindow: MissedWindowPolicy;
  /** Job action that fired (prompt/shell/…). */
  action?: JobAction;
}

export interface DueDecision {
  job: ScheduledJob;
  action: "fire" | "skip";
  reason: string;
  idempotencyKey: string;
}
