/**
 * Hybrid schedule store: global (~/.pi-schedule) + project (.pi/schedule.json).
 *
 * File format is versioned and daemon-ready so a future headless runner can
 * share the same on-disk jobs.
 *
 * - Corrupt / unsupported-version files are quarantined (no silent wipe).
 * - Mutations take a per-file O_EXCL lock and re-read inside the lock
 *   (reduces last-write-wins races across concurrent pi sessions).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_JOB_ACTION, isWakeOn, normalizeJobAction } from "./action.js";
import {
  DEFAULT_MISSED_WINDOW,
  DEFAULT_TIER,
  LIMITS,
  nextAfter,
} from "./policy.js";
import { computeNextRunAt } from "./schedule.js";
import type {
  CreateJobInput,
  JobStatus,
  ScheduleScope,
  ScheduleStoreFile,
  ScheduledJob,
  ShellRunResult,
  TerminatedReason,
} from "./types.js";

const STORE_VERSION = 1 as const;
const GLOBAL_DIR_NAME = ".pi-schedule";
const GLOBAL_FILE_NAME = "schedules.json";
const PROJECT_REL = join(".pi", "schedule.json");
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 20;
const LOCK_RETRY_MS = 25;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface StorePaths {
  globalDir: string;
  globalFile: string;
  projectFile: (projectRoot: string) => string;
  runsFile: string;
  lockDir: string;
}

export function defaultPaths(home: string = homedir()): StorePaths {
  const globalDir = join(home, GLOBAL_DIR_NAME);
  return {
    globalDir,
    globalFile: join(globalDir, GLOBAL_FILE_NAME),
    projectFile: (projectRoot: string) => join(resolve(projectRoot), PROJECT_REL),
    runsFile: join(globalDir, "runs.jsonl"),
    lockDir: join(globalDir, "locks"),
  };
}

export function newJobId(): string {
  return randomBytes(6).toString("hex");
}

function emptyStore(): ScheduleStoreFile {
  return { version: STORE_VERSION, jobs: [] };
}

/** Normalize legacy rows missing reliability / action fields. */
function normalizeJob(raw: ScheduledJob): ScheduledJob {
  let action = DEFAULT_JOB_ACTION;
  try {
    action = normalizeJobAction(raw.action);
  } catch {
    action = DEFAULT_JOB_ACTION;
  }
  const wakeOn = raw.wakeOn !== undefined && isWakeOn(raw.wakeOn) ? raw.wakeOn : undefined;
  const timeoutMs =
    raw.timeoutMs !== undefined &&
    Number.isFinite(raw.timeoutMs) &&
    (raw.timeoutMs as number) > 0
      ? raw.timeoutMs
      : undefined;
  const maxRuns =
    raw.maxRuns !== undefined &&
    Number.isInteger(raw.maxRuns) &&
    (raw.maxRuns as number) > 0
      ? raw.maxRuns
      : undefined;
  return {
    ...raw,
    action,
    prompt: raw.prompt ?? "",
    wakeOn,
    timeoutMs,
    maxRuns,
    terminated: raw.terminated ?? null,
    missedWindow: raw.missedWindow ?? DEFAULT_MISSED_WINDOW,
    tier: raw.tier ?? DEFAULT_TIER,
  };
}

/**
 * Quarantine a bad store file and throw — never return empty and later overwrite.
 * Error text: restore the quarantined file over the original path and retry
 * (no in-process freeze — works without restart).
 */
function quarantineAndThrow(filePath: string, reason: string): never {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined = `${filePath}.corrupt-${ts}`;
  let moved = false;
  try {
    if (existsSync(filePath)) {
      renameSync(filePath, quarantined);
      moved = true;
    }
  } catch {
    // If rename fails, still refuse to treat as empty.
  }
  throw new StoreError(
    moved
      ? `Schedule store unreadable (${reason}): quarantined to ${basename(quarantined)}. ` +
          `Inspect it, restore over ${basename(filePath)}, then retry (no restart needed).`
      : `Schedule store unreadable (${reason}): could not quarantine ${basename(filePath)}. ` +
          `Fix permissions/disk and retry.`,
  );
}

function readStoreFile(filePath: string): ScheduleStoreFile {
  if (!existsSync(filePath)) return emptyStore();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    quarantineAndThrow(filePath, `read failed: ${msg}`);
  }

  if (!raw.trim()) return emptyStore();

  let parsed: Partial<ScheduleStoreFile>;
  try {
    parsed = JSON.parse(raw) as Partial<ScheduleStoreFile>;
  } catch {
    quarantineAndThrow(filePath, "invalid JSON");
  }

  if (parsed.version !== STORE_VERSION) {
    quarantineAndThrow(
      filePath,
      `unsupported version ${String(parsed.version)} (expected ${STORE_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.jobs)) {
    quarantineAndThrow(filePath, "missing jobs array");
  }

  return {
    version: STORE_VERSION,
    jobs: (parsed.jobs as ScheduledJob[]).map(normalizeJob),
  };
}

function writeStoreFile(filePath: string, store: ScheduleStoreFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

/** Per-file exclusive lock for read-modify-write of schedule JSON. */
function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  let acquired = false;

  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      acquired = true;
      break;
    } catch {
      // Stale lock takeover via rename.
      try {
        if (existsSync(lockPath)) {
          const raw = readFileSync(lockPath, "utf8");
          // crude age: if lock body is old format without timestamp, still try after retries
          void raw;
          const st = existsSync(lockPath);
          if (st && i === LOCK_RETRIES - 1) {
            const dead = `${lockPath}.dead.${token}`;
            try {
              renameSync(lockPath, dead);
              try {
                unlinkSync(dead);
              } catch {
                /* ignore */
              }
              writeFileSync(lockPath, token, { flag: "wx" });
              acquired = true;
              break;
            } catch {
              /* continue */
            }
          }
        }
      } catch {
        /* continue */
      }
      // Brief sync backoff (avoid SharedArrayBuffer — not always available).
      const end = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }

  if (!acquired) {
    throw new StoreError(
      `Could not acquire store lock for ${basename(filePath)} (another session busy?).`,
    );
  }

  try {
    return fn();
  } finally {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === token) {
        unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
  }
}

void LOCK_STALE_MS;

export class ScheduleStore {
  constructor(private readonly paths: StorePaths = defaultPaths()) {}

  pathsInfo(): StorePaths {
    return this.paths;
  }

  globalPath(): string {
    return this.paths.globalFile;
  }

  projectPath(projectRoot: string): string {
    return this.paths.projectFile(projectRoot);
  }

  listForCwd(cwd: string): ScheduledJob[] {
    const projectRoot = resolve(cwd);
    const global = readStoreFile(this.paths.globalFile).jobs;
    const project = readStoreFile(this.paths.projectFile(projectRoot)).jobs;
    const projectFiltered = project.filter(
      (j) => !j.projectPath || resolve(j.projectPath) === projectRoot,
    );
    return [...global, ...projectFiltered].map(normalizeJob);
  }

  get(id: string, cwd: string): ScheduledJob | undefined {
    return this.listForCwd(cwd).find((j) => j.id === id);
  }

  countInScope(scope: ScheduleScope, projectRoot?: string): number {
    if (scope === "global") {
      return readStoreFile(this.paths.globalFile).jobs.length;
    }
    const root = resolve(projectRoot ?? process.cwd());
    return readStoreFile(this.paths.projectFile(root)).jobs.length;
  }

  create(input: CreateJobInput): ScheduledJob {
    const scope = input.scope;
    const projectRoot =
      scope === "project"
        ? resolve(input.projectPath ?? process.cwd())
        : undefined;

    if (this.countInScope(scope, projectRoot) >= LIMITS.maxJobsPerScope) {
      throw new StoreError(
        `Job limit reached (${LIMITS.maxJobsPerScope} per ${scope} scope). Cancel unused jobs first.`,
      );
    }

    const now = input.now ?? new Date();
    const isoNow = now.toISOString();
    const nextRunAt = computeNextRunAt(input.schedule, now, {
      inclusive: input.schedule.type === "daily",
    }).toISOString();

    const action = normalizeJobAction(input.action);
    const job: ScheduledJob = {
      id: newJobId(),
      name: input.name.trim(),
      prompt: (input.prompt ?? "").trim(),
      action,
      command: input.command?.trim() || undefined,
      wakeOn: input.wakeOn,
      successPrompt: input.successPrompt?.trim() || undefined,
      failurePrompt: input.failurePrompt?.trim() || undefined,
      timeoutMs: input.timeoutMs,
      maxRuns: input.maxRuns,
      schedule: input.schedule,
      scope,
      projectPath: projectRoot,
      enabled: true,
      terminated: null,
      missedWindow: input.missedWindow ?? DEFAULT_MISSED_WINDOW,
      tier: input.tier ?? DEFAULT_TIER,
      createdAt: isoNow,
      updatedAt: isoNow,
      lastRunAt: null,
      nextRunAt,
      runCount: 0,
      lastStatus: null,
    };

    this.upsert(job);
    return job;
  }

  /**
   * Upsert under file lock: re-read latest jobs, merge this job, write.
   * Prevents concurrent sessions from resurrecting a consumed nextRunAt
   * when updating different jobs in the same file.
   */
  upsert(job: ScheduledJob): void {
    const file = this.fileFor(job);
    withFileLock(file, () => {
      const store = readStoreFile(file);
      const normalized = normalizeJob(job);
      const idx = store.jobs.findIndex((j) => j.id === normalized.id);
      if (idx >= 0) store.jobs[idx] = normalized;
      else store.jobs.push(normalized);
      writeStoreFile(file, store);
    });
  }

  remove(id: string, cwd: string): ScheduledJob | undefined {
    const projectRoot = resolve(cwd);

    const fromGlobal = this.removeFromFile(this.paths.globalFile, id);
    if (fromGlobal) return fromGlobal;

    return this.removeFromFile(this.paths.projectFile(projectRoot), id);
  }

  /**
   * Record a fire/skip attempt: advances nextRunAt from `at` (unless advance=false).
   * runCount increments only for delivered (ok) and error fires — not skip/locked.
   */
  markAttempt(
    job: ScheduledJob,
    at: Date,
    status: NonNullable<JobStatus>,
    opts: {
      error?: string;
      idempotencyKey?: string;
      advance?: boolean;
      lastShell?: ShellRunResult;
    } = {},
  ): ScheduledJob {
    const advance = opts.advance !== false;
    const next = advance
      ? nextAfter(job.schedule, at).toISOString()
      : job.nextRunAt;

    const countRun = status === "ok" || status === "error";
    const updated: ScheduledJob = {
      ...normalizeJob(job),
      lastRunAt: at.toISOString(),
      nextRunAt: next,
      runCount: countRun ? job.runCount + 1 : job.runCount,
      lastStatus: status,
      lastError: opts.error,
      lastIdempotencyKey: opts.idempotencyKey ?? job.lastIdempotencyKey,
      updatedAt: at.toISOString(),
      ...(opts.lastShell ? { lastShell: opts.lastShell } : {}),
    };
    this.upsert(updated);
    return updated;
  }

  /** @deprecated prefer markAttempt */
  markRan(
    job: ScheduledJob,
    at: Date,
    status: NonNullable<JobStatus>,
    error?: string,
  ): ScheduledJob {
    return this.markAttempt(job, at, status, { error });
  }

  setEnabled(id: string, cwd: string, enabled: boolean): ScheduledJob | undefined {
    const job = this.get(id, cwd);
    if (!job) return undefined;
    const updated: ScheduledJob = {
      ...job,
      enabled,
      // Re-enabling clears the terminal flag so the job can run again;
      // disabling preserves it for history.
      terminated: enabled ? null : (job.terminated ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.upsert(updated);
    return updated;
  }

  /**
   * Mark a job terminal (disabled + reason) after it exhausted its runs.
   * Does not advance nextRunAt — the job is done.
   */
  terminate(
    job: ScheduledJob,
    reason: TerminatedReason,
    at: Date = new Date(),
  ): ScheduledJob {
    const updated: ScheduledJob = {
      ...normalizeJob(job),
      enabled: false,
      terminated: reason,
      updatedAt: at.toISOString(),
    };
    this.upsert(updated);
    return updated;
  }

  dueJobs(cwd: string, now: Date = new Date()): ScheduledJob[] {
    return this.listForCwd(cwd).filter(
      (j) => j.enabled && new Date(j.nextRunAt).getTime() <= now.getTime(),
    );
  }

  private fileFor(job: ScheduledJob): string {
    if (job.scope === "global") return this.paths.globalFile;
    const root = job.projectPath ?? process.cwd();
    return this.paths.projectFile(root);
  }

  private removeFromFile(file: string, id: string): ScheduledJob | undefined {
    return withFileLock(file, () => {
      const store = readStoreFile(file);
      const idx = store.jobs.findIndex((j) => j.id === id);
      if (idx < 0) return undefined;
      const [removed] = store.jobs.splice(idx, 1);
      writeStoreFile(file, store);
      return removed ? normalizeJob(removed) : undefined;
    });
  }
}

/** Resolve default scope when the agent omits it. */
export function defaultScope(cwd: string): ScheduleScope {
  // Note: no upward walk — uses ctx.cwd only. Project jobs live at
  // <cwd>/.pi/schedule.json. Launch pi from the project root.
  const piDir = join(resolve(cwd), ".pi");
  if (existsSync(piDir)) return "project";
  return "global";
}
