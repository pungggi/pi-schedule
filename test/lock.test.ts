import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

describe("JobLockManager — contention & takeover", () => {
  it("cross-instance: a fresh (non-stale) lock held by another process blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    const a = new JobLockManager(dir);
    const b = new JobLockManager(dir); // separate in-process map; file lock is the guard
    expect(a.tryAcquire("job")).not.toBeNull();
    expect(b.tryAcquire("job")).toBeNull(); // non-stale → blocked
  });

  it("takes over a stale lock (at older than STALE_MS)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    const file = join(dir, "job.lock");
    const oldAt = new Date(Date.now() - 31 * 60_000).toISOString();
    writeFileSync(file, JSON.stringify({ pid: 1, token: "old", at: oldAt }), "utf8");
    const locks = new JobLockManager(dir);
    expect(locks.tryAcquire("job")).not.toBeNull(); // stale → rename takeover
  });

  it("a garbage (non-JSON) lock file has no readable payload and blocks until removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    writeFileSync(join(dir, "job.lock"), "not-json", "utf8");
    const locks = new JobLockManager(dir);
    expect(locks.tryAcquire("job")).toBeNull();
  });

  it("a payload missing token/at is treated as no usable contender", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    writeFileSync(join(dir, "job.lock"), JSON.stringify({ pid: 1 }), "utf8");
    const locks = new JobLockManager(dir);
    expect(locks.tryAcquire("job")).toBeNull();
  });

  it("release is a no-op when the lock file is already gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sched-lock-"));
    temps.push(dir);
    const locks = new JobLockManager(dir);
    const handle = locks.tryAcquire("job")!;
    unlinkSync(join(dir, "job.lock"));
    expect(() => handle.release()).not.toThrow();
  });
});
