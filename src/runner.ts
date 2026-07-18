/**
 * Due-job runner with reliability controls.
 *
 * Fires on:
 *  1. session_start (startup/new/resume) when jobs are due AND no CLI initial prompt
 *  2. an in-session ticker, only while idle
 *
 * Mitigations (see docs/RELIABILITY.md).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shouldSkipDueOnSessionStart } from "./cli-prompt.js";
import { RunLedger, buildRun, newRunId } from "./ledger.js";
import { JobLockManager } from "./lock.js";
import {
  DEFAULT_MISSED_WINDOW,
  DEFAULT_TIER,
  LIMITS,
  decideDue,
  idempotencyKeyFor,
} from "./policy.js";
import { PrivilegeGuard } from "./privilege.js";
import { buildFirePrompt } from "./prompt.js";
import { StoreError, type ScheduleStore } from "./store.js";
import type { FireSource, ScheduledJob } from "./types.js";

/** How often the in-session ticker checks for due jobs. */
export const TICK_MS = 30_000;

const FIRE_ON_REASONS = new Set(["startup", "new", "resume"]);
const ERROR_NOTIFY_COOLDOWN_MS = 5 * 60_000;

export interface RunnerOptions {
  store: ScheduleStore;
  pi: ExtensionAPI;
  ledger?: RunLedger;
  locks?: JobLockManager;
  privilege?: PrivilegeGuard;
  hasInitialPrompt?: () => boolean;
  now?: () => Date;
  tickMs?: number;
}

export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cwd = process.cwd();
  private waveActive = false;
  /** Serializes waves so run_now waits instead of silently no-oping. */
  private waveChain: Promise<unknown> = Promise.resolve();
  private lastErrorNotifyAt = 0;
  private lastErrorNotifyKey = "";
  private readonly hasInitialPrompt: (() => boolean) | undefined;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly ledger: RunLedger;
  private readonly locks: JobLockManager;
  private readonly privilege: PrivilegeGuard;

  constructor(private readonly opts: RunnerOptions) {
    this.hasInitialPrompt = opts.hasInitialPrompt;
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? TICK_MS;

    const paths = opts.store.pathsInfo();
    this.ledger = opts.ledger ?? new RunLedger(paths.runsFile);
    this.locks = opts.locks ?? new JobLockManager(paths.lockDir);
    this.privilege = opts.privilege ?? new PrivilegeGuard();
  }

  /** Bind session lifecycle + privilege hooks. Call once from extension factory. */
  attach(): void {
    const { pi } = this.opts;
    this.privilege.attach(pi);

    pi.on("session_start", async (event, ctx) => {
      this.cwd = ctx.cwd;
      this.stopTicker();

      if (FIRE_ON_REASONS.has(event.reason)) {
        if (shouldSkipDueOnSessionStart(event.reason, this.hasInitialPrompt)) {
          this.startTicker(ctx);
          return;
        }
        await this.fireDue(ctx, { source: "session_start" });
      }

      this.startTicker(ctx);
    });

    pi.on("session_shutdown", () => {
      this.stopTicker();
      this.privilege.clear();
    });
  }

  /**
   * Process due jobs (or forced job ids).
   * Auto waves drop if another auto wave is active.
   * run_now serializes on the wave chain (never silent no-op).
   */
  async fireDue(
    ctx: ExtensionContext,
    meta: { source: FireSource; jobIds?: string[] },
  ): Promise<ScheduledJob[]> {
    if (meta.source === "run_now") {
      const result = this.waveChain.then(() => this.runWave(ctx, meta));
      this.waveChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    if (this.waveActive) return [];
    return this.runWave(ctx, meta);
  }

  private async runWave(
    ctx: ExtensionContext,
    meta: { source: FireSource; jobIds?: string[] },
  ): Promise<ScheduledJob[]> {
    if (this.waveActive && meta.source !== "run_now") return [];
    this.waveActive = true;

    try {
      const now = this.now();
      let candidates: ScheduledJob[];

      if (meta.jobIds && meta.jobIds.length > 0) {
        candidates = meta.jobIds
          .map((id) => this.opts.store.get(id, this.cwd))
          .filter((j): j is ScheduledJob => Boolean(j));
      } else {
        if (meta.source === "tick" && !ctx.isIdle()) {
          return [];
        }
        candidates = this.opts.store.dueJobs(this.cwd, now);
      }

      if (candidates.length === 0) return [];

      const maxFires =
        meta.source === "session_start"
          ? LIMITS.maxFiresPerSessionStart
          : meta.source === "tick"
            ? LIMITS.maxFiresPerTick
            : candidates.length;

      const updated: ScheduledJob[] = [];
      let attempts = 0; // ok + error count toward cap

      for (const job of candidates) {
        const forced = meta.source === "run_now";
        const result = await this.processOne(ctx, job, {
          source: meta.source,
          forced,
          deliverAs: attempts === 0 ? undefined : "followUp",
          allowFire: forced || attempts < maxFires,
        });
        if (result) {
          updated.push(result);
          if (result.lastStatus === "ok" || result.lastStatus === "error") {
            attempts += 1;
          }
        }
      }

      return updated;
    } catch (err) {
      if (meta.source === "run_now") throw err;
      if (err instanceof StoreError) {
        this.emitError(ctx, `store error: ${err.message}`, `store:${err.message}`);
        return [];
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emitError(ctx, `runner error: ${message}`, `runner:${message}`);
      return [];
    } finally {
      this.waveActive = false;
    }
  }

  private emitError(ctx: ExtensionContext, detail: string, key: string): void {
    const now = Date.now();
    if (
      key === this.lastErrorNotifyKey &&
      now - this.lastErrorNotifyAt < ERROR_NOTIFY_COOLDOWN_MS
    ) {
      return;
    }
    this.lastErrorNotifyAt = now;
    this.lastErrorNotifyKey = key;

    const msg = `[pi-schedule] ${detail}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
  }

  private alreadyDelivered(job: ScheduledJob, key: string): boolean {
    // Durable primary: store row survives ledger window eviction.
    if (job.lastIdempotencyKey === key && job.lastStatus === "ok") return true;
    return this.ledger.wasDelivered(key);
  }

  private recordBestEffort(
    args: Parameters<typeof buildRun>[0],
  ): void {
    this.ledger.append(buildRun(args));
  }

  private async processOne(
    ctx: ExtensionContext,
    job: ScheduledJob,
    opts: {
      source: FireSource;
      forced: boolean;
      deliverAs?: "followUp" | "steer";
      allowFire: boolean;
    },
  ): Promise<ScheduledJob | null> {
    const at = this.now();
    const startedAt = at.toISOString();
    const runId = newRunId();
    const key = opts.forced
      ? `${job.id}:force:${runId}`
      : idempotencyKeyFor(job);

    const tier = job.tier ?? DEFAULT_TIER;
    const missedWindow = job.missedWindow ?? DEFAULT_MISSED_WINDOW;

    // Pre-lock idempotency (cheap).
    if (!opts.forced && this.alreadyDelivered(job, key)) {
      const advanced = this.opts.store.markAttempt(job, at, "skipped", {
        error: "idempotent_replay",
        idempotencyKey: key,
      });
      this.recordBestEffort({
        runId,
        jobId: job.id,
        jobName: job.name,
        scope: job.scope,
        projectPath: job.projectPath,
        idempotencyKey: key,
        source: opts.source,
        status: "skipped",
        startedAt,
        endedAt: this.now().toISOString(),
        detail: "idempotent_replay",
        tier,
        missedWindow,
      });
      return advanced;
    }

    if (!opts.forced) {
      const decision = decideDue(job, at, this.tickMs);
      if (decision.action === "skip") {
        const advanced = this.opts.store.markAttempt(job, at, "skipped", {
          error: decision.reason,
          idempotencyKey: key,
        });
        this.recordBestEffort({
          runId,
          jobId: job.id,
          jobName: job.name,
          scope: job.scope,
          projectPath: job.projectPath,
          idempotencyKey: key,
          source: opts.source,
          status: "skipped",
          startedAt,
          endedAt: this.now().toISOString(),
          detail: decision.reason,
          tier,
          missedWindow,
        });
        return advanced;
      }
    }

    // Over-cap: stay due, do NOT write ledger spam (busy flood).
    if (!opts.allowFire) {
      return null;
    }

    const handle = this.locks.tryAcquire(job.id);
    if (!handle) {
      // Locked: do not advance; avoid ledger spam on every tick — silent retry.
      return null;
    }

    try {
      // Re-check after lock (check-then-act fix).
      const fresh = this.opts.store.get(job.id, this.cwd) ?? job;
      const freshKey = opts.forced ? key : idempotencyKeyFor(fresh);
      if (!opts.forced && this.alreadyDelivered(fresh, freshKey)) {
        const advanced = this.opts.store.markAttempt(fresh, at, "skipped", {
          error: "idempotent_replay_post_lock",
          idempotencyKey: freshKey,
        });
        this.recordBestEffort({
          runId,
          jobId: fresh.id,
          jobName: fresh.name,
          scope: fresh.scope,
          projectPath: fresh.projectPath,
          idempotencyKey: freshKey,
          source: opts.source,
          status: "skipped",
          startedAt,
          endedAt: this.now().toISOString(),
          detail: "idempotent_replay_post_lock",
          tier: fresh.tier ?? tier,
          missedWindow: fresh.missedWindow ?? missedWindow,
        });
        return advanced;
      }

      const body = buildFirePrompt({
        job: fresh,
        runId,
        source: opts.source,
        forced: opts.forced,
      });

      if (opts.deliverAs || !ctx.isIdle()) {
        this.opts.pi.sendUserMessage(body, {
          deliverAs: opts.deliverAs ?? "followUp",
        });
      } else {
        this.opts.pi.sendUserMessage(body);
      }

      // Structural tier enforcement for the upcoming agent turn.
      this.privilege.enter(fresh.tier ?? tier);

      // Advance store FIRST (durable). Ledger is best-effort and must not
      // prevent nextRunAt advancement if runs.jsonl is unwritable.
      const updated = this.opts.store.markAttempt(fresh, at, "ok", {
        idempotencyKey: opts.forced ? key : freshKey,
      });
      this.recordBestEffort({
        runId,
        jobId: fresh.id,
        jobName: fresh.name,
        scope: fresh.scope,
        projectPath: fresh.projectPath,
        idempotencyKey: opts.forced ? key : freshKey,
        source: opts.source,
        status: "delivered",
        startedAt,
        endedAt: this.now().toISOString(),
        tier: fresh.tier ?? tier,
        missedWindow: fresh.missedWindow ?? missedWindow,
      });
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `[pi-schedule] failed to fire "${job.name}": ${message}`,
          "error",
        );
      } else {
        console.error(`[pi-schedule] failed to fire "${job.name}": ${message}`);
      }
      // Advance on error so we don't hot-loop a broken delivery path.
      const updated = this.opts.store.markAttempt(job, at, "error", {
        error: message,
        idempotencyKey: key,
      });
      this.recordBestEffort({
        runId,
        jobId: job.id,
        jobName: job.name,
        scope: job.scope,
        projectPath: job.projectPath,
        idempotencyKey: key,
        source: opts.source,
        status: "error",
        startedAt,
        endedAt: this.now().toISOString(),
        detail: message,
        tier,
        missedWindow,
      });
      return updated;
    } finally {
      handle.release();
    }
  }

  private startTicker(ctx: ExtensionContext): void {
    this.stopTicker();
    this.timer = setInterval(() => {
      void this.fireDue(ctx, { source: "tick" });
    }, this.tickMs);
    this.timer.unref?.();
  }

  private stopTicker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
