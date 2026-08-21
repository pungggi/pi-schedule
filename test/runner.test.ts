/**
 * ScheduleRunner integration — the orchestration core.
 *
 * Drives the real store + ledger + locks + privilege with a fake pi/ctx and a
 * controllable clock. Covers the reliability guarantees that were previously
 * unverified: at-most-once delivery, fire caps, idle gate, run_now bypass,
 * missed-window skip, error advance, lock contention, and startup-skip.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { RunLedger } from "../src/ledger.js";
import { JobLockManager } from "../src/lock.js";
import { PrivilegeGuard } from "../src/privilege.js";
import {
  ScheduleRunner,
  isCompactionBusyError,
  resolveShell,
} from "../src/runner.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import { parseSchedule } from "../src/schedule.js";
import type { PrivilegeTier, ScheduledJob } from "../src/types.js";

const T0 = "2025-01-01T00:00:00.000Z";
const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

interface HarnessOpts {
  idle?: boolean;
  sendThrows?: boolean;
  /** First N sendUserMessage calls throw pi's compaction-busy error. */
  sendCompactionBusyTimes?: number;
  hasInitialPrompt?: boolean;
  hasUI?: boolean;
  noSendMessage?: boolean;
  execResult?: { stdout?: string; stderr?: string; code?: number; killed?: boolean };
  execThrows?: boolean;
  compactionWaitMs?: number;
}

function makeHarness(opts: HarnessOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-sched-runner-"));
  temps.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const paths = defaultPaths(home);

  const store = new ScheduleStore(paths);
  const ledger = new RunLedger(paths.runsFile);
  const locks = new JobLockManager(paths.lockDir);
  const privilege = new PrivilegeGuard();

  let clock = new Date(T0);
  let idle = opts.idle ?? true;
  let compactionBusyLeft = opts.sendCompactionBusyTimes ?? 0;
  const sent: { content: string; deliverAs?: string }[] = [];
  const customMessages: Array<{ content: string; triggerTurn?: boolean }> = [];
  const notifies: string[] = [];
  const execCalls: Array<{ command: string; args: string[]; cwd?: string; timeout?: number }> =
    [];
  const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> =
    {};

  const pi = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void {
      (handlers[event] ??= []).push(handler);
    },
    sendUserMessage(
      content: string,
      o?: { deliverAs?: "steer" | "followUp" },
    ): void {
      if (opts.sendThrows) throw new Error("boom");
      if (compactionBusyLeft > 0) {
        compactionBusyLeft -= 1;
        throw new Error(
          "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
        );
      }
      sent.push({ content, deliverAs: o?.deliverAs });
    },
    sendMessage: opts.noSendMessage
      ? undefined
      : (
          message: { content: string },
          o?: { triggerTurn?: boolean },
        ): void => {
          customMessages.push({
            content: message.content,
            triggerTurn: o?.triggerTurn,
          });
        },
    async exec(
      command: string,
      args: string[],
      o?: { cwd?: string; timeout?: number },
    ) {
      execCalls.push({
        command,
        args,
        cwd: o?.cwd,
        timeout: o?.timeout,
      });
      if (opts.execThrows) throw new Error("exec boom");
      const r = opts.execResult ?? {};
      return {
        stdout: r.stdout ?? "ok\n",
        stderr: r.stderr ?? "",
        code: r.code ?? 0,
        killed: r.killed ?? false,
      };
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: project,
    hasUI: opts.hasUI ?? true,
    isIdle: () => idle,
    ui: { notify: (m: string) => notifies.push(m) },
  } as unknown as ExtensionContext;

  const runner = new ScheduleRunner({
    store,
    pi,
    ledger,
    locks,
    privilege,
    hasInitialPrompt: () => opts.hasInitialPrompt === true,
    now: () => clock,
    tickMs: 1_000,
    compactionWaitMs: opts.compactionWaitMs ?? 5_000,
    compactionPollMs: 5,
  });

  const createGlobal = (
    name = "job",
    tier: PrivilegeTier = "read_only",
    missedWindow: ScheduledJob["missedWindow"] = "catch_up_one",
  ): ScheduledJob =>
    store.create({
      name,
      prompt: "do the thing",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      tier,
      missedWindow,
    });

  return {
    root,
    project,
    store,
    ledger,
    privilege,
    runner,
    ctx,
    pi,
    sent,
    customMessages,
    notifies,
    execCalls,
    lockDir: paths.lockDir,
    createGlobal,
    setClock: (d: Date) => {
      clock = d;
    },
    setIdle: (b: boolean) => {
      idle = b;
    },
    forceDue: (id: string, when = T0) => {
      const j = store.get(id, project);
      if (j) store.upsert({ ...j, nextRunAt: when });
    },
    emit: async (event: string, e?: unknown) => {
      for (const h of handlers[event] ?? []) await h(e, ctx);
    },
    toolCall: async (
      toolName: string,
      input?: unknown,
    ): Promise<
      { block?: boolean; reason?: string; terminate?: boolean } | undefined
    > => {
      for (const fn of handlers["tool_call"] ?? []) {
        const r = await (
          fn as (
            e: unknown,
            c: unknown,
          ) => Promise<
            | { block?: boolean; reason?: string; terminate?: boolean }
            | undefined
          >
        )({ toolName, input }, ctx);
        if (r) return r;
      }
      return undefined;
    },
  };
}

type H = ReturnType<typeof makeHarness>;

describe("ScheduleRunner — delivery", () => {
  it("fires a due job once: message + privilege.enter + advance + ledger", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("[scheduled-task]");
    expect(h.sent[0]?.content).toContain("PRIVILEGE: read_only");
    // privilege entered for the turn; not yet settled
    expect(h.privilege.depth()).toBe(1);

    const after = h.store.get(job.id, h.project)!;
    expect(after.runCount).toBe(1);
    expect(after.lastStatus).toBe("ok");
    expect(after.lastIdempotencyKey).toBe(`${job.id}:${T0}`);
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(
      new Date(T0).getTime(),
    );
    expect(
      h.ledger.history({}).some((r) => r.status === "delivered"),
    ).toBe(true);
  });

  it("does not double-fire the same slot (at-most-once via lastIdempotencyKey)", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);

    // Simulate a race: nextRunAt not yet advanced for a second wave.
    h.forceDue(job.id); // same slot again
    await h.runner.fireDue(h.ctx, { source: "tick" });

    expect(h.sent).toHaveLength(1); // no second delivery
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("skipped");
    expect(after.runCount).toBe(1); // skip does not increment
  });

  it("run_now bypasses idempotency (unique force key, always attempts)", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [job.id] });
    await h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [job.id] });

    expect(h.sent).toHaveLength(2);
  });
});

describe("ScheduleRunner — caps & gating", () => {
  it("caps session_start fires at maxFiresPerSessionStart; over-cap jobs stay due", async () => {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const j = h.createGlobal(`j${i}`);
      h.forceDue(j.id);
      ids.push(j.id);
    }

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(5); // LIMITS.maxFiresPerSessionStart

    let fired = 0;
    let untouched = 0;
    for (const id of ids) {
      const j = h.store.get(id, h.project)!;
      if (j.runCount === 1 && j.lastStatus === "ok") fired += 1;
      else if (j.runCount === 0 && j.lastStatus === null) untouched += 1;
    }
    expect(fired).toBe(5);
    expect(untouched).toBe(2); // not advanced, no ledger spam
  });

  it("tick wave is a no-op while the agent is busy (not idle)", async () => {
    const h = makeHarness({ idle: false });
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.sent).toHaveLength(0);

    h.setIdle(true);
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("ScheduleRunner — policies & failure", () => {
  it("skip policy advances without firing or counting when overdue beyond grace", async () => {
    const h = makeHarness();
    h.setClock(new Date("2025-01-01T02:00:00.000Z"));
    const job = h.store.create({
      name: "skip",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      tier: "read_only",
      missedWindow: "skip",
    });
    h.store.upsert({ ...job, nextRunAt: T0 }); // 2h overdue (> 15m grace)

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("skipped");
    expect(after.runCount).toBe(0);
    expect(after.nextRunAt).not.toBe(T0); // advanced forward
  });

  it("delivery error still advances nextRunAt (no hot-loop) and counts", async () => {
    const h = makeHarness({ sendThrows: true });
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0); // threw before recording
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom");
    expect(after.runCount).toBe(1); // error counts
    expect(after.nextRunAt).not.toBe(T0); // advanced
    expect(h.notifies.some((m) => m.includes("failed to fire"))).toBe(true);
    expect(
      h.ledger.history({}).some((r) => r.status === "error"),
    ).toBe(true);
  });

  it("lock contention: no fire, no advance; release → fires", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    const contender = new JobLockManager(h.lockDir);
    const handle = contender.tryAcquire(job.id);
    expect(handle).not.toBeNull();

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(0);
    const mid = h.store.get(job.id, h.project)!;
    expect(mid.lastStatus).toBeNull();
    expect(mid.runCount).toBe(0);

    handle!.release();
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("ScheduleRunner — attach (session lifecycle)", () => {
  it("startup + CLI initial prompt skips firing; /new still fires", async () => {
    // startup WITH initial prompt → skip
    const a = makeHarness({ hasInitialPrompt: true });
    const ja = a.createGlobal();
    a.forceDue(ja.id);
    a.runner.attach();
    await a.emit("session_start", { type: "session_start", reason: "startup" });
    expect(a.sent).toHaveLength(0);
    await a.emit("session_shutdown");

    // /new WITH initial prompt → still fires (argv inherited, but /new is a fresh start)
    const b = makeHarness({ hasInitialPrompt: true });
    const jb = b.createGlobal();
    b.forceDue(jb.id);
    b.runner.attach();
    await b.emit("session_start", { type: "session_start", reason: "new" });
    expect(b.sent).toHaveLength(1);
    await b.emit("session_shutdown");

    // startup WITHOUT initial prompt → fires
    const c = makeHarness({ hasInitialPrompt: false });
    const jc = c.createGlobal();
    c.forceDue(jc.id);
    c.runner.attach();
    await c.emit("session_start", { type: "session_start", reason: "startup" });
    expect(c.sent).toHaveLength(1);
    await c.emit("session_shutdown");
  });
});

describe("ScheduleRunner — construction & wave edges", () => {
  it("uses default collaborators when ledger/locks/privilege/now/tickMs are omitted", async () => {
    const h = makeHarness();
    const minimal = new ScheduleRunner({ store: h.store, pi: h.pi });
    // no due jobs → exercises the default now()/store path; returns []
    await expect(
      minimal.fireDue(h.ctx, { source: "session_start" }),
    ).resolves.toEqual([]);
  });

  it("drops an auto wave that arrives while another auto wave is active", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);
    const first = h.runner.fireDue(h.ctx, { source: "session_start" });
    const dropped = await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(dropped).toEqual([]);
    await first;
    expect(h.sent).toHaveLength(1); // the first wave still delivered
  });

  it("auto-wave swallows a store error and notifies (never throws)", async () => {
    const h = makeHarness();
    mkdirSync(h.store.pathsInfo().globalDir, { recursive: true });
    writeFileSync(h.store.pathsInfo().globalFile, "{bad json", "utf8");
    await expect(
      h.runner.fireDue(h.ctx, { source: "session_start" }),
    ).resolves.toEqual([]);
    expect(h.notifies.some((m) => m.includes("store error"))).toBe(true);
  });

  it("delivers as followUp when the agent is busy (not idle)", async () => {
    const h = makeHarness({ idle: false });
    const job = h.createGlobal();
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.deliverAs).toBe("followUp");
  });

  it("logs to console.error on delivery failure when hasUI is false", async () => {
    const h = makeHarness({ sendThrows: true, hasUI: false });
    const job = h.createGlobal();
    h.forceDue(job.id);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(spy).toHaveBeenCalled();
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("error");
    spy.mockRestore();
  });
});

describe("ScheduleRunner — action kinds", () => {
  it("notify: UI only, no agent turn, no privilege", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "stretch",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    expect(h.notifies.some((m) => m.includes("stretch") && m.includes("stand up"))).toBe(
      true,
    );
    expect(h.customMessages.some((m) => m.triggerTurn === false)).toBe(true);
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("ok");
  });

  it("message: session note without agent turn", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "note",
      prompt: "context for later",
      action: "message",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    expect(h.customMessages.some((m) => m.content.includes("context for later"))).toBe(
      true,
    );
  });

  it("shell: runs command, no wake when wakeOn=never", async () => {
    const h = makeHarness({
      execResult: { stdout: "green\n", code: 0 },
    });
    const job = h.store.create({
      name: "ci",
      prompt: "",
      action: "shell",
      command: "glab ci view",
      wakeOn: "never",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0]?.command).toBe(resolveShell());
    expect(h.execCalls[0]?.args).toEqual(["-lc", "glab ci view"]);
    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.lastShell?.code).toBe(0);
    expect(after.lastShell?.stdout).toContain("green");
  });

  it("shell: honors PI_SCHEDULE_SHELL override for the shell binary", async () => {
    const prev = process.env["PI_SCHEDULE_SHELL"];
    process.env["PI_SCHEDULE_SHELL"] = "/custom/bin/bash";
    try {
      const h = makeHarness({ execResult: { stdout: "ok\n", code: 0 } });
      const job = h.store.create({
        name: "ci",
        prompt: "",
        action: "shell",
        command: "echo hi",
        wakeOn: "never",
        tier: "mutate",
        schedule: parseSchedule("every 1h"),
        scope: "global",
      });
      h.forceDue(job.id);
      await h.runner.fireDue(h.ctx, { source: "session_start" });
      expect(h.execCalls[0]?.command).toBe("/custom/bin/bash");
    } finally {
      if (prev === undefined) delete process.env["PI_SCHEDULE_SHELL"];
      else process.env["PI_SCHEDULE_SHELL"] = prev;
    }
  });

  it("shell: wakes agent on failure when wakeOn=failure", async () => {
    const h = makeHarness({
      execResult: { stdout: "",
        stderr: "boom", code: 2 },
    });
    const job = h.store.create({
      name: "ci",
      prompt: "Inspect the pipeline failure.",
      action: "shell",
      command: "false",
      wakeOn: "failure",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("action: shell");
    expect(h.sent[0]?.content).toContain("shellStatus: failure");
    expect(h.sent[0]?.content).toContain("Inspect the pipeline failure");
    expect(h.sent[0]?.content).toContain("exitCode: 2");
    expect(h.privilege.depth()).toBe(1);
  });

  it("shell: does not wake on success when wakeOn=failure", async () => {
    const h = makeHarness({ execResult: { code: 0 } });
    const job = h.store.create({
      name: "ci",
      prompt: "should not fire",
      action: "shell",
      command: "true",
      wakeOn: "failure",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
  });

  it("shell: records error when exec throws", async () => {
    const h = makeHarness({ execThrows: true });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "true",
      wakeOn: "never",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("error");
    expect(h.store.get(job.id, h.project)?.lastError).toContain("exec boom");
  });

  it("shell wakeOn=success wakes the agent on green", async () => {
    const h = makeHarness({ execResult: { code: 0, stdout: "ok" } });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "true",
      wakeOn: "success",
      prompt: "summarize the green run",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("shellStatus: success");
    expect(h.privilege.depth()).toBe(1);
  });

  it("shell wakeOn=always with no follow-up text uses generic review prompt", async () => {
    const h = makeHarness({ execResult: { code: 0 } });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "npm test",
      wakeOn: "always",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("Review this scheduled shell");
  });

  it("notify logs to console when hasUI is false", async () => {
    const h = makeHarness({ hasUI: false });
    const job = h.store.create({
      name: "stretch",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(spy).toHaveBeenCalled();
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("ok");
    spy.mockRestore();
  });
});

describe("ScheduleRunner — termination (once / maxRuns)", () => {
  it("once job fires exactly once then auto-disables", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "reminder",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("in 5m"),
      scope: "global",
    });
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    const after1 = h.store.get(job.id, h.project)!;
    expect(after1.runCount).toBe(1);
    expect(after1.enabled).toBe(false);
    expect(after1.terminated).toBe("once");

    // Force due again — terminated/disabled jobs are not picked up by dueJobs.
    h.store.upsert({ ...after1, nextRunAt: T0 });
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.store.get(job.id, h.project)?.runCount).toBe(1); // no second fire
  });

  it("maxRuns terminates the job after the threshold", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "poll",
      prompt: "check",
      action: "notify",
      maxRuns: 2,
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });

    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    let row = h.store.get(job.id, h.project)!;
    expect(row.runCount).toBe(1);
    expect(row.terminated).toBeNull();

    // First fire advanced nextRunAt to T0+1h naturally; just advance the clock.
    h.setClock(new Date("2025-01-01T01:00:00.000Z"));
    await h.runner.fireDue(h.ctx, { source: "tick" });
    row = h.store.get(job.id, h.project)!;
    expect(row.runCount).toBe(2);
    expect(row.terminated).toBe("maxRuns");
    expect(row.enabled).toBe(false);

    // Subsequent due no longer fires.
    h.forceDue(job.id);
    h.setClock(new Date("2025-01-01T02:00:00.000Z"));
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.store.get(job.id, h.project)?.runCount).toBe(2);
  });

  it("once job that errors still terminates (one attempt consumed)", async () => {
    const h = makeHarness({ sendThrows: true });
    const job = h.store.create({
      name: "once",
      prompt: "p",
      schedule: parseSchedule("in 5m"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    const row = h.store.get(job.id, h.project)!;
    expect(row.lastStatus).toBe("error");
    expect(row.terminated).toBe("once");
  });
});

describe("ScheduleRunner — review P2 follow-ups", () => {
  it("message action degrades to console when sendMessage is unavailable", async () => {
    const h = makeHarness({ noSendMessage: true });
    const job = h.store.create({
      name: "note",
      prompt: "ctx for later",
      action: "message",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.customMessages).toHaveLength(0); // no custom-message channel
    expect(spy).toHaveBeenCalled(); // fell back to console, not a throw
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("ok");
    spy.mockRestore();
  });

  it("run_now serializes: concurrent run_now waves both deliver (never drop)", async () => {
    const h = makeHarness();
    const a = h.createGlobal("a");
    const b = h.createGlobal("b");
    h.forceDue(a.id);
    h.forceDue(b.id);
    // Auto waves drop when one is active; run_now must chain and both deliver.
    const p1 = h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [a.id] });
    const p2 = h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [b.id] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });

  it("a fired read_only turn structurally blocks bash via tool_call (e2e)", async () => {
    const h = makeHarness();
    const job = h.createGlobal("guard", "read_only");
    h.forceDue(job.id);
    h.runner.attach(); // registers the privilege tool_call hook
    await h.emit("session_start", { type: "session_start", reason: "new" });
    expect(h.privilege.depth()).toBe(1); // read_only pushed by the fire

    // bash is blocked and the batch is told to terminate (off-contract).
    const blocked = await h.toolCall("bash");
    expect(blocked).toMatchObject({ block: true, terminate: true });

    // read tools and schedule reads stay allowed under the same active tier.
    expect(await h.toolCall("read")).toBeUndefined();
    expect(await h.toolCall("schedule", { action: "list" })).toBeUndefined();
    // schedule mutations are blocked end-to-end (escalation guard).
    expect(
      (await h.toolCall("schedule", { action: "create" }))?.block,
    ).toBe(true);

    await h.emit("session_shutdown");
    expect(h.privilege.depth()).toBe(0);
  });
});

describe("ScheduleRunner — compaction busy-wait", () => {
  it("isCompactionBusyError matches only pi's compaction rejection", () => {
    expect(
      isCompactionBusyError(
        new Error(
          "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
        ),
      ),
    ).toBe(true);
    expect(isCompactionBusyError(new Error("boom"))).toBe(false);
    expect(isCompactionBusyError("not an error")).toBe(false);
    expect(isCompactionBusyError(undefined)).toBe(false);
  });

  it("waits out an active compaction flagged by session_before_compact, then delivers", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);
    h.runner.attach();

    await h.emit("session_before_compact", {
      type: "session_before_compact",
    });

    const wave = h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [job.id] });
    await new Promise((r) => setTimeout(r, 20)); // wave is now parked in the wait loop
    expect(h.sent).toHaveLength(0);

    await h.emit("session_compact", { type: "session_compact" });
    await wave;

    expect(h.sent).toHaveLength(1);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("ok");
  });

  it("recovers when sendUserMessage throws the compaction error (missed-event race)", async () => {
    const h = makeHarness({ sendCompactionBusyTimes: 2 });
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(1); // third attempt lands
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.runCount).toBe(1);
  });

  it("gives up after the wait budget: records error + advances instead of hanging", async () => {
    const h = makeHarness({
      sendCompactionBusyTimes: 1_000,
      compactionWaitMs: 30,
    });
    const job = h.createGlobal();
    h.forceDue(job.id);

    const started = Date.now();
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(Date.now() - started).toBeLessThan(5_000); // bounded, not hung
    expect(h.sent).toHaveLength(0);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toContain("compaction is in progress");
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(
      new Date(T0).getTime(),
    );
    expect(
      h.ledger.history({}).some((r) => r.status === "error"),
    ).toBe(true);
  });

  it("non-compaction send failures still fail fast (no retry)", async () => {
    const h = makeHarness({ sendThrows: true });
    const job = h.createGlobal();
    h.forceDue(job.id);

    const started = Date.now();
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(Date.now() - started).toBeLessThan(500);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom");
  });

  it("session_start resets a stale compaction flag (cancelled compaction)", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);
    h.runner.attach();

    // before_compact fired but no session_compact ever follows (cancelled).
    await h.emit("session_before_compact", {
      type: "session_before_compact",
    });

    // The next session_start clears the stale flag; the wave must not park.
    const started = Date.now();
    await h.emit("session_start", { type: "session_start", reason: "new" });

    expect(Date.now() - started).toBeLessThan(1_000); // not parked for the 5s budget
    expect(h.sent).toHaveLength(1);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("ok");
  });
});
