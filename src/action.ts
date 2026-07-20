/**
 * Job action kinds: prompt | shell | notify | message.
 *
 * Pure helpers for validation, defaults, and shell wake policy.
 * Delivery lives in the runner; this module stays side-effect free.
 */

import type {
  JobAction,
  ScheduledJob,
  ShellRunResult,
  TerminatedReason,
  WakeOn,
} from "./types.js";

export const DEFAULT_JOB_ACTION: JobAction = "prompt";
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
export const MAX_SHELL_OUTPUT_CHARS = 8_000;

const ACTIONS = new Set<JobAction>(["prompt", "shell", "notify", "message"]);
const WAKE_ONS = new Set<WakeOn>(["always", "failure", "success", "never"]);

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export function isJobAction(value: unknown): value is JobAction {
  return typeof value === "string" && ACTIONS.has(value as JobAction);
}

export function isWakeOn(value: unknown): value is WakeOn {
  return typeof value === "string" && WAKE_ONS.has(value as WakeOn);
}

/** Normalize legacy / missing action to "prompt". */
export function normalizeJobAction(raw: unknown): JobAction {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_JOB_ACTION;
  }
  if (!isJobAction(raw)) {
    throw new ActionError(
      `Invalid kind "${String(raw)}". Use prompt | shell | notify | message.`,
    );
  }
  return raw;
}

export function hasShellFollowUpText(
  job: Pick<
    ScheduledJob,
    "prompt" | "successPrompt" | "failurePrompt"
  >,
): boolean {
  return Boolean(
    job.prompt?.trim() ||
      job.successPrompt?.trim() ||
      job.failurePrompt?.trim(),
  );
}

/**
 * Resolve effective wakeOn.
 * Default: always if any follow-up text is set, else never.
 */
export function resolveWakeOn(
  job: Pick<
    ScheduledJob,
    "wakeOn" | "prompt" | "successPrompt" | "failurePrompt"
  >,
): WakeOn {
  if (job.wakeOn !== undefined && job.wakeOn !== null) {
    if (!isWakeOn(job.wakeOn)) {
      throw new ActionError(
        `Invalid wakeOn "${String(job.wakeOn)}". Use always | failure | success | never.`,
      );
    }
    return job.wakeOn;
  }
  return hasShellFollowUpText(job) ? "always" : "never";
}

export function shellResultOk(
  result: Pick<ShellRunResult, "code" | "killed">,
): boolean {
  return result.code === 0 && result.killed !== true;
}

export function shouldWakeForShell(
  job: Pick<
    ScheduledJob,
    "wakeOn" | "prompt" | "successPrompt" | "failurePrompt"
  >,
  result: Pick<ShellRunResult, "code" | "killed">,
): boolean {
  const wakeOn = resolveWakeOn(job);
  if (wakeOn === "never") return false;
  const ok = shellResultOk(result);
  if (wakeOn === "always") return true;
  if (wakeOn === "success") return ok;
  if (wakeOn === "failure") return !ok;
  return false;
}

/**
 * Pick the follow-up instruction for a shell wake.
 * Priority: successPrompt | failurePrompt | prompt | generic.
 */
export function selectShellFollowUp(
  job: Pick<
    ScheduledJob,
    "wakeOn" | "prompt" | "successPrompt" | "failurePrompt"
  >,
  result: Pick<ShellRunResult, "code" | "killed">,
): string | undefined {
  const ok = shellResultOk(result);
  if (ok && job.successPrompt?.trim()) return job.successPrompt.trim();
  if (!ok && job.failurePrompt?.trim()) return job.failurePrompt.trim();
  if (job.prompt?.trim()) return job.prompt.trim();
  if (resolveWakeOn(job) !== "never") {
    return "Review this scheduled shell command result and decide next steps.";
  }
  return undefined;
}

export function clampTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ActionError("timeoutMs must be a positive number");
  }
  return Math.min(Math.round(n), MAX_SHELL_TIMEOUT_MS);
}

export function truncateOutput(
  text: string | undefined,
  maxChars: number = MAX_SHELL_OUTPUT_CHARS,
): string {
  const s = text ?? "";
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars / 2) - 2;
  const tail = maxChars - head - 5;
  return `${s.slice(0, head)}\n…\n${s.slice(-tail)}`;
}

export interface CreateActionFields {
  kind?: string;
  prompt?: string;
  command?: string;
  wakeOn?: string;
  successPrompt?: string;
  failurePrompt?: string;
  timeoutMs?: number;
}

export interface NormalizedCreateAction {
  action: JobAction;
  prompt: string;
  command?: string;
  wakeOn?: WakeOn;
  successPrompt?: string;
  failurePrompt?: string;
  timeoutMs?: number;
  /** Shell jobs always run as mutate. */
  forceTierMutate: boolean;
}

/**
 * Validate + normalize create-time action fields.
 * Throws ActionError on invalid combinations.
 */
export function normalizeCreateAction(
  fields: CreateActionFields,
): NormalizedCreateAction {
  const action = normalizeJobAction(fields.kind);

  if (action === "shell") {
    const command = fields.command?.trim();
    if (!command) {
      throw new ActionError(
        'kind=shell requires "command" (e.g. "npm test" or "glab pipeline view 123").',
      );
    }
    const prompt = fields.prompt?.trim() ?? "";
    const successPrompt = fields.successPrompt?.trim() || undefined;
    const failurePrompt = fields.failurePrompt?.trim() || undefined;
    if (fields.wakeOn !== undefined && fields.wakeOn !== "" && !isWakeOn(fields.wakeOn)) {
      throw new ActionError(
        `Invalid wakeOn "${fields.wakeOn}". Use always | failure | success | never.`,
      );
    }
    const explicitWake =
      fields.wakeOn !== undefined && fields.wakeOn !== ""
        ? (fields.wakeOn as WakeOn)
        : undefined;
    const wakeOn = resolveWakeOn({
      wakeOn: explicitWake,
      prompt,
      successPrompt,
      failurePrompt,
    });
    return {
      action,
      prompt,
      command,
      wakeOn,
      successPrompt,
      failurePrompt,
      timeoutMs: clampTimeoutMs(fields.timeoutMs),
      forceTierMutate: true,
    };
  }

  const prompt = fields.prompt?.trim();
  if (!prompt) {
    throw new ActionError(
      action === "prompt"
        ? 'kind=prompt requires "prompt" (the isolated task text).'
        : `kind=${action} requires "prompt" (the ${action} text).`,
    );
  }
  if (fields.command?.trim()) {
    throw new ActionError(
      `"command" is only valid for kind=shell (got kind=${action}).`,
    );
  }
  if (fields.wakeOn) {
    throw new ActionError(
      `"wakeOn" is only valid for kind=shell (got kind=${action}).`,
    );
  }
  if (fields.successPrompt || fields.failurePrompt) {
    throw new ActionError(
      `"successPrompt"/"failurePrompt" are only valid for kind=shell.`,
    );
  }
  if (fields.timeoutMs !== undefined) {
    throw new ActionError(
      `"timeoutMs" is only valid for kind=shell (got kind=${action}).`,
    );
  }

  return {
    action,
    prompt,
    forceTierMutate: false,
  };
}

export function payloadSummary(job: ScheduledJob): string {
  if (job.action === "shell") return job.command ?? "";
  return job.prompt ?? "";
}

/** Validate maxRuns (positive integer) or return undefined. */
export function normalizeMaxRuns(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ActionError("maxRuns must be a positive integer");
  }
  return Math.min(n, 1_000_000);
}

/** Decide if a job should stop firing after this many runs. */
export function terminalReason(
  job: Pick<ScheduledJob, "schedule" | "maxRuns">,
  runCount: number,
): TerminatedReason | null {
  if (job.schedule.type === "once") return "once";
  if (job.maxRuns !== undefined && runCount >= job.maxRuns) return "maxRuns";
  return null;
}
