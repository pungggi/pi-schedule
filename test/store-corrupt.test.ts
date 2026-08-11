import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchedule } from "../src/schedule.js";
import { ScheduleStore, StoreError, defaultPaths } from "../src/store.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("corrupt store quarantine", () => {
  it("quarantines invalid JSON and refuses silent wipe", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-corrupt-"));
    temps.push(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const paths = defaultPaths(home);
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(paths.globalFile, "{not json", "utf8");

    const store = new ScheduleStore(paths);
    expect(() => store.listForCwd(root)).toThrow(StoreError);

    const names = readdirSync(paths.globalDir);
    expect(names.some((n) => n.startsWith("schedules.json.corrupt-"))).toBe(
      true,
    );
    // original should have been renamed away
    expect(existsSync(paths.globalFile)).toBe(false);
  });

  it("quarantines unsupported version", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-corrupt-"));
    temps.push(root);
    const home = join(root, "home");
    const paths = defaultPaths(home);
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(
      paths.globalFile,
      JSON.stringify({ version: 99, jobs: [{ id: "x" }] }),
      "utf8",
    );

    const store = new ScheduleStore(paths);
    expect(() =>
      store.create({
        name: "n",
        prompt: "p",
        schedule: parseSchedule("every 1d"),
        scope: "global",
      }),
    ).toThrow(/unsupported version/);

    // After successful quarantine, path is free — restore/retry works without restart.
    // (corrupt file was renamed away; create on empty path succeeds.)
    const recovered = store.create({
      name: "recovered",
      prompt: "p",
      schedule: parseSchedule("every 1d"),
      scope: "global",
    });
    expect(recovered.name).toBe("recovered");
  });

  it("quarantines a store whose jobs field is not an array", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-corrupt-"));
    temps.push(root);
    const home = join(root, "home");
    const paths = defaultPaths(home);
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(
      paths.globalFile,
      JSON.stringify({ version: 1, jobs: "not-an-array" }),
      "utf8",
    );
    const store = new ScheduleStore(paths);
    expect(() => store.listForCwd(root)).toThrow(/missing jobs array/);
  });

  it("takes over a genuinely stale store lock (crashed prior session)", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sched-corrupt-"));
    temps.push(root);
    const home = join(root, "home");
    const paths = defaultPaths(home);
    mkdirSync(paths.globalDir, { recursive: true });
    // Pre-create a stale lock file next to the store file, then backdate its
    // mtime past LOCK_STALE_MS so the holder is recognised as a crashed orphan.
    const lockFile = `${paths.globalFile}.lock`;
    writeFileSync(lockFile, "stale-token", "utf8");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockFile, stale, stale);

    const store = new ScheduleStore(paths);
    // Stale → rename-takeover on the first contended attempt.
    const job = store.create({
      name: "after-takeover",
      prompt: "p",
      schedule: parseSchedule("every 1d"),
      scope: "global",
    });
    expect(job.id).toMatch(/^[a-f0-9]{12}$/);
    // The orphan lock was renamed away; a fresh one (ours) took its place and
    // was released after the write.
    expect(existsSync(lockFile)).toBe(false);
  });

  it("does NOT steal a fresh (non-stale) store lock — fails loudly instead", () => {
    // Regression guard for the lost-write race: a slow-but-active writer must
    // never be robbed. Previously the lock was force-renamed on the last retry
    // regardless of age, which could lose concurrent RMW writes.
    const root = mkdtempSync(join(tmpdir(), "pi-sched-corrupt-"));
    temps.push(root);
    const home = join(root, "home");
    const paths = defaultPaths(home);
    mkdirSync(paths.globalDir, { recursive: true });
    // Fresh lock — mtime is now, so isLockStale is false on every retry.
    writeFileSync(`${paths.globalFile}.lock`, "fresh-token", "utf8");

    const store = new ScheduleStore(paths);
    expect(() =>
      store.create({
        name: "should-fail",
        prompt: "p",
        schedule: parseSchedule("every 1d"),
        scope: "global",
      }),
    ).toThrow(StoreError);
    // The fresh lock is untouched — not stolen, not deleted.
    expect(existsSync(`${paths.globalFile}.lock`)).toBe(true);
    expect(readFileSync(`${paths.globalFile}.lock`, "utf8")).toBe("fresh-token");
  });
});
