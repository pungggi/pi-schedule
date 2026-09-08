/**
 * Append-only run ledger (JSONL).
 *
 * Path: ~/.pi-schedule/runs.jsonl
 * Purpose: forensic trail + secondary idempotency check.
 *
 * Primary at-most-once signal is job.lastIdempotencyKey on the store row
 * (survives ledger window eviction). Ledger wasDelivered is best-effort.
 *
 * append() never throws — disk full must not block nextRunAt advancement.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./store.js";
import type { JobRun, RunStatus } from "./types.js";

/** Max JSONL lines retained in memory for history / secondary idempotency. */
export const MAX_HISTORY = 200;

/** Rotate the ledger file once it grows past this (keeps the newest lines). */
export const MAX_LEDGER_BYTES = 5 * 1024 * 1024;

/** Lines kept across a rotation (well above MAX_HISTORY so history stays deep). */
const ROTATE_KEEP_LINES = 1000;

export function newRunId(): string {
  return randomBytes(8).toString("hex");
}

export class RunLedger {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number = MAX_LEDGER_BYTES,
  ) {}

  path(): string {
    return this.filePath;
  }

  /**
   * Best-effort append. Returns false on failure; never throws.
   * Callers must advance store state independently of ledger success.
   * Grows the append-only file only up to maxBytes, then rotates in place
   * (keeps the newest lines) — forensic value without unbounded disk growth.
   */
  append(run: JobRun): boolean {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      // Serialize append+rotate against other processes: the rotation is a
      // read-modify-rename, so an unlocked append landing between the read
      // and the rename would be silently dropped by the rotating process.
      withFileLock(this.filePath, () => {
        appendFileSync(this.filePath, `${JSON.stringify(run)}\n`, "utf8");
        this.maybeRotateLocked();
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Size-capped rewrite keeping the newest lines; best-effort, never throws.
   * MUST be called while holding the file lock (see append).
   *
   * Bounds by UTF-8 bytes (not UTF-16 code units). If even the single newest
   * line exceeds the byte target, the file is rotated to empty — the cap
   * promise holds, and the next append re-adds the current row.
   */
  private maybeRotateLocked(): void {
    try {
      if (!existsSync(this.filePath)) return;
      if (statSync(this.filePath).size <= this.maxBytes) return;
      const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
      // Keep the newest lines bounded by BOTH count and bytes (target: half
      // the cap, so rotation is not re-triggered on every append).
      const targetBytes = Math.max(1, Math.floor(this.maxBytes / 2));
      const keep: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0 && keep.length < ROTATE_KEEP_LINES; i--) {
        const line = lines[i]!;
        const add = Buffer.byteLength(line, "utf8") + 1;
        if (bytes + add > targetBytes) break; // applies to the first line too
        keep.unshift(line);
        bytes += add;
      }
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, keep.map((l) => `${l}\n`).join(""), "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      /* best-effort: a failed rotation leaves the file as-is */
    }
  }

  /**
   * True if this idempotency key already has a successful delivery
   * within the recent history window (MAX_HISTORY lines).
   */
  wasDelivered(idempotencyKey: string): boolean {
    for (const run of this.readRecent()) {
      if (run.idempotencyKey === idempotencyKey && run.status === "delivered") {
        return true;
      }
    }
    return false;
  }

  /** Recent runs, newest first, optionally filtered by jobId. */
  history(opts: { jobId?: string; limit?: number } = {}): JobRun[] {
    const limit = opts.limit ?? 20;
    const all = this.readRecent();
    const filtered = opts.jobId
      ? all.filter((r) => r.jobId === opts.jobId)
      : all;
    return filtered.slice(0, limit);
  }

  private readRecent(): JobRun[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-MAX_HISTORY);
      const runs: JobRun[] = [];
      for (const line of tail) {
        try {
          runs.push(JSON.parse(line) as JobRun);
        } catch {
          // skip corrupt line
        }
      }
      return runs.reverse(); // newest first
    } catch {
      return [];
    }
  }
}

export function buildRun(partial: {
  runId?: string;
  jobId: string;
  jobName: string;
  scope: JobRun["scope"];
  projectPath?: string;
  idempotencyKey: string;
  source: JobRun["source"];
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  detail?: string;
  tier: JobRun["tier"];
  missedWindow: JobRun["missedWindow"];
  action?: JobRun["action"];
}): JobRun {
  return {
    runId: partial.runId ?? newRunId(),
    jobId: partial.jobId,
    jobName: partial.jobName,
    scope: partial.scope,
    projectPath: partial.projectPath,
    idempotencyKey: partial.idempotencyKey,
    source: partial.source,
    status: partial.status,
    startedAt: partial.startedAt,
    endedAt: partial.endedAt,
    detail: partial.detail,
    tier: partial.tier,
    missedWindow: partial.missedWindow,
    action: partial.action,
  };
}
