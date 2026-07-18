/**
 * Single-flight locks for job delivery.
 *
 * - In-process map: one holder per job id in this process
 * - File lock via O_EXCL (wx) under ~/.pi-schedule/locks/
 * - Stale takeover uses rename (not unlink) so only one racer claims the orphan
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STALE_MS = 30 * 60_000; // 30m — abandon orphan locks

export interface LockHandle {
  jobId: string;
  release: () => void;
}

interface LockPayload {
  pid: number;
  token: string;
  at: string;
}

export class JobLockManager {
  private readonly held = new Map<string, string>(); // jobId → token

  constructor(private readonly lockDir: string) {}

  /**
   * Try to acquire exclusive lock for jobId.
   * Returns null if already held in-process or by a non-stale file lock.
   */
  tryAcquire(jobId: string): LockHandle | null {
    if (this.held.has(jobId)) return null;

    mkdirSync(this.lockDir, { recursive: true });
    const file = this.lockFile(jobId);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload: LockPayload = {
      pid: process.pid,
      token,
      at: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    // Fast path: exclusive create.
    if (this.tryCreate(file, body)) {
      return this.bind(jobId, token);
    }

    // Contended: only stale locks may be taken over.
    const existing = this.readPayload(file);
    if (!existing) {
      // Unreadable / vanished — one more create attempt.
      if (this.tryCreate(file, body)) return this.bind(jobId, token);
      return null;
    }
    if (!this.isPayloadStale(existing)) return null;

    // Atomic-ish claim: rename orphan aside. Only one racer wins the rename.
    const dead = `${file}.dead.${token}`;
    try {
      renameSync(file, dead);
    } catch {
      return null;
    }
    try {
      unlinkSync(dead);
    } catch {
      /* leave dead file; path is free */
    }

    if (!this.tryCreate(file, body)) return null;
    return this.bind(jobId, token);
  }

  private bind(jobId: string, token: string): LockHandle {
    this.held.set(jobId, token);
    return {
      jobId,
      release: () => this.release(jobId, token),
    };
  }

  private tryCreate(file: string, body: string): boolean {
    try {
      writeFileSync(file, body, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release only if we still own the lock (token match).
   * Prevents a stale-takeover victim from unlinking the new owner's file.
   */
  private release(jobId: string, token: string): void {
    if (this.held.get(jobId) === token) {
      this.held.delete(jobId);
    }
    const file = this.lockFile(jobId);
    try {
      if (!existsSync(file)) return;
      const data = this.readPayload(file);
      if (data?.token === token) {
        unlinkSync(file);
      }
    } catch {
      /* ignore */
    }
  }

  private lockFile(jobId: string): string {
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.lockDir, `${safe}.lock`);
  }

  private readPayload(file: string): LockPayload | null {
    try {
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, "utf8");
      const data = JSON.parse(raw) as Partial<LockPayload>;
      if (!data.token || !data.at) return null;
      return data as LockPayload;
    } catch {
      return null;
    }
  }

  private isPayloadStale(data: LockPayload): boolean {
    try {
      return Date.now() - new Date(data.at).getTime() > STALE_MS;
    } catch {
      return true;
    }
  }
}
