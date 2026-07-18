import { describe, expect, it } from "vitest";
import { buildFirePrompt } from "../src/prompt.js";
import { parseSchedule } from "../src/schedule.js";
import type { ScheduledJob } from "../src/types.js";

const base: ScheduledJob = {
  id: "deadbeefcafe",
  name: "security-review",
  prompt: "Review recent changes for security issues.",
  schedule: parseSchedule("daily at 09:00"),
  scope: "project",
  projectPath: "/repo",
  enabled: true,
  missedWindow: "catch_up_one",
  tier: "read_only",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  lastRunAt: null,
  nextRunAt: "2025-01-02T08:00:00.000Z",
  runCount: 0,
  lastStatus: null,
};

describe("buildFirePrompt", () => {
  it("includes isolation contract and privilege", () => {
    const text = buildFirePrompt({
      job: base,
      runId: "run1",
      source: "session_start",
    });
    expect(text).toContain("[scheduled-task]");
    expect(text).toContain("runId: run1");
    expect(text).toContain("jobId: deadbeefcafe");
    expect(text).toContain("## Task");
    expect(text).toContain("Review recent changes");
    expect(text).toContain("PRIVILEGE: read_only");
    expect(text).toContain("do NOT invent findings");
    expect(text).toContain("No findings");
  });

  it("labels force-run source", () => {
    const text = buildFirePrompt({
      job: { ...base, tier: "mutate" },
      runId: "r2",
      source: "run_now",
      forced: true,
    });
    expect(text).toContain("source: force-run");
    expect(text).toContain("PRIVILEGE: mutate");
  });
});
