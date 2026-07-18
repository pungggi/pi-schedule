import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobLockManager } from "../src/lock.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("JobLockManager", () => {
  it("single-flight in-process", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    const locks = new JobLockManager(dir);

    const a = locks.tryAcquire("job1");
    expect(a).not.toBeNull();
    expect(locks.tryAcquire("job1")).toBeNull();
    a!.release();
    expect(locks.tryAcquire("job1")).not.toBeNull();
  });

  it("allows different job ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    const locks = new JobLockManager(dir);
    expect(locks.tryAcquire("a")).not.toBeNull();
    expect(locks.tryAcquire("b")).not.toBeNull();
  });
});
