import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
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
});
