import { describe, expect, it } from "vitest";
import { buildFirePrompt, buildShellFollowUpPrompt } from "../src/prompt.js";
import { parseSchedule } from "../src/schedule.js";
import type { ScheduledJob, ShellRunResult } from "../src/types.js";

const base: ScheduledJob = {
  id: "deadbeefcafe",
  name: "security-review",
  prompt: "Review recent changes for security issues.",
  action: "prompt",
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

  it("defaults a missing tier to read_only", () => {
    const text = buildFirePrompt({
      job: { ...base, tier: undefined } as unknown as ScheduledJob,
      runId: "r3",
      source: "session_start",
    });
    expect(text).toContain("PRIVILEGE: read_only");
  });

  it("includes action kind", () => {
    const text = buildFirePrompt({
      job: base,
      runId: "r4",
      source: "tick",
    });
    expect(text).toContain("action: prompt");
  });
});

describe("buildShellFollowUpPrompt", () => {
  const result: ShellRunResult = {
    ok: false,
    command: "npm test",
    cwd: "/repo",
    timeoutMs: 60_000,
    code: 1,
    killed: false,
    stdout: "FAIL auth",
    stderr: "",
  };

  it("embeds command output and instruction", () => {
    const text = buildShellFollowUpPrompt({
      job: {
        ...base,
        action: "shell",
        command: "npm test",
        tier: "mutate",
      },
      runId: "rs1",
      source: "tick",
      result,
      instruction: "Fix the failing tests.",
    });
    expect(text).toContain("action: shell");
    expect(text).toContain("shellStatus: failure");
    expect(text).toContain("npm test");
    expect(text).toContain("FAIL auth");
    expect(text).toContain("Fix the failing tests.");
    expect(text).toContain("PRIVILEGE: mutate");
  });
});
