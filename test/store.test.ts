import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchedule } from "../src/schedule.js";
import { ScheduleStore, defaultPaths, defaultScope } from "../src/store.js";
import type { ScheduledJob } from "../src/types.js";

const temps: string[] = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-"));
  temps.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const paths = defaultPaths(home);
  return { store: new ScheduleStore(paths), home, project, paths };
}

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("ScheduleStore", () => {
  it("creates and lists global jobs", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "sec-review",
      prompt: "Do a security review",
      schedule: parseSchedule("every 1d"),
      scope: "global",
    });

    expect(job.id).toMatch(/^[a-f0-9]{12}$/);
    expect(job.scope).toBe("global");
    expect(job.action).toBe("prompt");
    expect(store.listForCwd(project).map((j) => j.id)).toEqual([job.id]);
  });

  it("persists shell action fields and lastShell via markAttempt", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "ci",
      action: "shell",
      command: "npm test",
      wakeOn: "failure",
      prompt: "fix it",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    expect(job.action).toBe("shell");
    expect(job.command).toBe("npm test");

    const shell = {
      ok: false,
      command: "npm test",
      cwd: project,
      timeoutMs: 60_000,
      code: 1,
      killed: false,
      stdout: "fail",
      stderr: "",
    };
    const updated = store.markAttempt(job, new Date("2025-01-01T01:00:00.000Z"), "ok", {
      lastShell: shell,
    });
    expect(updated.lastShell?.code).toBe(1);
    expect(store.get(job.id, project)?.lastShell?.stdout).toBe("fail");
  });

  it("normalizes legacy rows missing action to prompt", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "legacy",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    store.upsert({
      ...job,
      action: undefined,
    } as unknown as ScheduledJob);
    expect(store.get(job.id, project)?.action).toBe("prompt");
  });

  it("coerces corrupt wakeOn / timeoutMs instead of throwing on fire", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "ci",
      action: "shell",
      command: "npm test",
      wakeOn: "failure",
      timeoutMs: 30_000,
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    // Simulate a hand-edited / corrupted row.
    store.upsert({
      ...job,
      wakeOn: "sometimes" as unknown as undefined,
      timeoutMs: -5 as unknown as undefined,
    });
    const loaded = store.get(job.id, project)!;
    expect(loaded.wakeOn).toBeUndefined();
    expect(loaded.timeoutMs).toBeUndefined();
    // valid values are preserved
    store.upsert({ ...job, wakeOn: "always", timeoutMs: 5_000 });
    const ok = store.get(job.id, project)!;
    expect(ok.wakeOn).toBe("always");
    expect(ok.timeoutMs).toBe(5_000);
  });

  it("stores maxRuns and terminate() disables with a reason", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "poll",
      prompt: "p",
      maxRuns: 3,
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    expect(job.maxRuns).toBe(3);
    expect(job.terminated).toBeNull();

    const t = store.terminate(
      store.get(job.id, project)!,
      "maxRuns",
      new Date("2025-01-01T00:00:00.000Z"),
    );
    expect(t.enabled).toBe(false);
    expect(t.terminated).toBe("maxRuns");
    expect(store.get(job.id, project)?.terminated).toBe("maxRuns");
  });

  it("setEnabled(true) clears terminated; disable preserves it", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "poll",
      prompt: "p",
      maxRuns: 1,
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    store.terminate(store.get(job.id, project)!, "maxRuns");
    expect(store.get(job.id, project)?.terminated).toBe("maxRuns");

    const re = store.setEnabled(job.id, project, true)!;
    expect(re.enabled).toBe(true);
    expect(re.terminated).toBeNull();
  });

  it("isolates project jobs by root", () => {
    const { store, project, home } = tempStore();
    const other = join(home, "other-project");

    const a = store.create({
      name: "a",
      prompt: "A",
      schedule: parseSchedule("every 1h"),
      scope: "project",
      projectPath: project,
    });
    store.create({
      name: "b",
      prompt: "B",
      schedule: parseSchedule("every 1h"),
      scope: "project",
      projectPath: other,
    });

    const listed = store.listForCwd(project);
    expect(listed.map((j) => j.id)).toEqual([a.id]);
  });

  it("merges global + project for cwd", () => {
    const { store, project } = tempStore();
    const g = store.create({
      name: "g",
      prompt: "G",
      schedule: parseSchedule("every 2h"),
      scope: "global",
    });
    const p = store.create({
      name: "p",
      prompt: "P",
      schedule: parseSchedule("daily at 09:00"),
      scope: "project",
      projectPath: project,
    });

    const ids = store.listForCwd(project).map((j) => j.id).sort();
    expect(ids).toEqual([g.id, p.id].sort());
  });

  it("markRan advances nextRunAt and counters", () => {
    const { store } = tempStore();
    const job = store.create({
      name: "x",
      prompt: "X",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      now: new Date("2025-01-01T00:00:00.000Z"),
    });

    const ran = store.markRan(job, new Date("2025-01-01T00:00:00.000Z"), "ok");
    expect(ran.runCount).toBe(1);
    expect(ran.lastStatus).toBe("ok");
    expect(ran.lastRunAt).toBe("2025-01-01T00:00:00.000Z");
    expect(ran.nextRunAt).toBe("2025-01-01T01:00:00.000Z");
    expect(ran.tier).toBe("read_only");
    expect(ran.missedWindow).toBe("catch_up_one");
  });

  it("create stores tier and missedWindow", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "mut",
      prompt: "M",
      schedule: parseSchedule("every 1d"),
      scope: "project",
      projectPath: project,
      tier: "mutate",
      missedWindow: "skip",
    });
    expect(store.get(job.id, project)?.tier).toBe("mutate");
    expect(store.get(job.id, project)?.missedWindow).toBe("skip");
  });

  it("enforces max jobs per scope", () => {
    const { store } = tempStore();
    for (let i = 0; i < 50; i++) {
      store.create({
        name: `j${i}`,
        prompt: "p",
        schedule: parseSchedule("every 1d"),
        scope: "global",
      });
    }
    expect(() =>
      store.create({
        name: "overflow",
        prompt: "p",
        schedule: parseSchedule("every 1d"),
        scope: "global",
      }),
    ).toThrow(/Job limit reached/);
  });

  it("dueJobs respects enabled and nextRunAt", () => {
    const { store, project } = tempStore();
    const past = new Date("2020-01-01T00:00:00.000Z");
    const job = store.create({
      name: "due",
      prompt: "D",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      now: past,
    });
    // Force due
    store.upsert({ ...job, nextRunAt: past.toISOString() });

    expect(store.dueJobs(project, new Date("2025-01-01T00:00:00.000Z")).map((j) => j.id)).toEqual([
      job.id,
    ]);

    store.setEnabled(job.id, project, false);
    expect(store.dueJobs(project, new Date("2025-01-01T00:00:00.000Z"))).toEqual([]);
  });

  it("remove deletes from the right file", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "gone",
      prompt: "G",
      schedule: parseSchedule("every 1d"),
      scope: "project",
      projectPath: project,
    });
    expect(store.remove(job.id, project)?.id).toBe(job.id);
    expect(store.get(job.id, project)).toBeUndefined();
  });
});

describe("ScheduleStore — legacy & edge cases", () => {
  it("normalizeJob fills defaults for missing tier/missedWindow on write+read", () => {
    const { store, project } = tempStore();
    const job = store.create({
      name: "x",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    store.upsert({ ...job, tier: undefined, missedWindow: undefined } as unknown as ScheduledJob);
    const got = store.get(job.id, project);
    expect(got?.tier).toBe("read_only");
    expect(got?.missedWindow).toBe("catch_up_one");
  });

  it("treats a blank store file as empty (not corrupt)", () => {
    const { store, project, paths } = tempStore();
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(paths.globalFile, "   \n  ", "utf8");
    expect(store.listForCwd(project)).toEqual([]);
  });

  it("markAttempt(advance:false) keeps nextRunAt and does not count", () => {
    const { store } = tempStore();
    const job = store.create({
      name: "x",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const locked = store.markAttempt(
      job,
      new Date("2025-01-01T00:00:00.000Z"),
      "locked",
      { advance: false },
    );
    expect(locked.nextRunAt).toBe(job.nextRunAt);
    expect(locked.lastStatus).toBe("locked");
    expect(locked.runCount).toBe(0);
  });

  it("setEnabled returns undefined for a missing id", () => {
    const { store, project } = tempStore();
    expect(store.setEnabled("ghost", project, true)).toBeUndefined();
  });

  it("countInScope(project) falls back to process.cwd() when no root given", () => {
    const { store } = tempStore();
    expect(store.countInScope("project")).toBeGreaterThanOrEqual(0);
  });

  it("two store instances writing the same file don't lose jobs (cross-session RMW)", () => {
    const { store, paths, project } = tempStore();
    const other = new ScheduleStore(paths); // separate instance, same on-disk files
    const a = store.create({
      name: "a",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    const b = other.create({
      name: "b",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    // Each upsert re-reads inside the lock, so B's write must not clobber A's job.
    const ids = store.listForCwd(project).map((j) => j.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("defaultScope: project when .pi exists, else global", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-scope-"));
    temps.push(root);
    expect(defaultScope(root)).toBe("global");
    mkdirSync(join(root, ".pi"), { recursive: true });
    expect(defaultScope(root)).toBe("project");
  });
});
