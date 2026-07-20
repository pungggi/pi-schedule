import { describe, expect, it } from "vitest";
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
});
