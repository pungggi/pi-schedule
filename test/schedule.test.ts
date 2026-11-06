import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  formatRelative,
  formatSchedule,
  isDue,
  parseSchedule,
  ScheduleParseError,
  scheduleFromParts,
} from "../src/schedule.js";

describe("parseSchedule", () => {
  it("parses interval forms", () => {
    expect(parseSchedule("every 30m")).toEqual({
      type: "interval",
      everyMs: 30 * 60_000,
      every: "30m",
    });
    expect(parseSchedule("2h")).toEqual({
      type: "interval",
      everyMs: 2 * 3_600_000,
      every: "2h",
    });
    expect(parseSchedule("every 1d")).toEqual({
      type: "interval",
      everyMs: 86_400_000,
      every: "1d",
    });
  });

  it("parses daily forms", () => {
    expect(parseSchedule("daily at 09:00")).toEqual({
      type: "daily",
      hour: 9,
      minute: 0,
      at: "09:00",
    });
    expect(parseSchedule("at 17:30")).toEqual({
      type: "daily",
      hour: 17,
      minute: 30,
      at: "17:30",
    });
    expect(parseSchedule("9:05")).toEqual({
      type: "daily",
      hour: 9,
      minute: 5,
      at: "09:05",
    });
  });

  it("rejects bad input", () => {
    expect(() => parseSchedule("")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("every 0m")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("every 30s")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("daily at 25:00")).toThrow(ScheduleParseError);
  });
});

describe("scheduleFromParts", () => {
  it("accepts exactly one of every / dailyAt", () => {
    expect(scheduleFromParts({ every: "1h" }).type).toBe("interval");
    expect(scheduleFromParts({ dailyAt: "08:00" }).type).toBe("daily");
    expect(() => scheduleFromParts({})).toThrow(ScheduleParseError);
    expect(() => scheduleFromParts({ every: "1h", dailyAt: "08:00" })).toThrow(
      ScheduleParseError,
    );
  });

  it("accepts once (xor with every/dailyAt)", () => {
    expect(scheduleFromParts({ once: "10m" })).toEqual({
      type: "once",
      delayMs: 10 * 60_000,
      delay: "10m",
    });
    expect(scheduleFromParts({ once: "30s" }).type).toBe("once");
    expect(() => scheduleFromParts({ every: "1h", once: "10m" })).toThrow(
      ScheduleParseError,
    );
    expect(() => scheduleFromParts({ dailyAt: "08:00", once: "10m" })).toThrow(
      ScheduleParseError,
    );
  });
});

describe("computeNextRunAt", () => {
  it("advances intervals", () => {
    const from = new Date("2025-01-01T12:00:00.000Z");
    const schedule = parseSchedule("every 2h");
    const next = computeNextRunAt(schedule, from);
    expect(next.toISOString()).toBe("2025-01-01T14:00:00.000Z");
  });

  it("picks next daily occurrence in local time", () => {
    // Use a local Date constructed via components to avoid TZ surprises.
    const from = new Date(2025, 0, 1, 10, 0, 0, 0); // Jan 1 10:00 local
    const schedule = parseSchedule("daily at 09:00");
    const next = computeNextRunAt(schedule, from, { inclusive: true });
    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(2); // tomorrow, since 09:00 already passed
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("keeps today's daily time when still upcoming", () => {
    const from = new Date(2025, 0, 1, 8, 0, 0, 0);
    const schedule = parseSchedule("daily at 09:00");
    const next = computeNextRunAt(schedule, from, { inclusive: true });
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(9);
  });
});

describe("isDue / formatSchedule", () => {
  it("detects due jobs", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isDue(past)).toBe(true);
    expect(isDue(future)).toBe(false);
  });

  it("formats schedules", () => {
    expect(formatSchedule(parseSchedule("every 30m"))).toBe("every 30m");
    expect(formatSchedule(parseSchedule("daily at 09:00"))).toBe("daily at 09:00");
  });
});

describe("parseSchedule — once", () => {
  it("parses in/once forms with s/m/h/d", () => {
    expect(parseSchedule("in 10m")).toEqual({
      type: "once",
      delayMs: 10 * 60_000,
      delay: "10m",
    });
    expect(parseSchedule("once 30s")).toEqual({
      type: "once",
      delayMs: 30_000,
      delay: "30s",
    });
    expect(parseSchedule("in 2h")).toEqual({ type: "once", delayMs: 2 * 3_600_000, delay: "2h" });
    expect(parseSchedule("in 1d")).toEqual({ type: "once", delayMs: 86_400_000, delay: "1d" });
  });

  it("rejects over-max once delays", () => {
    expect(() => parseSchedule("in 91d")).toThrow(/Maximum once delay/);
  });

  it("formats once schedules", () => {
    expect(formatSchedule(parseSchedule("in 10m"))).toBe("once in 10m");
  });

  it("computeNextRunAt advances once by delay", () => {
    const from = new Date("2025-01-01T12:00:00.000Z");
    const next = computeNextRunAt(parseSchedule("in 10m"), from);
    expect(next.toISOString()).toBe("2025-01-01T12:10:00.000Z");
  });
});

describe("parseSchedule — boundaries", () => {
  it("rejects minute > 59", () => {
    expect(() => parseSchedule("daily at 09:60")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("09:99")).toThrow(ScheduleParseError);
  });

  it("rejects intervals over the 90d maximum", () => {
    expect(() => parseSchedule("every 91d")).toThrow(/Maximum interval/);
  });

  it("rejects non-positive / non-integer once delays", () => {
    expect(() => parseSchedule("in 0m")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("in -5s")).toThrow(ScheduleParseError);
  });
});

describe("computeNextRunAt — daily, inclusive defaults to false", () => {
  it("returns today's later time when exclusive and still upcoming", () => {
    const from = new Date(2025, 0, 1, 8, 0, 0, 0); // 08:00 local
    const next = computeNextRunAt(parseSchedule("daily at 09:00"), from);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(9);
  });
});

describe("formatRelative", () => {
  const now = new Date("2025-01-01T12:00:00.000Z");

  it("covers just-now / in-<1m, minutes, hours, days, future and past", () => {
    expect(formatRelative("2025-01-01T12:00:30.000Z", now)).toBe("in <1m");
    expect(formatRelative("2025-01-01T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2025-01-01T12:05:00.000Z", now)).toBe("in 5m");
    expect(formatRelative("2025-01-01T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelative("2025-01-01T15:00:00.000Z", now)).toBe("in 3h");
    expect(formatRelative("2025-01-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelative("2025-01-03T12:00:00.000Z", now)).toBe("in 2d");
    expect(formatRelative("2024-12-30T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("hours/days boundary does not jump (47.5h → 48h, not 2d)", () => {
    // Regression: round(47.5h)=48 used to trip the <48 check and show "2d"
    // while 47.4h showed "47h". The threshold is now keyed on raw abs.
    const almost48h = new Date(now.getTime() + 47.5 * 3_600_000).toISOString();
    expect(formatRelative(almost48h, now)).toBe("in 48h");
    const justUnder48 = new Date(now.getTime() + 47.4 * 3_600_000).toISOString();
    expect(formatRelative(justUnder48, now)).toBe("in 47h");
    const at48h = new Date(now.getTime() + 48 * 3_600_000).toISOString();
    expect(formatRelative(at48h, now)).toBe("in 2d");
  });
});

// DST edge cases for the daily wall-clock path (localWallClock is private, so
// we drive it through the public computeNextRunAt). Node 22 honors a runtime
// process.env.TZ change, so we pin the worker to America/New_York per test and
// restore after. Vitest isolates test files into separate workers, so this
// never leaks into other files.
describe("computeNextRunAt — DST (America/New_York)", () => {
  const origTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  beforeEach(() => {
    process.env.TZ = "America/New_York";
  });
  afterEach(() => {
    process.env.TZ = origTz;
  });

  it("spring-forward gap: daily at 02:30 walks to the next valid day (Mar 9 → Mar 10, 2025)", () => {
    // US Eastern springs forward 2025-03-09 02:00 → 03:00, so 02:30 does not exist.
    const from = new Date(2025, 2, 9, 0, 0, 0, 0); // Mar 9 00:00 local
    const next = computeNextRunAt(parseSchedule("daily at 02:30"), from, {
      inclusive: true,
    });
    // 02:30 on Mar 9 is nonexistent → localWallClock guard walks forward to Mar 10.
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(2);
    expect(next.getMinutes()).toBe(30);
  });

  it("spring-forward day: a time outside the gap (09:00) still fires same day", () => {
    const from = new Date(2025, 2, 9, 0, 0, 0, 0);
    const next = computeNextRunAt(parseSchedule("daily at 09:00"), from, {
      inclusive: true,
    });
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(9); // not skipped — 09:00 is not in the gap
    expect(next.getHours()).toBe(9);
  });

  it("spring-forward gap with exclusive reschedule (after-fire): next valid day", () => {
    // A job that just fired around Mar 9; the next 02:30 is Mar 10 (gap day skipped).
    const from = new Date(2025, 2, 9, 0, 0, 0, 0);
    const next = computeNextRunAt(parseSchedule("daily at 02:30"), from);
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(2);
  });

  it("fall-back: daily at 01:30 on Nov 2 2025 resolves without error (01:30 exists twice)", () => {
    // US Eastern falls back 2025-11-02 02:00 → 01:00, so 01:30 occurs twice.
    // The platform picks one of the two instants; we only assert the wall clock
    // and that the result is a finite, same-day time (no NaN, no infinite loop).
    const from = new Date(2025, 10, 2, 0, 0, 0, 0); // Nov 2 00:00 local
    const next = computeNextRunAt(parseSchedule("daily at 01:30"), from, {
      inclusive: true,
    });
    expect(Number.isFinite(next.getTime())).toBe(true);
    expect(next.getMonth()).toBe(10);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(1);
    expect(next.getMinutes()).toBe(30);
  });
});

describe("anchored intervals (every N at HH:MM)", () => {
  it("parses anchored forms (at / from, 1-2 digit hour)", () => {
    expect(parseSchedule("every 2h at 09:00")).toEqual({
      type: "interval",
      everyMs: 2 * 3_600_000,
      every: "2h",
      anchor: { hour: 9, minute: 0, at: "09:00" },
    });
    expect(parseSchedule("30m from 9:05")).toEqual({
      type: "interval",
      everyMs: 30 * 60_000,
      every: "30m",
      anchor: { hour: 9, minute: 5, at: "09:05" },
    });
    expect(parseSchedule("every 1h at 00:00")).toEqual({
      type: "interval",
      everyMs: 3_600_000,
      every: "1h",
      anchor: { hour: 0, minute: 0, at: "00:00" },
    });
    // Plain intervals stay anchor-free.
    expect(parseSchedule("every 2h")).toEqual({
      type: "interval",
      everyMs: 2 * 3_600_000,
      every: "2h",
    });
  });

  it("rejects invalid anchors", () => {
    expect(() => parseSchedule("every 2h at 24:00")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("every 2h at 09:60")).toThrow(ScheduleParseError);
    expect(() => parseSchedule("every 2h at 9")).toThrow(ScheduleParseError);
  });

  it("scheduleFromParts passes the anchored every string through", () => {
    expect(scheduleFromParts({ every: "2h at 09:00" })).toEqual(
      parseSchedule("every 2h at 09:00"),
    );
  });

  it("aligns the first run to the next tick, not creation + N", () => {
    const from = new Date(2025, 0, 1, 10, 37, 0, 0); // 10:37 local
    const next = computeNextRunAt(parseSchedule("every 2h at 09:00"), from);
    expect(next.getHours()).toBe(11); // not 12:37
    expect(next.getMinutes()).toBe(0);
  });

  it("before the anchor on the same day: first tick is the anchor itself", () => {
    const from = new Date(2025, 0, 1, 7, 0, 0, 0); // 07:00 local
    const next = computeNextRunAt(parseSchedule("every 2h at 09:00"), from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(1);
  });

  it("exclusive advance from an exact tick lands on the following tick", () => {
    const at = new Date(2025, 0, 1, 11, 0, 0, 0); // exactly on 11:00 tick
    const exclusive = computeNextRunAt(parseSchedule("every 2h at 09:00"), at);
    expect(exclusive.getHours()).toBe(13);
    // Inclusive (first scheduling of a new job exactly on a tick) keeps the tick.
    const inclusive = computeNextRunAt(parseSchedule("every 2h at 09:00"), at, {
      inclusive: true,
    });
    expect(inclusive.getTime()).toBe(at.getTime());
  });

  it("continues the arithmetic sequence across midnight", () => {
    const schedule = parseSchedule("every 2h at 09:00");
    const at = new Date(2025, 0, 1, 23, 0, 0, 0); // fired the 23:00 tick
    const next = computeNextRunAt(schedule, at);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(1);
    expect(next.getMinutes()).toBe(0);
  });

  it("keeps phase for intervals that do not divide 24h (5h)", () => {
    const schedule = parseSchedule("every 5h at 09:00");
    // 09:00 → 14:00 → 19:00 → 00:00 (next day) → 04:00 → 09:00
    const at19 = new Date(2025, 0, 1, 19, 0, 0, 0);
    const midnight = computeNextRunAt(schedule, at19);
    expect(midnight.getDate()).toBe(2);
    expect(midnight.getHours()).toBe(0);
    const atMidnight = new Date(2025, 0, 2, 0, 0, 0, 0);
    const four = computeNextRunAt(schedule, atMidnight);
    expect(four.getHours()).toBe(4);
    const atFour = new Date(2025, 0, 2, 4, 0, 0, 0);
    const nine = computeNextRunAt(schedule, atFour);
    expect(nine.getHours()).toBe(9);
  });

  it("never schedules further than one interval ahead", () => {
    const schedule = parseSchedule("every 2h at 09:00");
    for (let m = 0; m <= 24 * 60; m += 7) {
      const from = new Date(2025, 0, 1, 0, m, 0, 0);
      const next = computeNextRunAt(schedule, from);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
      expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(
        2 * 3_600_000,
      );
    }
  });

  it("formats anchored intervals", () => {
    expect(formatSchedule(parseSchedule("every 2h at 09:00"))).toBe(
      "every 2h at 09:00",
    );
    expect(formatSchedule(parseSchedule("every 2h"))).toBe("every 2h");
  });
});

describe("anchored intervals across DST (local tz)", () => {
  it("keeps the next > at and gap <= everyMs invariants on DST boundary days", () => {
    // Europe/Zurich: 2025-03-30 and 2025-10-26 are the shift days.
    // Run in any tz: the invariants must hold regardless of whether the day
    // is 23h, 24h, or 25h long.
    const schedule = parseSchedule("every 3h at 07:15");
    for (const day of [new Date(2025, 2, 30), new Date(2025, 9, 26)]) {
      let at = new Date(day);
      at.setHours(0, 0, 0, 0);
      const end = at.getTime() + 2 * 86_400_000;
      while (at.getTime() < end) {
        const next = computeNextRunAt(schedule, at);
        expect(next.getTime()).toBeGreaterThan(at.getTime());
        expect(next.getTime() - at.getTime()).toBeLessThanOrEqual(3 * 3_600_000);
        at = next;
      }
    }
  });
});
