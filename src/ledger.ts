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
} from "node:fs";
import { dirname } from "node:path";
import type { JobRun, RunStatus } from "./types.js";

/** Max JSONL lines retained in memory for history / secondary idempotency. */
export const MAX_HISTORY = 200;

export function newRunId(): string {
  return randomBytes(8).toString("hex");
}

export class RunLedger {
  constructor(private readonly filePath: string) {}

  path(): string {
    return this.filePath;
  }

  /**
   * Best-effort append. Returns false on failure; never throws.
   * Callers must advance store state independently of ledger success.
   */
  append(run: JobRun): boolean {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(run)}\n`, "utf8");
      return true;
    } catch {
      return false;
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
  };
}
