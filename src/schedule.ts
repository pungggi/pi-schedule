/**
 * Schedule parsing and next-run calculation.
 *
 * Supported forms:
 *   every 30m | every 2h | every 1d | 30m | 2h | 1d
 *   daily at 09:00 | daily 09:00 | at 09:00
 */

import type { DailySchedule, IntervalSchedule, ScheduleSpec } from "./types.js";

const MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export class ScheduleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleParseError";
  }
}

/**
 * Parse a human schedule string into a ScheduleSpec.
 * Accepts either `every` style or `daily at` style.
 */
export function parseSchedule(input: string): ScheduleSpec {
  const raw = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) {
    throw new ScheduleParseError("Empty schedule string");
  }

  const daily = tryParseDaily(raw);
  if (daily) return daily;

  const interval = tryParseInterval(raw);
  if (interval) return interval;

  throw new ScheduleParseError(
    `Unrecognized schedule "${input}". Use e.g. "every 30m", "every 2h", "every 1d", or "daily at 09:00".`,
  );
}

/**
 * Build a ScheduleSpec from separate tool params (every XOR dailyAt).
 */
export function scheduleFromParts(parts: {
  every?: string;
  dailyAt?: string;
}): ScheduleSpec {
  const hasEvery = Boolean(parts.every?.trim());
  const hasDaily = Boolean(parts.dailyAt?.trim());

  if (hasEvery === hasDaily) {
    throw new ScheduleParseError(
      'Provide exactly one of "every" (e.g. "30m") or "dailyAt" (e.g. "09:00").',
    );
  }

  if (hasEvery) {
    return parseSchedule(`every ${parts.every!.trim()}`);
  }
  return parseSchedule(`daily at ${parts.dailyAt!.trim()}`);
}

function tryParseDaily(raw: string): DailySchedule | null {
  // daily at 09:00 | daily 09:00 | at 09:00 | 09:00
  const m =
    raw.match(/^(?:daily\s+(?:at\s+)?)?(\d{1,2}):(\d{2})$/) ??
    raw.match(/^at\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ScheduleParseError(`Invalid hour in "${raw}" (expected 0-23)`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ScheduleParseError(`Invalid minute in "${raw}" (expected 0-59)`);
  }

  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { type: "daily", hour, minute, at };
}

function tryParseInterval(raw: string): IntervalSchedule | null {
  // every 30m | 30m | every 2 h | 1d
  const m = raw.match(/^(?:every\s+)?(\d+)\s*([mhd])$/);
  if (!m) return null;

  const n = Number(m[1]);
  const unit = m[2] as keyof typeof MS;
  if (!Number.isInteger(n) || n < 1) {
    throw new ScheduleParseError(`Interval must be a positive integer: "${raw}"`);
  }

  const everyMs = n * MS[unit];
  // Guard absurdly small / large
  if (everyMs < 60_000) {
    throw new ScheduleParseError("Minimum interval is 1m");
  }
  if (everyMs > 90 * MS.d) {
    throw new ScheduleParseError("Maximum interval is 90d");
  }

  return { type: "interval", everyMs, every: `${n}${unit}` };
}

/**
 * Compute the next run time strictly after `from` (or at/after `from` when
 * `inclusive` is true — used for first scheduling of a brand-new job).
 *
 * Interval: from + everyMs (or now if never run and inclusive).
 * Daily: next local occurrence of hour:minute at or after `from`.
 */
export function computeNextRunAt(
  schedule: ScheduleSpec,
  from: Date,
  options: { inclusive?: boolean } = {},
): Date {
  const inclusive = options.inclusive ?? false;

  if (schedule.type === "interval") {
    if (inclusive) return new Date(from.getTime());
    return new Date(from.getTime() + schedule.everyMs);
  }

  return nextDailyOccurrence(schedule, from, inclusive);
}

function nextDailyOccurrence(
  schedule: DailySchedule,
  from: Date,
  inclusive: boolean,
): Date {
  const candidate = localWallClock(from, schedule.hour, schedule.minute);

  if (inclusive) {
    if (candidate.getTime() >= from.getTime()) return candidate;
  } else {
    if (candidate.getTime() > from.getTime()) return candidate;
  }

  // Already passed today → tomorrow (still DST-safe).
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localWallClock(tomorrow, schedule.hour, schedule.minute);
}

/**
 * Build a local Date for hour:minute on the calendar day of `base`.
 * Spring-forward gap (e.g. 02:30 on a DST start day): setHours may land on a
 * different hour — advance day-by-day until wall-clock matches.
 * Fall-back ambiguity: platform picks one of the two 01:xx instants.
 */
function localWallClock(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setSeconds(0, 0);
  d.setHours(hour, minute, 0, 0);

  // Nonexistent local time (spring forward): walk forward until hour sticks.
  let guard = 0;
  while ((d.getHours() !== hour || d.getMinutes() !== minute) && guard < 48) {
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    guard += 1;
  }
  return d;
}

/** True when nextRunAt is at or before now. */
export function isDue(nextRunAt: string, now: Date = new Date()): boolean {
  return new Date(nextRunAt).getTime() <= now.getTime();
}

/** Human-readable schedule summary. */
export function formatSchedule(schedule: ScheduleSpec): string {
  if (schedule.type === "interval") return `every ${schedule.every}`;
  return `daily at ${schedule.at}`;
}

/** Format a relative duration for status text. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const delta = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(delta);
  const sign = delta < 0 ? "ago" : "in";

  if (abs < 60_000) return delta < 0 ? "just now" : "in <1m";

  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${sign === "ago" ? "" : "in "}${minutes}m${sign === "ago" ? " ago" : ""}`;

  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${sign === "ago" ? "" : "in "}${hours}h${sign === "ago" ? " ago" : ""}`;

  const days = Math.round(abs / 86_400_000);
  return `${sign === "ago" ? "" : "in "}${days}d${sign === "ago" ? " ago" : ""}`;
}
