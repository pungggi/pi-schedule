/**
 * schedule tool — create rate-limiting.
 *
 * Isolated in its own file: `createLimiter` in tool.ts is a module-level
 * singleton whose 60s window would pollute sibling tests. Each vitest test
 * file runs in its own isolate, so this file gets a fresh limiter.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import type { ScheduleRunner } from "../src/runner.js";
import { registerScheduleTool } from "../src/tool.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("schedule tool — create rate limit (isolated)", () => {
  it("blocks creates past maxCreatesPerMinute (10/min)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-rl-"));
    temps.push(root);
    const paths = defaultPaths(join(root, "home"));
    const store = new ScheduleStore(paths);
    const runner = { fireDue: async () => [] } as unknown as ScheduleRunner;

    let tool: {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }>;
    } | null = null;
    const pi = {
      registerTool: (t: typeof tool) => {
        tool = t;
      },
    } as unknown as ExtensionAPI;
    registerScheduleTool(pi, store, runner);

    const exec = (params: Record<string, unknown>) =>
      tool!.execute("t1", params, undefined, undefined, {
        cwd: join(root, "project"),
      });

    for (let i = 0; i < 10; i++) {
      const r = await exec({
        action: "create",
        name: `j${i}`,
        prompt: "p",
        every: "1d",
      });
      expect(r.content[0]?.text).toContain("Created");
    }

    const blocked = await exec({
      action: "create",
      name: "over",
      prompt: "p",
      every: "1d",
    });
    expect(blocked.content[0]?.text).toContain("rate limit");
    expect(blocked.details?.error).toBe("rate_limited");
  });
});
