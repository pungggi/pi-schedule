/**
 * Due-job runner with reliability controls.
 *
 * Fires on:
 *  1. session_start (startup/new/resume) when jobs are due AND no CLI initial prompt
 *  2. an in-session ticker, only while idle
 *
 * Action kinds (see action.ts):
 *  - prompt: inject isolated agent task (original behavior)
 *  - shell: pi.exec command; optional agent wake via wakeOn
 *  - notify: UI/console reminder only
 *  - message: session custom message (display, no agent turn)
 *
 * Mitigations (see docs/RELIABILITY.md).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
  DEFAULT_JOB_ACTION,
  DEFAULT_SHELL_TIMEOUT_MS,
  selectShellFollowUp,
  shouldWakeForShell,
  terminalReason,
  truncateOutput,
} from "./action.js";
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
import {
  buildFirePrompt,
  buildShellFollowUpPrompt,
  notifyLabel,
} from "./prompt.js";
import { StoreError, type ScheduleStore } from "./store.js";
import type {
  FireSource,
  JobAction,
  ScheduledJob,
  ShellRunResult,
} from "./types.js";

/** How often the in-session ticker checks for due jobs. */
export const TICK_MS = 30_000;

/**
 * Candidate Git Bash (MSYS) binaries on Windows, in preference order. The bare
 * `"bash"` is ambiguous on Windows: PATH resolution can pick
 * `C:\Windows\System32\bash.exe` (the WSL launcher), which exits non-zero
 * with NO execution when no WSL distro is installed (`execvpe(/bin/bash)
 * failed`). Git Bash matches pi's own bash tool + the `/c/` path conventions
 * in `shellCommandPrefix`, so prefer it.
 */
const WIN_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/**
 * Resolve the shell binary passed to `pi.exec` for shell jobs.
 *
 * - `PI_SCHEDULE_SHELL` env (absolute path) wins outright — lets users force a
 *   specific binary without a release.
 * - On Windows, prefer the first existing Git Bash (see {@link WIN_GIT_BASH_PATHS}).
 * - Otherwise fall back to `"bash"` (POSIX; the historic behavior).
 */
export function resolveShell(): string {
  const override = process.env["PI_SCHEDULE_SHELL"];
  if (override) return override;
  if (process.platform !== "win32") return "bash";
  for (const candidate of WIN_GIT_BASH_PATHS) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // permission / race — try the next candidate
    }
  }
  return "bash";
}

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

  private sendAgentMessage(
    body: string,
    ctx: ExtensionContext,
    deliverAs?: "followUp" | "steer",
  ): void {
    if (deliverAs || !ctx.isIdle()) {
      this.opts.pi.sendUserMessage(body, {
        deliverAs: deliverAs ?? "followUp",
      });
    } else {
      this.opts.pi.sendUserMessage(body);
    }
  }

  private async deliver(
    ctx: ExtensionContext,
    job: ScheduledJob,
    opts: {
      runId: string;
      source: FireSource;
      forced: boolean;
      deliverAs?: "followUp" | "steer";
    },
  ): Promise<{ detail?: string; wokeAgent: boolean; lastShell?: ShellRunResult }> {
    const action: JobAction = job.action ?? DEFAULT_JOB_ACTION;

    if (action === "notify") {
      const msg = notifyLabel(job);
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      else console.log(msg);
      this.opts.pi.sendMessage?.(
        {
          customType: "pi-schedule",
          content: msg,
          display: true,
          details: { jobId: job.id, action: "notify", runId: opts.runId },
        },
        { triggerTurn: false },
      );
      return { detail: "notify", wokeAgent: false };
    }

    if (action === "message") {
      const body = job.prompt.trim() || job.name;
      this.opts.pi.sendMessage(
        {
          customType: "pi-schedule",
          content: body,
          display: true,
          details: { jobId: job.id, action: "message", runId: opts.runId },
        },
        { triggerTurn: false },
      );
      return { detail: "message", wokeAgent: false };
    }

    if (action === "shell") {
      return this.deliverShell(ctx, job, opts);
    }

    // prompt (default)
    const body = buildFirePrompt({
      job,
      runId: opts.runId,
      source: opts.source,
      forced: opts.forced,
    });
    this.sendAgentMessage(body, ctx, opts.deliverAs);
    return { detail: "prompt", wokeAgent: true };
  }

  private async deliverShell(
    ctx: ExtensionContext,
    job: ScheduledJob,
    opts: {
      runId: string;
      source: FireSource;
      forced: boolean;
      deliverAs?: "followUp" | "steer";
    },
  ): Promise<{ detail?: string; wokeAgent: boolean; lastShell?: ShellRunResult }> {
    const command = job.command?.trim();
    if (!command) {
      throw new Error(`shell job "${job.name}" has no command`);
    }

    const cwd = job.projectPath ?? ctx.cwd ?? this.cwd;
    const timeoutMs = job.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;

    if (ctx.hasUI) {
      ctx.ui.notify(
        `[pi-schedule] running shell "${job.name}": ${command}`,
        "info",
      );
    }

    const execResult = await this.opts.pi.exec(resolveShell(), ["-lc", command], {
      cwd,
      timeout: timeoutMs,
    });

    const lastShell: ShellRunResult = {
      ok: execResult.code === 0 && execResult.killed !== true,
      command,
      cwd,
      timeoutMs,
      code: execResult.code,
      killed: Boolean(execResult.killed),
      stdout: truncateOutput(execResult.stdout),
      stderr: truncateOutput(execResult.stderr),
    };

    this.opts.pi.sendMessage?.(
      {
        customType: "pi-schedule",
        content: `Shell "${job.name}" exit ${lastShell.code}${lastShell.killed ? " (killed)" : ""}: ${command}`,
        display: true,
        details: { jobId: job.id, action: "shell", runId: opts.runId, result: lastShell },
      },
      { triggerTurn: false },
    );

    let wokeAgent = false;
    if (shouldWakeForShell(job, lastShell)) {
      const instruction = selectShellFollowUp(job, lastShell);
      if (instruction) {
        const body = buildShellFollowUpPrompt({
          job,
          runId: opts.runId,
          source: opts.source,
          forced: opts.forced,
          result: lastShell,
          instruction,
        });
        this.sendAgentMessage(body, ctx, opts.deliverAs);
        wokeAgent = true;
      }
    }

    const detail = `shell exit=${lastShell.code}${lastShell.killed ? " killed" : ""}${wokeAgent ? " woke" : ""}`;
    return { detail, wokeAgent, lastShell };
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
    const action: JobAction = job.action ?? DEFAULT_JOB_ACTION;

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
        action,
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
          action,
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
      const freshAction: JobAction = fresh.action ?? DEFAULT_JOB_ACTION;
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
          action: freshAction,
        });
        return advanced;
      }

      const delivery = await this.deliver(ctx, fresh, {
        runId,
        source: opts.source,
        forced: opts.forced,
        deliverAs: opts.deliverAs,
      });

      // Structural tier enforcement only when an agent turn was started.
      if (delivery.wokeAgent) {
        this.privilege.enter(fresh.tier ?? tier);
      }

      // Advance store FIRST (durable). Ledger is best-effort and must not
      // prevent nextRunAt advancement if runs.jsonl is unwritable.
      const updated = this.opts.store.markAttempt(fresh, at, "ok", {
        idempotencyKey: opts.forced ? key : freshKey,
        lastShell: delivery.lastShell,
      });
      const term = terminalReason(updated, updated.runCount);
      const finalJob = term
        ? this.opts.store.terminate(updated, term, at)
        : updated;
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
        detail:
          delivery.detail + (term ? ` terminated:${term}` : ""),
        tier: fresh.tier ?? tier,
        missedWindow: fresh.missedWindow ?? missedWindow,
        action: freshAction,
      });
      return finalJob;
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
      const term = terminalReason(updated, updated.runCount);
      const finalJob = term
        ? this.opts.store.terminate(updated, term, at)
        : updated;
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
        detail: message + (term ? ` terminated:${term}` : ""),
        tier,
        missedWindow,
        action,
      });
      return finalJob;
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
