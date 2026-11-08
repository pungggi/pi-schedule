/**
 * Live-session presence registry.
 *
 * The only cross-session coordination pi-schedule had was a per-job file
 * lock. That answers "did someone already deliver?" but not "who *should*?".
 * The origin-first delivery ladder (see delivery.ts) needs to know which
 * sessions are alive so it can route a due job to its origin session, or
 * elect a single owner when the origin is gone. This registry supplies that.
 *
 * Each live session drops a small heartbeat file it refreshes on every tick;
 * a reader treats a session as alive when its heartbeat is recent AND its pid
 * is still running (same machine — these files never cross hosts). Stale files
 * are pruned on read, and each session removes its own file on shutdown.
 *
 * Best-effort by construction: every fs call is wrapped so a missing dir,
 * a torn read, or a permission blip degrades to "not present" rather than
 * taking a delivery — or the session — down.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** 3 missed ticks (see runner TICK_MS) — one dropped tick is still alive. */
export const DEFAULT_PRESENCE_TTL_MS = 90_000;

interface PresenceRecord {
  sessionId: string;
  pid: number;
  cwd: string;
  lastSeen: number;
}

export interface SessionPresenceOptions {
  ttlMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to a real pid-liveness probe. */
  isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process → dead. EPERM: exists but not ours → alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** File-name-safe slug for a session id (ids are opaque; be defensive). */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export class SessionPresence {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    private readonly dir: string,
    opts: SessionPresenceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  }

  /** Record/refresh this session's heartbeat. Never throws. */
  heartbeat(sessionId: string, cwd: string): void {
    const record: PresenceRecord = {
      sessionId,
      pid: process.pid,
      cwd,
      lastSeen: this.now(),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.file(sessionId);
      const tmp = `${file}.${process.pid}.${this.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(record));
      renameSync(tmp, file); // atomic: readers never see a torn file
    } catch {
      // Presence is an optimization; a failed heartbeat must not break a turn.
    }
  }

  /** Remove this session's own record (call on shutdown). Never throws. */
  remove(sessionId: string): void {
    try {
      rmSync(this.file(sessionId), { force: true });
    } catch {
      // ignore
    }
  }

  /** Live session ids across all projects (for global-scope jobs). */
  aliveForGlobal(): string[] {
    return this.liveRecords().map((r) => r.sessionId);
  }

  /** Live session ids whose cwd resolves to this project root. */
  aliveForProject(projectRoot: string): string[] {
    const root = resolve(projectRoot);
    return this.liveRecords()
      .filter((r) => resolve(r.cwd) === root)
      .map((r) => r.sessionId);
  }

  private file(sessionId: string): string {
    return join(this.dir, `${safeName(sessionId)}.json`);
  }

  /**
   * Read every record, drop the stale/dead ones (pruning their files), and
   * return the live remainder. Best-effort throughout.
   */
  private liveRecords(): PresenceRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return []; // dir does not exist yet → nobody present
    }

    const live: PresenceRecord[] = [];
    const cutoff = this.now() - this.ttlMs;

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      const record = this.readRecord(path);
      if (!record) {
        this.prune(path); // corrupt/unreadable
        continue;
      }
      const fresh = record.lastSeen > cutoff;
      if (fresh && this.isProcessAlive(record.pid)) {
        live.push(record);
      } else {
        this.prune(path);
      }
    }
    return live;
  }

  private readRecord(path: string): PresenceRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PresenceRecord>;
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.lastSeen === "number"
      ) {
        return parsed as PresenceRecord;
      }
      return null;
    } catch {
      return null;
    }
  }

  private prune(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}
