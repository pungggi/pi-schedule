/**
 * `schedule` tool — the agent-facing API.
 *
 * Covers action validation, list/cancel/enable/disable, history, and the
 * run_now status matrix (ok / locked / error / skipped / not_found / not_fired)
 * which is the "never invents success" reliability contract.
 *
 * Note: create rate-limiting is unit-tested at the policy level
 * (CreateRateLimiter in policy.test.ts); it is not re-tested here because the
 * limiter is a module singleton whose 60s window would pollute sibling tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunLedger, buildRun } from "../src/ledger.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import { parseSchedule } from "../src/schedule.js";
import { _resetCreateLimiterForTests, registerScheduleTool } from "../src/tool.js";
import type { ScheduleRunner } from "../src/runner.js";
import type { ScheduledJob } from "../src/types.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

beforeEach(() => {
  _resetCreateLimiterForTests();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-sched-tool-"));
  temps.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const paths = defaultPaths(home);

  const store = new ScheduleStore(paths);
  const ledger = new RunLedger(paths.runsFile);

  // Configurable stub runner: fireDue returns whatever run_nowResult holds.
  let runNowResult: ScheduledJob[] = [];
  const runner = {
    fireDue: async () => runNowResult,
  } as unknown as ScheduleRunner;

  let tool: {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: unknown,
      onUpdate: unknown,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  } | null = null;
  const pi = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
  } as unknown as ExtensionAPI;

  registerScheduleTool(pi, store, runner, ledger);

  const exec = (params: Record<string, unknown>) =>
    tool!.execute("t1", params, undefined, undefined, { cwd: project });

  /** Create a job then overwrite fields (lastStatus etc.) for status tests. */
  const seed = (
    over: Partial<ScheduledJob> = {},
  ): ScheduledJob => {
    const created = store.create({
      name: over.name ?? "job",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    const merged = { ...store.get(created.id, project)!, ...over };
    store.upsert(merged);
    return store.get(created.id, project)!;
  };

  return {
    project,
    store,
    ledger,
    exec,
    seed,
    setRunNowResult: (r: ScheduledJob[]) => {
      runNowResult = r;
    },
  };
}

type S = ReturnType<typeof setup>;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? "";

describe("schedule tool — create", () => {
  it("requires name and prompt (for kind=prompt)", async () => {
    const { exec } = setup();
    expect(text(await exec({ action: "create" }) as any)).toContain(
      '"name" is required',
    );
    expect(
      text(await exec({ action: "create", name: "x" }) as any),
    ).toContain('requires "prompt"');
  });

  it("rejects both/neither of every and dailyAt", async () => {
    const { exec } = setup();
    expect(
      text(
        await exec({
          action: "create",
          name: "x",
          prompt: "p",
          every: "1h",
          dailyAt: "08:00",
        }) as any,
      ),
    ).toContain("Error");
    expect(
      text(
        await exec({ action: "create", name: "x", prompt: "p" }) as any,
      ),
    ).toContain("Error");
  });

  it("creates a job and reports the id", async () => {
    const { exec, store, project } = setup();
    const r = await exec({
      action: "create",
      name: "review",
      prompt: "review stuff",
      every: "1d",
      tier: "read_only",
    });
    expect(text(r as any)).toContain("Created job");
    const jobs = store.listForCwd(project);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("review");
    expect(jobs[0]?.tier).toBe("read_only");
    expect(jobs[0]?.action).toBe("prompt");
  });

  it("creates a shell job (forces tier=mutate)", async () => {
    const { exec, store, project } = setup();
    const r = await exec({
      action: "create",
      name: "ci",
      kind: "shell",
      command: "npm test",
      wakeOn: "failure",
      failurePrompt: "fix the failing tests",
      every: "30m",
      tier: "read_only", // ignored — shell forces mutate
    });
    expect(text(r as any)).toContain("kind=shell");
    expect(text(r as any)).toContain("tier=mutate");
    const job = store.listForCwd(project)[0]!;
    expect(job.action).toBe("shell");
    expect(job.command).toBe("npm test");
    expect(job.wakeOn).toBe("failure");
    expect(job.tier).toBe("mutate");
    expect(job.failurePrompt).toBe("fix the failing tests");
  });

  it("creates notify without agent payload quirks", async () => {
    const { exec, store, project } = setup();
    await exec({
      action: "create",
      name: "stretch",
      kind: "notify",
      prompt: "stand up",
      every: "1h",
    });
    const job = store.listForCwd(project)[0]!;
    expect(job.action).toBe("notify");
    expect(job.prompt).toBe("stand up");
  });

  it("creates a one-shot job (once) and a maxRuns-bounded job", async () => {
    const { exec, store, project } = setup();
    const a = await exec({
      action: "create",
      name: "reminder",
      kind: "notify",
      prompt: "stretch",
      once: "5m",
    });
    expect(text(a as any)).toContain("once in 5m");
    const onceJob = store.listForCwd(project)[0]!;
    expect(onceJob.schedule.type).toBe("once");
    expect(onceJob.terminated).toBeNull();

    const b = await exec({
      action: "create",
      name: "poll",
      kind: "shell",
      command: "npm test",
      wakeOn: "never",
      every: "5m",
      maxRuns: 10,
    });
    expect(text(b as any)).toContain("Created job");
    const pollJob = store
      .listForCwd(project)
      .find((j) => j.name === "poll")!;
    expect(pollJob.maxRuns).toBe(10);
  });

  it("rejects maxRuns that is not a positive integer", async () => {
    const { exec } = setup();
    expect(
      text(
        await exec({
          action: "create",
          name: "x",
          prompt: "p",
          every: "1h",
          maxRuns: 0,
        }) as any,
      ),
    ).toContain("maxRuns");
  });

  it("rejects shell without command", async () => {
    const { exec } = setup();
    expect(
      text(
        await exec({
          action: "create",
          name: "ci",
          kind: "shell",
          every: "1h",
        }) as any,
      ),
    ).toContain("command");
  });
});

describe("schedule tool — list / cancel / enable / disable", () => {
  it("lists empty vs populated", async () => {
    const s = setup();
    expect(text(await s.exec({ action: "list" }) as any)).toContain(
      "No scheduled jobs",
    );
    const j = s.seed();
    const r = await s.exec({ action: "list" });
    expect(text(r as any)).toContain("Scheduled jobs:");
    expect(text(r as any)).toContain(j.id);
    expect(text(r as any)).toContain(j.name);
  });

  it("cancel requires id, reports not found, then succeeds", async () => {
    const s = setup();
    expect(text(await s.exec({ action: "cancel" }) as any)).toContain(
      '"id" is required',
    );
    expect(
      text(await s.exec({ action: "cancel", id: "missing" }) as any),
    ).toContain("not found");
    const j = s.seed();
    expect(
      text(await s.exec({ action: "cancel", id: j.id }) as any),
    ).toContain("Cancelled");
    expect(s.store.listForCwd(s.project)).toHaveLength(0);
  });

  it("enable/disable toggles state", async () => {
    const s = setup();
    const j = s.seed();
    expect(j.enabled).toBe(true);
    await s.exec({ action: "disable", id: j.id });
    expect(s.store.get(j.id, s.project)?.enabled).toBe(false);
    await s.exec({ action: "enable", id: j.id });
    expect(s.store.get(j.id, s.project)?.enabled).toBe(true);
    expect(
      text(await s.exec({ action: "disable" }) as any),
    ).toContain('"id" is required');
  });
});

describe("schedule tool — history", () => {
  it("reports empty history and then rows", async () => {
    const s = setup();
    expect(text(await s.exec({ action: "history" }) as any)).toContain(
      "No run history",
    );
    const j = s.seed();
    s.ledger.append(
      buildRun({
        jobId: j.id,
        jobName: j.name,
        scope: "global",
        idempotencyKey: "k1",
        source: "session_start",
        status: "delivered",
        startedAt: "2025-01-01T00:00:00.000Z",
        endedAt: "2025-01-01T00:00:01.000Z",
        tier: "read_only",
        missedWindow: "catch_up_one",
      }),
    );
    const r = await s.exec({ action: "history", id: j.id });
    expect(text(r as any)).toContain("Run history");
    expect(text(r as any)).toContain("delivered");
  });
});

describe("schedule tool — run_now status matrix (never invents success)", () => {
  it("not_found when the id is missing", async () => {
    const { exec } = setup();
    expect(
      text(await exec({ action: "run_now", id: "ghost" }) as any),
    ).toContain("not found");
  });

  it("ok → Delivered", async () => {
    const s: S = setup();
    const j = s.seed({ lastStatus: "ok", lastIdempotencyKey: "k", tier: "mutate" });
    s.setRunNowResult([j]);
    expect(text(await s.exec({ action: "run_now", id: j.id }) as any)).toContain(
      "Delivered",
    );
  });

  it("locked → reports locked, not delivered", async () => {
    const s = setup();
    const j = s.seed({ lastStatus: "locked" });
    s.setRunNowResult([j]);
    const out = text(await s.exec({ action: "run_now", id: j.id }) as any);
    expect(out).toContain("locked");
    expect(out).not.toContain("Delivered");
  });

  it("error → reports failure with detail", async () => {
    const s = setup();
    const j = s.seed({ lastStatus: "error", lastError: "disk full" });
    s.setRunNowResult([j]);
    const out = text(await s.exec({ action: "run_now", id: j.id }) as any);
    expect(out).toContain("Failed to deliver");
    expect(out).toContain("disk full");
  });

  it("skipped → reports skipped", async () => {
    const s = setup();
    const j = s.seed({ lastStatus: "skipped", lastError: "policy" });
    s.setRunNowResult([j]);
    expect(text(await s.exec({ action: "run_now", id: j.id }) as any)).toContain(
      "skipped",
    );
  });

  it("not_fired when the runner returns no result", async () => {
    const s = setup();
    const j = s.seed(); // exists, but runner returns []
    s.setRunNowResult([]);
    const out = text(await s.exec({ action: "run_now", id: j.id }) as any);
    expect(out).toContain("Did not fire");
  });

  it("refuses to run_now a terminated job", async () => {
    const s = setup();
    const j = s.seed({ terminated: "once", enabled: false });
    const out = text(await s.exec({ action: "run_now", id: j.id }) as any);
    expect(out).toContain("terminated");
    expect(out).toContain("recreate");
  });
});

describe("schedule tool — error wrapping", () => {
  it("wraps a bad schedule as a tool error, not a throw", async () => {
    const { exec } = setup();
    const out = text(
      await exec({
        action: "create",
        name: "x",
        prompt: "p",
        every: "5x",
      }) as any,
    );
    expect(out).toContain("Error");
    // never reaches the success path
    expect(out).not.toContain("Created job");
  });
});

describe("schedule tool — list formatting", () => {
  it("summarizes off-state, last run, last status, and truncates long prompts", async () => {
    const s = setup();
    s.seed({
      name: "big",
      enabled: false,
      lastStatus: "ok",
      lastRunAt: "2025-01-01T00:00:00.000Z",
      prompt: "x".repeat(200),
    });
    const out = text(await s.exec({ action: "list" }) as any);
    expect(out).toContain("[off/"); // enabled=false → state off
    expect(out).toContain("lastStatus: ok");
    expect(out).toContain("…"); // prompt truncated
  });
});

describe("schedule tool — misc branches", () => {
  it("reports an unknown action", async () => {
    const { exec } = setup();
    expect(text(await exec({ action: "bogus" }) as any)).toContain(
      "Unknown action",
    );
  });

  it("create applies defaults when tier/scope/missedWindow are omitted", async () => {
    const { exec, store, project } = setup();
    await exec({ action: "create", name: "d", prompt: "p", every: "1h" });
    const j = store.listForCwd(project)[0]!;
    expect(j.tier).toBe("read_only");
    expect(j.missedWindow).toBe("catch_up_one");
    expect(j.scope).toBe("global"); // temp project has no .pi → defaultScope = global
  });

  it("run_now requires an id", async () => {
    const { exec } = setup();
    expect(text(await exec({ action: "run_now" }) as any)).toContain(
      '"id" is required',
    );
  });

  it("run_now reports an unrecognized status via the default branch", async () => {
    const s = setup();
    const j = s.seed({ lastStatus: null });
    s.setRunNowResult([j]);
    expect(
      text(await s.exec({ action: "run_now", id: j.id }) as any),
    ).toContain("ended with status=");
  });

  it("run_now error falls back to 'unknown error' when lastError is missing", async () => {
    const s = setup();
    const j = s.seed({ lastStatus: "error", lastError: undefined });
    s.setRunNowResult([j]);
    expect(
      text(await s.exec({ action: "run_now", id: j.id }) as any),
    ).toContain("unknown error");
  });

  it("history clamps a large limit and defaults when omitted", async () => {
    const s = setup();
    const j = s.seed();
    for (let i = 0; i < 5; i++) {
      s.ledger.append(
        buildRun({
          jobId: j.id,
          jobName: j.name,
          scope: "global",
          idempotencyKey: `k${i}`,
          source: "tick",
          status: "delivered",
          startedAt: "2025-01-01T00:00:00.000Z",
          endedAt: "2025-01-01T00:00:01.000Z",
          tier: "read_only",
          missedWindow: "catch_up_one",
        }),
      );
    }
    expect(
      text(await s.exec({ action: "history", id: j.id, limit: 100 }) as any),
    ).toContain("Run history"); // limit>50 → Math.min(100,50)
    expect(
      text(await s.exec({ action: "history", id: j.id }) as any),
    ).toContain("Run history"); // no limit → default 10
  });
});

describe("schedule tool — not_found branches", () => {
  it("enable / disable report not_found for a missing id", async () => {
    const s = setup();
    expect(
      text(await s.exec({ action: "enable", id: "ghost" }) as any),
    ).toContain("not found");
    expect(
      text(await s.exec({ action: "disable", id: "ghost" }) as any),
    ).toContain("not found");
  });
});
