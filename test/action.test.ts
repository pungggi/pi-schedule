import { describe, expect, it } from "vitest";
import {
  ActionError,
  clampTimeoutMs,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
  normalizeCreateAction,
  normalizeJobAction,
  resolveWakeOn,
  selectShellFollowUp,
  shouldWakeForShell,
  shellResultOk,
  truncateOutput,
} from "../src/action.js";

describe("normalizeJobAction", () => {
  it("defaults empty/missing to prompt", () => {
    expect(normalizeJobAction(undefined)).toBe("prompt");
    expect(normalizeJobAction("")).toBe("prompt");
  });

  it("accepts valid kinds", () => {
    expect(normalizeJobAction("shell")).toBe("shell");
    expect(normalizeJobAction("notify")).toBe("notify");
  });

  it("rejects unknown kinds", () => {
    expect(() => normalizeJobAction("cron")).toThrow(ActionError);
  });
});

describe("normalizeCreateAction", () => {
  it("requires prompt for prompt/notify/message", () => {
    expect(() => normalizeCreateAction({ kind: "prompt" })).toThrow(/prompt/);
    expect(() => normalizeCreateAction({ kind: "notify" })).toThrow(/prompt/);
    expect(() =>
      normalizeCreateAction({ kind: "message", prompt: "hi" }),
    ).not.toThrow();
  });

  it("requires command for shell and forces mutate", () => {
    expect(() => normalizeCreateAction({ kind: "shell" })).toThrow(/command/);
    const n = normalizeCreateAction({
      kind: "shell",
      command: "npm test",
      prompt: "review failures",
      wakeOn: "failure",
    });
    expect(n.action).toBe("shell");
    expect(n.command).toBe("npm test");
    expect(n.wakeOn).toBe("failure");
    expect(n.forceTierMutate).toBe(true);
    expect(n.timeoutMs).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  });

  it("defaults shell wakeOn to always when follow-up text exists", () => {
    const n = normalizeCreateAction({
      kind: "shell",
      command: "true",
      prompt: "look at it",
    });
    expect(n.wakeOn).toBe("always");
  });

  it("defaults shell wakeOn to never when no follow-up text", () => {
    const n = normalizeCreateAction({ kind: "shell", command: "true" });
    expect(n.wakeOn).toBe("never");
  });

  it("rejects shell-only fields on non-shell kinds", () => {
    expect(() =>
      normalizeCreateAction({ kind: "prompt", prompt: "p", command: "x" }),
    ).toThrow(/command/);
    expect(() =>
      normalizeCreateAction({ kind: "notify", prompt: "p", wakeOn: "always" }),
    ).toThrow(/wakeOn/);
  });

  it("rejects invalid wakeOn", () => {
    expect(() =>
      normalizeCreateAction({
        kind: "shell",
        command: "x",
        wakeOn: "sometimes",
      }),
    ).toThrow(/wakeOn/);
  });
});

describe("wake policy", () => {
  const fail = { code: 1, killed: false };
  const ok = { code: 0, killed: false };
  const killed = { code: 0, killed: true };

  it("shellResultOk", () => {
    expect(shellResultOk(ok)).toBe(true);
    expect(shellResultOk(fail)).toBe(false);
    expect(shellResultOk(killed)).toBe(false);
  });

  it("shouldWakeForShell respects wakeOn", () => {
    expect(
      shouldWakeForShell({ wakeOn: "never", prompt: "x" }, fail),
    ).toBe(false);
    expect(
      shouldWakeForShell({ wakeOn: "always", prompt: "x" }, ok),
    ).toBe(true);
    expect(
      shouldWakeForShell({ wakeOn: "failure", prompt: "x" }, fail),
    ).toBe(true);
    expect(
      shouldWakeForShell({ wakeOn: "failure", prompt: "x" }, ok),
    ).toBe(false);
    expect(
      shouldWakeForShell({ wakeOn: "success", prompt: "x" }, ok),
    ).toBe(true);
    expect(
      shouldWakeForShell({ wakeOn: "success", prompt: "x" }, killed),
    ).toBe(false);
  });

  it("selectShellFollowUp priority", () => {
    expect(
      selectShellFollowUp(
        {
          wakeOn: "always",
          prompt: "default",
          successPrompt: "yay",
          failurePrompt: "nay",
        },
        ok,
      ),
    ).toBe("yay");
    expect(
      selectShellFollowUp(
        {
          wakeOn: "always",
          prompt: "default",
          successPrompt: "yay",
          failurePrompt: "nay",
        },
        fail,
      ),
    ).toBe("nay");
    expect(
      selectShellFollowUp({ wakeOn: "always", prompt: "default" }, ok),
    ).toBe("default");
    expect(
      selectShellFollowUp({ wakeOn: "always", prompt: "" }, ok),
    ).toMatch(/Review this scheduled shell/);
  });

  it("resolveWakeOn defaults", () => {
    expect(resolveWakeOn({ prompt: "x" })).toBe("always");
    expect(resolveWakeOn({ prompt: "" })).toBe("never");
    expect(resolveWakeOn({ wakeOn: "failure", prompt: "x" })).toBe("failure");
  });
});

describe("timeout + truncate", () => {
  it("clamps timeout", () => {
    expect(clampTimeoutMs(undefined)).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(clampTimeoutMs(999_999_999)).toBe(MAX_SHELL_TIMEOUT_MS);
    expect(clampTimeoutMs(1500.7)).toBe(1501);
    expect(() => clampTimeoutMs(0)).toThrow(ActionError);
  });

  it("truncates long output in the middle", () => {
    const long = "a".repeat(100) + "MID" + "b".repeat(100);
    const out = truncateOutput(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("…");
    expect(truncateOutput("short", 40)).toBe("short");
  });
});

import { normalizeMaxRuns, terminalReason } from "../src/action.js";
import { parseSchedule } from "../src/schedule.js";

describe("normalizeMaxRuns", () => {
  it("returns undefined for empty / validates positive ints", () => {
    expect(normalizeMaxRuns(undefined)).toBeUndefined();
    expect(normalizeMaxRuns("")).toBeUndefined();
    expect(normalizeMaxRuns(3)).toBe(3);
    expect(normalizeMaxRuns("5" as unknown as number)).toBe(5);
    expect(() => normalizeMaxRuns(0)).toThrow(ActionError);
    expect(() => normalizeMaxRuns(-1)).toThrow(ActionError);
    expect(() => normalizeMaxRuns(2.5)).toThrow(ActionError);
  });
});

describe("terminalReason", () => {
  it("once is always terminal after a fire", () => {
    const job = { schedule: parseSchedule("in 10m"), maxRuns: undefined };
    expect(terminalReason(job, 1)).toBe("once");
  });

  it("maxRuns triggers at the threshold", () => {
    const job = { schedule: parseSchedule("every 1h"), maxRuns: 3 };
    expect(terminalReason(job, 2)).toBeNull();
    expect(terminalReason(job, 3)).toBe("maxRuns");
    expect(terminalReason(job, 4)).toBe("maxRuns");
  });

  it("unbounded recurring jobs never terminate", () => {
    const job = { schedule: parseSchedule("every 1h"), maxRuns: undefined };
    expect(terminalReason(job, 999)).toBeNull();
  });
});
