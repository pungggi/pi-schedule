/**
 * PrivilegeGuard — structural tier enforcement for scheduled turns.
 *
 * read_only blocks edit/write/bash; suggest blocks bash only; mutate blocks
 * nothing. agent_settled pops the stack one level (follow-up discipline).
 *
 * The tool_call handler is async (returns a Promise), so every call is awaited.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PrivilegeGuard } from "../src/privilege.js";

type BlockResult =
  | { block?: boolean; reason?: string; terminate?: boolean }
  | undefined;

function setup() {
  let toolCall:
    | ((event: { toolName: string; input?: unknown }) => Promise<BlockResult>)
    | null = null;
  let settled: (() => Promise<void>) | null = null;
  const pi = {
    on(
      event: string,
      handler:
        | ((
            event: { toolName: string; input?: unknown },
          ) => Promise<BlockResult>)
        | (() => Promise<void>),
    ): void {
      if (event === "tool_call") toolCall = handler as typeof toolCall;
      if (event === "agent_settled") settled = handler as typeof settled;
    },
  } as unknown as ExtensionAPI;

  const guard = new PrivilegeGuard();
  guard.attach(pi);

  return {
    guard,
    /** Invoke the captured tool_call handler; awaits the block decision. */
    call: async (
      toolName: string,
      input?: Record<string, unknown>,
    ): Promise<BlockResult> => toolCall!({ toolName, input }),
    settle: () => settled!(),
  };
}

const READ_TOOLS = ["read", "grep", "find", "ls"];
const MUTATE_TOOLS = ["edit", "write", "bash"];

describe("PrivilegeGuard tier enforcement", () => {
  it("read_only blocks edit, write, AND bash", async () => {
    const { guard, call } = setup();
    guard.enter("read_only");
    for (const name of MUTATE_TOOLS) {
      const res = await call(name);
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("read_only");
      expect(res?.reason).toContain(name);
    }
  });

  it("read_only allows non-mutating tools", async () => {
    const { guard, call } = setup();
    guard.enter("read_only");
    for (const name of READ_TOOLS) {
      expect(await call(name)).toBeUndefined();
    }
  });

  it("suggest blocks bash only (edit/write allowed for drafting)", async () => {
    const { guard, call } = setup();
    guard.enter("suggest");
    expect((await call("bash"))?.block).toBe(true);
    expect(await call("edit")).toBeUndefined();
    expect(await call("write")).toBeUndefined();
    expect(await call("read")).toBeUndefined();
  });

  it("mutate blocks nothing", async () => {
    const { guard, call } = setup();
    guard.enter("mutate");
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
    const { guard, call } = setup();
    guard.enter("read_only");
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
    guard.enter("suggest");
    expect((await call("bash"))?.terminate).toBe(true);
    expect((await call("schedule", { action: "create" }))?.terminate).toBe(true);
    // allowed tools never set terminate (no result returned at all)
    guard.enter("read_only");
    for (const name of READ_TOOLS) {
      expect(await call(name)).toBeUndefined();
    }
    // no scheduled turn → no block, no terminate
    guard.clear();
    expect(await call("bash")).toBeUndefined();
  });

  it("read_only blocks schedule create (shell-escalation guard) but allows list/history", async () => {
    const { guard, call } = setup();
    guard.enter("read_only");
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
    const { guard, call } = setup();
    guard.enter("suggest");
    expect((await call("schedule", { action: "create" }))?.block).toBe(true);
    expect((await call("schedule", { action: "run_now" }))?.block).toBe(true);
    expect(await call("schedule", { action: "list" })).toBeUndefined();
  });

  it("mutate allows schedule create (explicit escalation)", async () => {
    const { guard, call } = setup();
    guard.enter("mutate");
    expect(
      await call("schedule", { action: "create", kind: "shell" }),
    ).toBeUndefined();
  });

  it("schedule tool_call without input.action is not treated as a mutation", async () => {
    const { guard, call } = setup();
    guard.enter("read_only");
    expect(await call("schedule")).toBeUndefined();
    expect(await call("schedule", {})).toBeUndefined();
  });

  it("agent_settled clears exactly one scheduled turn", async () => {
    const { guard, call, settle } = setup();
    guard.enter("read_only");
    expect((await call("bash"))?.block).toBe(true);
    await settle(); // turn complete
    expect(await call("bash")).toBeUndefined();
  });

  it("stack discipline: one settle per follow-up (two enters need two settles)", async () => {
    const { guard, call, settle } = setup();
    guard.enter("read_only"); // follow-up 1
    guard.enter("read_only"); // follow-up 2
    expect(guard.depth()).toBe(2);
    await settle();
    expect(guard.depth()).toBe(1);
    // still one active → still blocked
    expect((await call("bash"))?.block).toBe(true);
    await settle();
    expect(guard.depth()).toBe(0);
    expect(await call("bash")).toBeUndefined();
  });

  it("enter() caps stack growth (host-invariant safety valve)", () => {
    // If settles ever stop keeping up with enters (double/no settle on a future
    // pi build), the stack must not grow unbounded and pin read_only forever.
    const { guard } = setup();
    for (let i = 0; i < 30; i++) guard.enter("read_only");
    expect(guard.depth()).toBe(16); // MAX_DEPTH
    // Still functional: a bash call is blocked under the capped read_only stack.
    // (covered implicitly by the tier tests; depth is the contract here.)
  });
});
