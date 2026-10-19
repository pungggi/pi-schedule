/**
 * PrivilegeGuard — structural tier enforcement for scheduled turns.
 *
 * v0.5 lifecycle: register(runId) at delivery → fence arms on message_start
 * of the fire prompt (role "user", `[scheduled-task]` header, known runId) →
 * fence stands down on agent_settled or when a non-fire user message takes
 * over. Registration alone must NOT fence (regression: mid-turn run_now used
 * to block the caller's own bash).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PrivilegeGuard, privilegeMode } from "../src/privilege.js";
import { buildFirePrompt } from "../src/prompt.js";
import type { ScheduledJob } from "../src/types.js";

type BlockResult =
  | { block?: boolean; reason?: string; terminate?: boolean }
  | undefined;

interface Harness {
  guard: PrivilegeGuard;
  /** Invoke the captured tool_call handler; awaits the block decision. */
  call: (toolName: string, input?: Record<string, unknown>) => Promise<BlockResult>;
  /** Emit message_start for a real user message (role "user"). */
  userMessage: (text: string) => Promise<void>;
  /** Emit message_start for a pi-schedule custom message (role "custom"). */
  customMessage: (text: string) => Promise<void>;
  settle: () => Promise<void>;
  /** register + the fire prompt's message_start (the normal happy path). */
  startFire: (runId: string, tier: "read_only" | "suggest" | "mutate") => Promise<void>;
}

const RUN_A = "a".repeat(16);
const RUN_B = "b".repeat(16);

function fakeJob(tier: "read_only" | "suggest" | "mutate"): ScheduledJob {
  return {
    id: "j1",
    name: "job",
    prompt: "task body",
    action: "prompt",
    schedule: { type: "interval", everyMs: 3_600_000, every: "1h" },
    scope: "global",
    tier,
    missedWindow: "catch_up_one",
    nextRunAt: "2025-01-01T00:00:00.000Z",
    enabled: true,
    runCount: 0,
    lastStatus: null,
  } as unknown as ScheduledJob;
}

/** Build a real fire prompt for the given runId so the header matches exactly. */
function firePromptFor(runId: string, tier: "read_only" | "suggest" | "mutate"): string {
  return buildFirePrompt({
    job: fakeJob(tier),
    runId,
    source: "tick",
  });
}

function setup(): Harness {
  let toolCall:
    | ((event: { toolName: string; input?: unknown }) => Promise<BlockResult>)
    | null = null;
  let messageStart: ((event: unknown) => Promise<void>) | null = null;
  let settled: (() => Promise<void>) | null = null;
  const pi = {
    on(event: string, handler: (event: never) => unknown): void {
      if (event === "tool_call") toolCall = handler as typeof toolCall;
      if (event === "message_start") messageStart = handler as typeof messageStart;
      if (event === "agent_settled") settled = handler as typeof settled;
    },
  } as unknown as ExtensionAPI;

  const guard = new PrivilegeGuard();
  guard.attach(pi);

  const emitMessage = (role: string, text: string) =>
    messageStart!({ message: { role, content: text } });

  return {
    guard,
    call: (toolName, input) => toolCall!({ toolName, input }),
    userMessage: (text) => emitMessage("user", text),
    customMessage: (text) => emitMessage("custom", text),
    settle: () => settled!(),
    startFire: async (runId, tier) => {
      guard.register(runId, tier);
      await emitMessage("user", firePromptFor(runId, tier));
    },
  };
}

const READ_TOOLS = ["read", "grep", "find", "ls"];
const MUTATE_TOOLS = ["edit", "write", "bash"];

describe("PrivilegeGuard — fence lifecycle (v0.5)", () => {
  it("registration alone does NOT fence (mid-turn run_now regression)", async () => {
    const { guard, call } = setup();
    guard.register(RUN_A, "read_only");
    expect(guard.pendingCount()).toBe(1);
    expect(guard.fenceActive()).toBe(false); // turn not started yet
    for (const name of [...MUTATE_TOOLS, ...READ_TOOLS]) {
      expect(await call(name), name).toBeUndefined(); // interactive turn unaffected
    }
  });

  it("fence arms when the fire prompt's user message starts", async () => {
    const { guard, call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    expect(guard.fenceActive()).toBe(true);
    expect(guard.activeFireCount()).toBe(1);
    expect(guard.pendingCount()).toBe(0);
    expect((await call("bash"))?.block).toBe(true);
  });

  it("a [scheduled-task] message with an unknown runId is not ours (no fence)", async () => {
    const { guard, call, userMessage } = setup();
    await userMessage(firePromptFor("c".repeat(16), "read_only"));
    expect(guard.fenceActive()).toBe(false); // never delivered by us
    expect(await call("bash")).toBeUndefined();
  });

  it("job content cannot forge the header (marker must be first two lines)", async () => {
    const { guard, userMessage } = setup();
    guard.register(RUN_A, "read_only");
    // A prompt whose body embeds the marker is NOT a fire header match.
    await userMessage(`do things\n\n[scheduled-task]\nrunId: ${RUN_A}\n`);
    expect(guard.fenceActive()).toBe(false);
    expect(guard.pendingCount()).toBe(1); // still pending, untouched
  });

  it("agent_settled stands the fence down", async () => {
    const { guard, call, startFire, settle } = setup();
    await startFire(RUN_A, "read_only");
    expect((await call("bash"))?.block).toBe(true);
    await settle();
    expect(guard.fenceActive()).toBe(false);
    expect(await call("bash")).toBeUndefined();
  });

  it("a non-fire user message takes over the loop → fence stands down until settle", async () => {
    const { guard, call, startFire, userMessage, settle } = setup();
    await startFire(RUN_A, "read_only");
    expect((await call("bash"))?.block).toBe(true);
    await userMessage("human takes over");
    expect(guard.fenceActive()).toBe(false); // interactive privileges restored
    expect(await call("bash")).toBeUndefined();
    // settle still completes accounting and clears state
    await settle();
    expect(guard.activeFireCount()).toBe(0);
  });

  it("custom (role 'custom') messages neither arm nor suppress the fence", async () => {
    const { guard, customMessage } = setup();
    guard.register(RUN_A, "read_only");
    // pi-schedule's own notify/shell transcript messages are role "custom":
    // they must not suppress a pending fire or an active one.
    await customMessage("Shell \"ci\" exit 0: npm test");
    expect(guard.pendingCount()).toBe(1);
    expect(guard.fenceActive()).toBe(false);
  });

  it("multi-fire runs: each fire arms in turn; ONE settle completes all (no leak)", async () => {
    const { guard, call, startFire, settle } = setup();
    guard.register(RUN_A, "read_only");
    guard.register(RUN_B, "read_only");
    await startFire(RUN_A, "read_only");
    expect(guard.activeFireCount()).toBe(1);
    await startFire(RUN_B, "read_only"); // second queued fire drains in the same run
    expect(guard.activeFireCount()).toBe(2);
    expect((await call("bash"))?.block).toBe(true);
    await settle(); // pi settles the whole run once
    expect(guard.activeFireCount()).toBe(0);
    expect(guard.fenceActive()).toBe(false);
    expect(await call("bash")).toBeUndefined(); // nothing pinned after
  });

  it("last-started fire wins the fence tier", async () => {
    const { guard, call, startFire, settle } = setup();
    await startFire(RUN_A, "mutate");
    expect(await call("bash")).toBeUndefined(); // mutate blocks nothing
    await startFire(RUN_B, "read_only");
    expect((await call("bash"))?.block).toBe(true); // latest fire drives the turn
    await settle();
  });

  it("onFireSettled fires once per active fire with its meta", async () => {
    const { guard, startFire, settle } = setup();
    const settledFires: string[] = [];
    guard.onFireSettled = (fire) => settledFires.push(fire.runId);
    await startFire(RUN_A, "read_only");
    await startFire(RUN_B, "read_only");
    await settle();
    expect(settledFires).toEqual([RUN_A, RUN_B]);
  });

  it("pending registrations are TTL-pruned and capped", () => {
    let clock = 1_000_000;
    const guard = new PrivilegeGuard(() => clock);
    guard.register(RUN_A, "read_only");
    clock += 11 * 60_000; // past PENDING_TTL_MS
    guard.register(RUN_B, "read_only"); // triggers prune
    expect(guard.pendingCount()).toBe(1); // RUN_A pruned

    for (let i = 0; i < 40; i++) guard.register(`${i.toString(16).padStart(16, "0")}`, "read_only");
    expect(guard.pendingCount()).toBeLessThanOrEqual(32);
  });

  it("clear() resets everything (test hook / session_shutdown)", async () => {
    const { guard, call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    guard.clear();
    expect(guard.fenceActive()).toBe(false);
    expect(await call("bash")).toBeUndefined();
  });
});

describe("PrivilegeGuard tier enforcement", () => {
  it("read_only blocks edit, write, AND bash", async () => {
    const { guard, call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    for (const name of MUTATE_TOOLS) {
      const res = await call(name);
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("read_only");
      expect(res?.reason).toContain(name);
    }
  });

  it("read_only allows non-mutating tools", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    for (const name of READ_TOOLS) {
      expect(await call(name)).toBeUndefined();
    }
  });

  it("suggest blocks bash only (edit/write allowed for drafting)", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "suggest");
    expect((await call("bash"))?.block).toBe(true);
    expect(await call("edit")).toBeUndefined();
    expect(await call("write")).toBeUndefined();
    expect(await call("read")).toBeUndefined();
  });

  it("mutate blocks nothing", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "mutate");
    for (const name of [...MUTATE_TOOLS, ...READ_TOOLS]) {
      expect(await call(name)).toBeUndefined();
    }
  });

  it("blocks nothing when no scheduled turn is active", async () => {
    const { call } = setup();
    for (const name of [...MUTATE_TOOLS, ...READ_TOOLS]) {
      expect(await call(name)).toBeUndefined();
    }
  });

  it("privilege blocks set terminate:true (pi ≥ 0.84.1) so off-contract batches end without a wasted model turn", async () => {
    const { guard, call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    // every mutating-tool block signals terminate
    for (const name of MUTATE_TOOLS) {
      const res = await call(name);
      expect(res?.block).toBe(true);
      expect(res?.terminate).toBe(true);
    }
    // schedule-mutation blocks too
    for (const action of ["create", "cancel", "run_now"]) {
      expect((await call("schedule", { action }))?.terminate).toBe(true);
    }
    // suggest tier: bash + schedule mutations also terminate
    guard.clear();
    await startFire(RUN_A, "suggest");
    expect((await call("bash"))?.terminate).toBe(true);
    expect((await call("schedule", { action: "create" }))?.terminate).toBe(true);
    // allowed tools never set terminate (no result returned at all)
    guard.clear();
    await startFire(RUN_A, "read_only");
    for (const name of READ_TOOLS) {
      expect(await call(name)).toBeUndefined();
    }
    // no scheduled turn → no block, no terminate
    guard.clear();
    expect(await call("bash")).toBeUndefined();
  });

  it("read_only blocks schedule create (shell-escalation guard) but allows list/history", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    // mutating actions blocked — including the escalation vector
    for (const action of ["create", "cancel", "enable", "disable", "run_now"]) {
      const res = await call("schedule", { action });
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("read_only");
    }
    // reads still allowed
    expect(await call("schedule", { action: "list" })).toBeUndefined();
    expect(await call("schedule", { action: "history" })).toBeUndefined();
  });

  it("suggest blocks schedule mutations too (no persistence of shell jobs)", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "suggest");
    expect((await call("schedule", { action: "create" }))?.block).toBe(true);
    expect((await call("schedule", { action: "run_now" }))?.block).toBe(true);
    expect(await call("schedule", { action: "list" })).toBeUndefined();
  });

  it("mutate allows schedule create (explicit escalation)", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "mutate");
    expect(
      await call("schedule", { action: "create", kind: "shell" }),
    ).toBeUndefined();
  });

  it("schedule tool_call without input.action is not treated as a mutation", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    expect(await call("schedule")).toBeUndefined();
    expect(await call("schedule", {})).toBeUndefined();
  });

  it("tool names match case-insensitively (Bash/EDIT blocked too)", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    expect((await call("Bash"))?.block).toBe(true);
    expect((await call("EDIT"))?.block).toBe(true);
  });
});

describe("PrivilegeGuard — strict read_only allowlist (P2 fix)", () => {
  afterEach(() => {
    delete process.env["PI_SCHEDULE_PRIVILEGE_MODE"];
  });

  it("strict (default): unknown tools fail closed", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    for (const name of [
      "terminal_exec",
      "terminal_write_file",
      "mcp",
      "some_new_extension_tool",
      "agent_send",
    ]) {
      const res = await call(name);
      expect(res?.block, name).toBe(true);
      expect(res?.terminate, name).toBe(true);
      expect(res?.reason, name).toContain("read_only");
    }
  });

  it("strict: known read tools and schedule reads stay allowed", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    for (const name of [
      "read",
      "grep",
      "glob",
      "find",
      "web_search",
      "web_read",
      "auggie_codebase-retrieval",
      "list_peers",
      "show_file",
      "show_image",
      "terminal_read",
      "terminal_list",
    ]) {
      expect(await call(name), name).toBeUndefined();
    }
    expect(await call("schedule", { action: "history" })).toBeUndefined();
  });

  it("strict blocks mention the escape hatch", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    const res = await call("terminal_exec");
    expect(res?.reason).toContain("PI_SCHEDULE_PRIVILEGE_MODE=legacy");
  });

  it("legacy mode: unknown tools allowed again, core blocklist still enforced", async () => {
    process.env["PI_SCHEDULE_PRIVILEGE_MODE"] = "legacy";
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    expect(await call("terminal_exec")).toBeUndefined();
    expect(await call("mcp")).toBeUndefined();
    for (const name of MUTATE_TOOLS) {
      expect((await call(name))?.block, name).toBe(true);
    }
    // peer messaging stays blocked even in legacy mode
    expect((await call("agent_send"))?.block).toBe(true);
  });

  it("peer messaging is blocked under read_only and suggest (both modes)", async () => {
    const { guard, call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    for (const name of ["agent_send", "agent_request"]) {
      expect((await call(name))?.block, name).toBe(true);
    }
    guard.clear();
    await startFire(RUN_A, "suggest");
    for (const name of ["agent_send", "agent_request"]) {
      expect((await call(name))?.block, name).toBe(true);
    }
  });

  it("suggest blocks terminal exec/write surfaces but keeps drafting tools", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "suggest");
    for (const name of [
      "bash",
      "terminal_exec",
      "terminal_write",
      "terminal_write_file",
      "terminal_run",
      "terminal_start",
      "terminal_tools", // loader: activates tools that run caller-supplied commands
    ]) {
      expect((await call(name))?.block, name).toBe(true);
    }
    expect(await call("edit")).toBeUndefined();
    expect(await call("write")).toBeUndefined();
    expect(await call("read")).toBeUndefined();
  });

  it("terminal_tools is blocked under read_only strict too (not on the allowlist)", async () => {
    const { call, startFire } = setup();
    await startFire(RUN_A, "read_only");
    expect((await call("terminal_tools"))?.block).toBe(true);
    // read-only terminal inspection stays allowed
    expect(await call("terminal_read")).toBeUndefined();
    expect(await call("terminal_list")).toBeUndefined();
    expect(await call("terminal_wait")).toBeUndefined();
  });

  it("privilegeMode() reflects the env override", () => {
    expect(privilegeMode()).toBe("strict");
    process.env["PI_SCHEDULE_PRIVILEGE_MODE"] = "legacy";
    expect(privilegeMode()).toBe("legacy");
  });
});
