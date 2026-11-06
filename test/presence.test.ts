import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPresence } from "../src/presence.js";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-sched-presence-"));
  temps.push(d);
  return d;
}

/** Presence with fully controllable clock + liveness, no real pids/time. */
function makePresence(
  dir: string,
  o: { now?: number; alive?: Set<number>; ttlMs?: number } = {},
) {
  const clock = { t: o.now ?? 1_000_000 };
  const alive = o.alive ?? null; // null = treat all as alive
  return {
    clock,
    presence: new SessionPresence(dir, {
      ttlMs: o.ttlMs ?? 90_000,
      now: () => clock.t,
      isProcessAlive: (pid: number) => (alive ? alive.has(pid) : true),
    }),
  };
}

describe("SessionPresence", () => {
  it("records a heartbeat that shows up in the global live set", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir);
    presence.heartbeat("s1", "/proj/a");
    expect(presence.aliveForGlobal()).toEqual(["s1"]);
  });

  it("scopes the live set by resolved project root", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir);
    presence.heartbeat("s1", "/proj/a");
    presence.heartbeat("s2", "/proj/a/"); // trailing slash — same root
    presence.heartbeat("s3", "/proj/b");
    expect(presence.aliveForProject("/proj/a").sort()).toEqual(["s1", "s2"]);
    expect(presence.aliveForProject("/proj/b")).toEqual(["s3"]);
    expect(presence.aliveForGlobal().sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("excludes and prunes a stale heartbeat past the TTL", () => {
    const dir = freshDir();
    const { clock, presence } = makePresence(dir, { ttlMs: 90_000 });
    presence.heartbeat("old", "/proj/a");
    clock.t += 90_001; // past TTL
    presence.heartbeat("new", "/proj/a");
    expect(presence.aliveForGlobal()).toEqual(["new"]);
    // stale file pruned from disk
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes("old"))).toBe(false);
  });

  it("excludes a session whose process is dead even if the heartbeat is fresh", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir, { alive: new Set([process.pid]) });
    presence.heartbeat("live", "/proj/a"); // pid captured internally = process.pid
    // Forge a fresh record for a dead pid.
    writeFileSync(
      join(dir, "dead.json"),
      JSON.stringify({ sessionId: "dead", pid: 999999, cwd: "/proj/a", lastSeen: 1_000_000 }),
    );
    const live = presence.aliveForGlobal();
    expect(live).toContain("live");
    expect(live).not.toContain("dead");
  });

  it("refreshes lastSeen on repeated heartbeats so a busy session stays alive", () => {
    const dir = freshDir();
    const { clock, presence } = makePresence(dir, { ttlMs: 90_000 });
    presence.heartbeat("s1", "/proj/a");
    clock.t += 60_000;
    presence.heartbeat("s1", "/proj/a"); // refresh before TTL
    clock.t += 60_000; // 120s since first, only 60s since refresh
    expect(presence.aliveForGlobal()).toEqual(["s1"]);
  });

  it("remove() drops the session's own record", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir);
    presence.heartbeat("s1", "/proj/a");
    presence.heartbeat("s2", "/proj/a");
    presence.remove("s1");
    expect(presence.aliveForGlobal()).toEqual(["s2"]);
  });

  it("ignores corrupt records instead of throwing", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir);
    presence.heartbeat("s1", "/proj/a");
    writeFileSync(join(dir, "garbage.json"), "{ not json");
    expect(() => presence.aliveForGlobal()).not.toThrow();
    expect(presence.aliveForGlobal()).toEqual(["s1"]);
  });

  it("returns an empty set when nothing has checked in", () => {
    const dir = freshDir();
    const { presence } = makePresence(dir);
    expect(presence.aliveForGlobal()).toEqual([]);
    expect(presence.aliveForProject("/proj/a")).toEqual([]);
  });
});
