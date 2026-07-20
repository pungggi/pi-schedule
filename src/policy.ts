/**
 * Reliability policy: limits, missed-window decisions, privilege defaults.
 *
 * Research basis: docs/RELIABILITY.md
 */

import { computeNextRunAt } from "./schedule.js";
import type {
  DueDecision,
  MissedWindowPolicy,
  PrivilegeTier,
  ScheduleSpec,
  ScheduledJob,
} from "./types.js";

/** Must stay in sync with runner TICK_MS (imported carefully to avoid cycles). */
export const DEFAULT_TICK_MS = 30_000;

/** Hard caps to prevent self-spam and backlog storms. */
export const LIMITS = {
  /** Max jobs visible in one scope file (global or a single project). */
  maxJobsPerScope: 50,
  /** Max automatic fires per session_start wave. */
  maxFiresPerSessionStart: 5,
  /** Max automatic fires per tick wave. */
  maxFiresPerTick: 3,
  /** Soft create rate: max creates per rolling minute (in-process). */
  maxCreatesPerMinute: 10,
} as const;

export const DEFAULT_MISSED_WINDOW: MissedWindowPolicy = "catch_up_one";
export const DEFAULT_TIER: PrivilegeTier = "read_only";

/**
 * Build an idempotency key for a due slot.
 * Same job + same planned nextRunAt ⇒ same key ⇒ at-most-once delivery.
 */
export function idempotencyKeyFor(job: ScheduledJob): string {
  return `${job.id}:${job.nextRunAt}`;
}

/**
 * How late is "still on time" for skip policy.
 *
 * Floor is 2× tick period so a healthy in-session job is not spuriously
 * skipped when the ticker lands just after the due instant.
 * - interval: max(2×tick, 25% of period), capped at 15m
 * - daily: 1 hour
 */
export function graceMsFor(
  job: ScheduledJob,
  tickMs: number = DEFAULT_TICK_MS,
): number {
  const tickFloor = tickMs * 2;
  // interval and once both use a relative period for grace.
  const period =
    job.schedule.type === "interval"
      ? job.schedule.everyMs
      : job.schedule.type === "once"
        ? job.schedule.delayMs
        : null;
  if (period !== null) {
    const pct = Math.floor(period * 0.25);
    return Math.min(Math.max(tickFloor, pct), 15 * 60_000);
  }
  return Math.max(tickFloor, 60 * 60_000);
}

/**
 * Decide whether a due job (nextRunAt <= now) should fire or be skipped.
 *
 * - catch_up_one: always fire once for the overdue/due slot (default)
 * - skip: fire only if still within grace of the planned slot; otherwise
 *   skip the miss and roll nextRunAt forward without delivering
 *
 * Forced run_now bypasses this (caller does not use decideDue).
 */
export function decideDue(
  job: ScheduledJob,
  now: Date,
  tickMs: number = DEFAULT_TICK_MS,
): DueDecision {
  const key = idempotencyKeyFor(job);
  const policy = job.missedWindow ?? DEFAULT_MISSED_WINDOW;
  const planned = new Date(job.nextRunAt).getTime();
  const overdueMs = Math.max(0, now.getTime() - planned);
  const grace = graceMsFor(job, tickMs);

  if (policy === "skip" && overdueMs > grace) {
    return {
      job,
      action: "skip",
      reason: `missed_window_skip (overdue ${Math.round(overdueMs / 60_000)}m > grace)`,
      idempotencyKey: key,
    };
  }

  return {
    job,
    action: "fire",
    reason:
      policy === "catch_up_one" && overdueMs > grace
        ? "catch_up_one"
        : "due",
    idempotencyKey: key,
  };
}

/**
 * After a fire or skip, compute the next run strictly after `at`.
 */
export function nextAfter(schedule: ScheduleSpec, at: Date): Date {
  return computeNextRunAt(schedule, at, { inclusive: false });
}

/** Human label for privilege tier in prompts. */
export function tierContract(tier: PrivilegeTier): string {
  switch (tier) {
    case "read_only":
      return [
        "PRIVILEGE: read_only",
        "- Do NOT modify files, commit, push, open PRs, install packages, or change config.",
        "- Investigate and report only. Prefer read/search/status tools.",
      ].join("\n");
    case "suggest":
      return [
        "PRIVILEGE: suggest",
        "- You may draft patches or proposals, but do NOT apply them, commit, push, or open PRs unless the user explicitly asks in this turn.",
        "- Prefer dry-run / report output.",
      ].join("\n");
    case "mutate":
      return [
        "PRIVILEGE: mutate",
        "- Workspace changes are allowed when necessary for this task.",
        "- Still prefer the smallest safe change; summarize every mutation.",
      ].join("\n");
  }
}

/** In-process sliding window create rate limiter. */
export class CreateRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxPerMinute: number = LIMITS.maxCreatesPerMinute,
  ) {}

  tryTake(nowMs: number = Date.now()): boolean {
    const windowStart = nowMs - 60_000;
    this.timestamps = this.timestamps.filter((t) => t >= windowStart);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(nowMs);
    return true;
  }

  /** Test hook: clear the rolling window. */
  reset(): void {
    this.timestamps = [];
  }
}
