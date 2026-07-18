import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLedger, buildRun } from "../src/ledger.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("RunLedger", () => {
  it("appends and detects delivered idempotency keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(dir);
    const ledger = new RunLedger(join(dir, "runs.jsonl"));

    expect(ledger.wasDelivered("j1:t1")).toBe(false);

    ledger.append(
      buildRun({
        jobId: "j1",
        jobName: "n",
        scope: "global",
        idempotencyKey: "j1:t1",
        source: "session_start",
        status: "delivered",
        startedAt: "2025-01-01T00:00:00.000Z",
        endedAt: "2025-01-01T00:00:01.000Z",
        tier: "read_only",
        missedWindow: "catch_up_one",
      }),
    );

    expect(ledger.wasDelivered("j1:t1")).toBe(true);
    expect(ledger.wasDelivered("j1:t2")).toBe(false);

    const hist = ledger.history({ jobId: "j1", limit: 5 });
    expect(hist).toHaveLength(1);
    expect(hist[0]?.status).toBe("delivered");
  });

  it("does not treat skipped as delivered", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(dir);
    const ledger = new RunLedger(join(dir, "runs.jsonl"));
    ledger.append(
      buildRun({
        jobId: "j1",
        jobName: "n",
        scope: "global",
        idempotencyKey: "j1:t1",
        source: "tick",
        status: "skipped",
        startedAt: "2025-01-01T00:00:00.000Z",
        endedAt: "2025-01-01T00:00:00.000Z",
        detail: "missed_window_skip",
        tier: "read_only",
        missedWindow: "skip",
      }),
    );
    expect(ledger.wasDelivered("j1:t1")).toBe(false);
  });
});
