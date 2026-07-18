import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchedule } from "../src/schedule.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";

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
    expect(store.listForCwd(project).map((j) => j.id)).toEqual([job.id]);
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
