import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
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
