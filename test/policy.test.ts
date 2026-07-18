import { describe, expect, it } from "vitest";
import {
  CreateRateLimiter,
  DEFAULT_TICK_MS,
  decideDue,
  graceMsFor,
  idempotencyKeyFor,
} from "../src/policy.js";
import { parseSchedule } from "../src/schedule.js";
import type { ScheduledJob } from "../src/types.js";

function job(
  partial: Partial<ScheduledJob> &
    Pick<ScheduledJob, "nextRunAt" | "missedWindow" | "schedule">,
): ScheduledJob {
  return {
    id: "abc",
    name: "t",
    prompt: "p",
    scope: "global",
    enabled: true,
    tier: "read_only",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastStatus: null,
    ...partial,
  };
}

describe("decideDue", () => {
  it("catch_up_one fires when overdue", () => {
    const j = job({
      schedule: parseSchedule("every 1h"),
      missedWindow: "catch_up_one",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    const d = decideDue(j, new Date("2025-01-01T03:00:00.000Z"));
    expect(d.action).toBe("fire");
    expect(d.reason).toBe("catch_up_one");
  });

  it("skip skips when far overdue", () => {
    const j = job({
      schedule: parseSchedule("every 1h"),
      missedWindow: "skip",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    const d = decideDue(j, new Date("2025-01-01T03:00:00.000Z"));
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("missed_window_skip");
  });

  it("skip fires within grace (including tick-floor for short intervals)", () => {
    const j = job({
      schedule: parseSchedule("every 1m"),
      missedWindow: "skip",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    // 30s late: old formula (25% of 1m = 15s) would skip; floor 2×30s tick = 60s → fire
    const d = decideDue(
      j,
      new Date("2025-01-01T00:00:30.000Z"),
      DEFAULT_TICK_MS,
    );
    expect(d.action).toBe("fire");
  });

  it("skip still skips 1m job when overdue beyond tick floor", () => {
    const j = job({
      schedule: parseSchedule("every 1m"),
      missedWindow: "skip",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    // 90s late > 60s floor
    const d = decideDue(
      j,
      new Date("2025-01-01T00:01:30.000Z"),
      DEFAULT_TICK_MS,
    );
    expect(d.action).toBe("skip");
  });
});

describe("idempotencyKeyFor / grace", () => {
  it("keys by job + nextRunAt", () => {
    const j = job({
      id: "x1",
      schedule: parseSchedule("every 1d"),
      missedWindow: "catch_up_one",
      nextRunAt: "2025-06-01T09:00:00.000Z",
    });
    expect(idempotencyKeyFor(j)).toBe("x1:2025-06-01T09:00:00.000Z");
  });

  it("grace floor is 2× tick for short intervals", () => {
    const j = job({
      schedule: parseSchedule("every 1m"),
      missedWindow: "skip",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    expect(graceMsFor(j, 30_000)).toBe(60_000);
  });

  it("grace caps long intervals at 15m", () => {
    const j = job({
      schedule: parseSchedule("every 2h"),
      missedWindow: "skip",
      nextRunAt: "2025-01-01T00:00:00.000Z",
    });
    expect(graceMsFor(j, 30_000)).toBe(15 * 60_000);
  });
});

describe("CreateRateLimiter", () => {
  it("enforces max per minute", () => {
    const lim = new CreateRateLimiter(3);
    const t0 = 1_000_000;
    expect(lim.tryTake(t0)).toBe(true);
    expect(lim.tryTake(t0 + 1)).toBe(true);
    expect(lim.tryTake(t0 + 2)).toBe(true);
    expect(lim.tryTake(t0 + 3)).toBe(false);
    expect(lim.tryTake(t0 + 60_001)).toBe(true);
  });
});
