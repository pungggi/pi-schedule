import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_HISTORY, RunLedger, buildRun } from "../src/ledger.js";

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

describe("RunLedger robustness", () => {
  const base = {
    jobId: "j1",
    jobName: "n",
    scope: "global" as const,
    idempotencyKey: "j1:t1",
    source: "session_start" as const,
    startedAt: "2025-01-01T00:00:00.000Z",
    endedAt: "2025-01-01T00:00:01.000Z",
    tier: "read_only" as const,
    missedWindow: "catch_up_one" as const,
  };

  it("append never throws and returns false on an unwritable path", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(root);
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x"); // a FILE where a directory is expected
    const ledger = new RunLedger(join(blocker, "runs.jsonl"));
    expect(
      ledger.append(buildRun({ ...base, status: "delivered" })),
    ).toBe(false);
  });

  it("skips corrupt lines, keeps the valid ones", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(root);
    const file = join(root, "runs.jsonl");
    const valid = buildRun({ ...base, status: "delivered" });
    writeFileSync(file, `not-json\n${JSON.stringify(valid)}\n`, "utf8");
    const ledger = new RunLedger(file);
    expect(ledger.history({})).toHaveLength(1);
    expect(ledger.history({})[0]?.status).toBe("delivered");
  });

  it("readRecent returns [] when the path is a directory (read throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(dir);
    const ledger = new RunLedger(dir); // dir itself → readFileSync throws EISDIR
    expect(ledger.history({})).toEqual([]);
  });
});

describe("RunLedger — eviction window", () => {
  const base = {
    jobId: "j1",
    jobName: "n",
    scope: "global" as const,
    source: "session_start" as const,
    startedAt: "2025-01-01T00:00:00.000Z",
    endedAt: "2025-01-01T00:00:01.000Z",
    tier: "read_only" as const,
    missedWindow: "catch_up_one" as const,
  };

  it("wasDelivered only sees the last MAX_HISTORY entries (aging out)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-"));
    temps.push(dir);
    const ledger = new RunLedger(join(dir, "runs.jsonl"));

    // An early delivered record that should age out of the retained window.
    ledger.append(
      buildRun({ ...base, idempotencyKey: "early", status: "delivered" }),
    );
    // Fill past the window so "early" is evicted from the in-memory tail.
    for (let i = 0; i < MAX_HISTORY; i++) {
      ledger.append(
        buildRun({ ...base, idempotencyKey: `k${i}`, status: "delivered" }),
      );
    }

    expect(ledger.wasDelivered("early")).toBe(false); // aged out
    expect(ledger.wasDelivered(`k${MAX_HISTORY - 1}`)).toBe(true); // still in window
  });
});

describe("RunLedger — rotation (P3 fix)", () => {
  it("rotates in place once past maxBytes, keeping the newest lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-rot-"));
    temps.push(dir);
    const file = join(dir, "runs.jsonl");
    const ledger = new RunLedger(file, 2_000); // tiny cap for the test

    for (let i = 0; i < 60; i++) {
      ledger.append(
        buildRun({
          jobId: `j${i}`,
          jobName: `job-${i}`,
          scope: "global",
          idempotencyKey: `j${i}:t${i}`,
          source: "tick",
          status: "delivered",
          startedAt: "2025-01-01T00:00:00.000Z",
          endedAt: "2025-01-01T00:00:01.000Z",
          tier: "read_only",
          missedWindow: "catch_up_one",
        }),
      );
    }

    // file was rotated back under the cap and history still works
    const size = statSync(file).size;
    expect(size).toBeLessThanOrEqual(2_000);
    const hist = ledger.history({ limit: 100 });
    expect(hist.length).toBeGreaterThan(0);
    // newest rows survived (history is newest-first)
    expect(hist[0]?.jobId).toBe("j59");
  });

  it("rotation is transparent: appends keep working afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-rot2-"));
    temps.push(dir);
    const file = join(dir, "runs.jsonl");
    const ledger = new RunLedger(file, 1_500);
    for (let i = 0; i < 40; i++) {
      expect(
        ledger.append(
          buildRun({
            jobId: `x${i}`,
            jobName: "n",
            scope: "global",
            idempotencyKey: `x${i}:t`,
            source: "tick",
            status: "delivered",
            startedAt: "2025-01-01T00:00:00.000Z",
            endedAt: "2025-01-01T00:00:01.000Z",
            tier: "read_only",
            missedWindow: "catch_up_one",
          }),
        ),
      ).toBe(true);
    }
    expect(ledger.wasDelivered("x39:t")).toBe(true);
  });

  it("rotates to empty when a single row alone exceeds the byte target, then recovers", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-rot3-"));
    temps.push(dir);
    const file = join(dir, "runs.jsonl");
    const ledger = new RunLedger(file, 1_000);
    // One pathological row bigger than the whole cap.
    ledger.append(
      buildRun({
        jobId: "giant",
        jobName: "G".repeat(3_000),
        scope: "global",
        idempotencyKey: "giant:t",
        source: "tick",
        status: "delivered",
        startedAt: "2025-01-01T00:00:00.000Z",
        endedAt: "2025-01-01T00:00:01.000Z",
        tier: "read_only",
        missedWindow: "catch_up_one",
      }),
    );
    // Cap promise holds even for an oversized single row.
    expect(statSync(file).size).toBeLessThanOrEqual(1_000);
    // The next append recovers a usable ledger.
    expect(
      ledger.append(
        buildRun({
          jobId: "ok",
          jobName: "n",
          scope: "global",
          idempotencyKey: "ok:t",
          source: "tick",
          status: "delivered",
          startedAt: "2025-01-01T00:00:00.000Z",
          endedAt: "2025-01-01T00:00:01.000Z",
          tier: "read_only",
          missedWindow: "catch_up_one",
        }),
      ),
    ).toBe(true);
    expect(ledger.wasDelivered("ok:t")).toBe(true);
  });

  it("bounds rotation by UTF-8 bytes, not UTF-16 code units", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-ledger-rot4-"));
    temps.push(dir);
    const file = join(dir, "runs.jsonl");
    // Each CJK char is 3 UTF-8 bytes but 1 UTF-16 unit — a naive .length
    // budget would keep ~3x more bytes than intended.
    const ledger = new RunLedger(file, 2_000);
    for (let i = 0; i < 30; i++) {
      ledger.append(
        buildRun({
          jobId: `u${i}`,
          jobName: "漢".repeat(60), // 180 UTF-8 bytes / 60 UTF-16 units
          scope: "global",
          idempotencyKey: `u${i}:t`,
          source: "tick",
          status: "delivered",
          startedAt: "2025-01-01T00:00:00.000Z",
          endedAt: "2025-01-01T00:00:01.000Z",
          tier: "read_only",
          missedWindow: "catch_up_one",
        }),
      );
    }
    expect(statSync(file).size).toBeLessThanOrEqual(2_000);
    const hist = ledger.history({ limit: 100 });
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0]?.jobId).toBe("u29");
  });
});
