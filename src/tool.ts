/**
 * Agent-facing `schedule` tool.
 *
 * Actions: create | list | cancel | enable | disable | run_now | history
 * Job kinds (create.kind): prompt | shell | notify | message
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
  ActionError,
  normalizeCreateAction,
  normalizeMaxRuns,
  payloadSummary,
} from "./action.js";
import { RunLedger } from "./ledger.js";
import {
  CreateRateLimiter,
  DEFAULT_MISSED_WINDOW,
  DEFAULT_TIER,
  LIMITS,
} from "./policy.js";
import {
  formatRelative,
  formatSchedule,
  ScheduleParseError,
  scheduleFromParts,
} from "./schedule.js";
import type { ScheduleRunner } from "./runner.js";
import { StoreError, defaultScope, type ScheduleStore } from "./store.js";
import { TrustStore } from "./trust.js";
import type {
  MissedWindowPolicy,
  PrivilegeTier,
  ScheduledJob,
  ScheduleScope,
} from "./types.js";

const ScheduleParams = Type.Object({
  action: StringEnum([
    "create",
    "list",
    "cancel",
    "enable",
    "disable",
    "run_now",
    "history",
    "trust",
  ] as const),
  name: Type.Optional(Type.String({ description: "Job name (create)" })),
  /**
   * What fires when due (create). Default prompt.
   * prompt = agent task | shell = run command | notify = UI reminder | message = session note
   */
  kind: Type.Optional(
    StringEnum(["prompt", "shell", "notify", "message"] as const),
  ),
  /** One-shot: fire once after a relative delay (e.g. "10m", "30s"), then terminate. */
  once: Type.Optional(
    Type.String({ description: 'One-shot delay, e.g. "10m" or "30s" (xor with every/dailyAt)' }),
  ),
  /** Max deliveries (ok+error) before auto-disable. */
  maxRuns: Type.Optional(
    Type.Number({ description: "Max deliveries before the job auto-disables (default: unlimited)." }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Task/reminder text (required for prompt/notify/message; optional shell follow-up).",
    }),
  ),
  command: Type.Optional(
    Type.String({
      description: 'Shell command for kind=shell (e.g. "npm test").',
    }),
  ),
  wakeOn: Type.Optional(
    StringEnum(["always", "failure", "success", "never"] as const),
  ),
  successPrompt: Type.Optional(
    Type.String({
      description: "Shell only: agent follow-up when command succeeds.",
    }),
  ),
  failurePrompt: Type.Optional(
    Type.String({
      description: "Shell only: agent follow-up when command fails.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Shell only: exec timeout ms (default 60000, max 600000).",
    }),
  ),
  every: Type.Optional(
    Type.String({ description: 'Interval, e.g. "30m", "2h", "1d" (create)' }),
  ),
  dailyAt: Type.Optional(
    Type.String({ description: 'Daily local time "HH:MM" (create)' }),
  ),
  scope: Type.Optional(StringEnum(["global", "project"] as const)),
  /** Overdue policy: catch_up_one (default) | skip */
  missedWindow: Type.Optional(
    StringEnum(["catch_up_one", "skip"] as const),
  ),
  /** Privilege tier for agent-waking fires: read_only (default) | suggest | mutate. Shell forces mutate. */
  tier: Type.Optional(
    StringEnum(["read_only", "suggest", "mutate"] as const),
  ),
  id: Type.Optional(Type.String({ description: "Job id" })),
  /** history: max rows (default 10) */
  limit: Type.Optional(Type.Number({ description: "history limit" })),
});

const createLimiter = new CreateRateLimiter();

/** Test hook: reset the in-process create rate window between tests. */
export function _resetCreateLimiterForTests(): void {
  createLimiter.reset();
}

function summarize(job: ScheduledJob, now: Date = new Date()): string {
  const state = job.terminated
    ? `off/terminated:${job.terminated}`
    : job.enabled
      ? "on"
      : "off";
  const next = formatRelative(job.nextRunAt, now);
  const last = job.lastRunAt ? formatRelative(job.lastRunAt, now) : "never";
  const kind = job.action ?? "prompt";
  const payload = truncate(payloadSummary(job), 120);
  const wake =
    kind === "shell" && job.wakeOn ? `  wakeOn: ${job.wakeOn}` : "";
  const maxRuns =
    job.maxRuns !== undefined
      ? `  runs: ${job.runCount}/${job.maxRuns}`
      : "";
  // Surface the last shell outcome so a failing CI poll doesn't look "ok".
  const shellInfo = job.lastShell
    ? `  lastExit=${job.lastShell.code}${job.lastShell.killed ? " killed" : ""}${job.lastShell.ok ? "" : " (failed)"}`
    : "";
  return [
    `- ${job.id}  ${job.name}  [${state}/${job.scope}/${kind}/${job.tier}]`,
    `  schedule: ${formatSchedule(job.schedule)}  missedWindow: ${job.missedWindow}${wake}`,
    `  next: ${next}  last: ${last}  runs: ${job.runCount}${maxRuns}` +
      (job.lastStatus ? `  lastStatus: ${job.lastStatus}` : "") +
      shellInfo,
    `  ${kind === "shell" ? "command" : "prompt"}: ${payload}`,
  ].join("\n");
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function registerScheduleTool(
  pi: ExtensionAPI,
  store: ScheduleStore,
  runner: ScheduleRunner,
  ledger?: RunLedger,
  trust: TrustStore = new TrustStore(store.pathsInfo().trustFile),
): void {
  const runLedger = ledger ?? new RunLedger(store.pathsInfo().runsFile);

  pi.registerTool({
    name: "schedule",
    label: "Schedule",
    description:
      "Manage scheduled agent tasks and actions (reviews, polls, shell checks, reminders). " +
      "Actions: create, list, cancel, enable, disable, run_now, history, trust. " +
      "Create kind: prompt (default) | shell | notify | message. " +
      'Schedules: every "30m"/"2h"/"1d" or dailyAt "09:00". ' +
      "Defaults: tier=read_only (shell→mutate), missedWindow=catch_up_one. " +
      "Due jobs fire on session start (unless pi was launched with an initial prompt) " +
      "and while the session is open. Project-scope jobs only auto-fire in trusted " +
      "projects (action=trust trusts the current project). See package docs/RELIABILITY.md.",
    parameters: ScheduleParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;

      try {
        switch (params.action) {
          case "create":
            return handleCreate(store, params, cwd, ctx, pi, runner, trust);
          case "list":
            return handleList(store, cwd, trust);
          case "cancel":
            return handleCancel(store, params.id, cwd);
          case "enable":
            return handleEnable(store, params.id, cwd, true);
          case "disable":
            return handleEnable(store, params.id, cwd, false);
          case "run_now":
            return await handleRunNow(store, runner, params.id, cwd, ctx);
          case "history":
            return handleHistory(runLedger, params.id, params.limit);
          case "trust":
            return handleTrust(store, trust, cwd);
          default:
            return textResult(`Unknown action: ${String(params.action)}`, {
              error: "unknown_action",
            });
        }
      } catch (err) {
        if (
          err instanceof ScheduleParseError ||
          err instanceof StoreError ||
          err instanceof ActionError
        ) {
          return textResult(`Error: ${err.message}`, { error: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`Error: ${message}`, { error: message });
      }
    },
  });
}

function handleCreate(
  store: ScheduleStore,
  params: {
    name?: string;
    kind?: string;
    prompt?: string;
    command?: string;
    wakeOn?: string;
    successPrompt?: string;
    failurePrompt?: string;
    timeoutMs?: number;
    once?: string;
    maxRuns?: number;
    every?: string;
    dailyAt?: string;
    scope?: ScheduleScope;
    missedWindow?: MissedWindowPolicy;
    tier?: PrivilegeTier;
  },
  cwd: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  runner: ScheduleRunner,
  trust: TrustStore,
) {
  if (!createLimiter.tryTake()) {
    return textResult(
      `Error: create rate limit (${LIMITS.maxCreatesPerMinute}/min). Slow down.`,
      { error: "rate_limited" },
    );
  }
  if (!params.name?.trim()) {
    return textResult('Error: "name" is required for create', {
      error: "name_required",
    });
  }

  const normalized = normalizeCreateAction({
    kind: params.kind,
    prompt: params.prompt,
    command: params.command,
    wakeOn: params.wakeOn,
    successPrompt: params.successPrompt,
    failurePrompt: params.failurePrompt,
    timeoutMs: params.timeoutMs,
  });

  const schedule = scheduleFromParts({
    every: params.every,
    dailyAt: params.dailyAt,
    once: params.once,
  });
  const scope: ScheduleScope = params.scope ?? defaultScope(cwd);
  const missedWindow = params.missedWindow ?? DEFAULT_MISSED_WINDOW;
  const tier: PrivilegeTier = normalized.forceTierMutate
    ? "mutate"
    : (params.tier ?? DEFAULT_TIER);
  const maxRuns = normalizeMaxRuns(params.maxRuns);

  const job = store.create({
    name: params.name,
    prompt: normalized.prompt,
    action: normalized.action,
    command: normalized.command,
    wakeOn: normalized.wakeOn,
    successPrompt: normalized.successPrompt,
    failurePrompt: normalized.failurePrompt,
    timeoutMs: normalized.timeoutMs,
    maxRuns,
    schedule,
    scope,
    projectPath: scope === "project" ? cwd : undefined,
    missedWindow,
    tier,
  });

  // Creating a job here is an explicit act in this project — trust it for
  // auto-fire. Never auto-trust from a *scheduled* turn (a fired turn must
  // not be able to unlock its own project's gate).
  if (scope === "project" && !runner.scheduledTurnActive()) {
    trust.trust(cwd);
  }

  const shellBits =
    job.action === "shell"
      ? `  command=${JSON.stringify(job.command)}  wakeOn=${job.wakeOn}`
      : "";

  notifyHighPrivilegeCreate(pi, ctx, job);

  return textResult(
    [
      `Created job ${job.id} "${job.name}" (${formatSchedule(job.schedule)}, ${job.scope}).`,
      `kind=${job.action}  tier=${job.tier}  missedWindow=${job.missedWindow}${shellBits}`,
      `Next run: ${formatRelative(job.nextRunAt)}.`,
      `Use schedule action=run_now id=${job.id} to fire immediately.`,
    ].join("\n"),
    { job },
  );
}

/**
 * P3 persistence-amplification mitigation: creating a shell or mutate job is
 * the highest-privilege act this tool offers — the job persists across
 * sessions and fires unattended (global scope: in every session). A
 * prompt-injected turn could otherwise create one silently. Surface it to the
 * human at *create* time (the fire-time notify comes after execution), on
 * every channel available: UI notify, console, and a display-only session
 * message. Never blocks — best-effort.
 */
function notifyHighPrivilegeCreate(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  job: ScheduledJob,
): void {
  const isShell = job.action === "shell";
  const isMutate = job.tier === "mutate";
  if (!isShell && !isMutate) return;

  // The notice itself must survive a hostile name/command: control chars
  // (incl. C1 8-bit CSI/OSC) could clear/reposition the terminal and conceal
  // the very warning this mitigation exists to surface. Newlines collapse so
  // the notice stays one line. JSON.stringify already escapes C0 in the
  // command display; the extra pass catches C1.
  const clean = (v: string): string =>
    // eslint-disable-next-line no-control-regex
    v
      .replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const where =
    job.scope === "global"
      ? "every future session, in any project"
      : "this project's future sessions";
  const cmd = isShell
    ? ` command=${clean(JSON.stringify(job.command))}`
    : "";
  const msg =
    `[pi-schedule] created ${isShell ? "shell (runs as mutate)" : "prompt (tier=mutate)"} job "${clean(job.name)}" ` +
    `— it will fire unattended in ${where}.${cmd} ` +
    `If you did not expect this, cancel it: schedule action=cancel id=${job.id}`;

  try {
    if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
    else console.warn(msg);
  } catch {
    /* best-effort */
  }
  try {
    pi.sendMessage?.(
      {
        customType: "pi-schedule",
        content: msg,
        display: true,
        details: { jobId: job.id, kind: "create-notice", scope: job.scope, tier: job.tier },
      },
      { triggerTurn: false },
    );
  } catch {
    /* best-effort */
  }
}

function handleList(
  store: ScheduleStore,
  cwd: string,
  trust: TrustStore,
) {
  const jobs = store.listForCwd(cwd);
  if (jobs.length === 0) {
    return textResult(
      "No scheduled jobs. Create one with action=create, name, kind (optional), prompt or command, and every or dailyAt.",
      { jobs: [] },
    );
  }
  const untrusted = jobs.filter(
    (j) => j.scope === "project" && !trust.isTrusted(j.projectPath ?? cwd),
  );
  const body = [
    "Scheduled jobs:",
    ...jobs.map((j) =>
      summarize(j) +
      (untrusted.some((u) => u.id === j.id) ? "\n  [untrusted-project — will not auto-fire; schedule action=trust]" : ""),
    ),
  ];
  if (untrusted.length > 0) {
    body.push(
      `\n${untrusted.length} project job(s) are in an untrusted project: they never auto-fire. ` +
        `Inspect .pi/schedule.json first, then run schedule action=trust to allow auto-fire.`,
    );
  }
  return textResult(body.join("\n"), { jobs });
}

function handleTrust(store: ScheduleStore, trust: TrustStore, cwd: string) {
  trust.trust(cwd);
  const projectJobs = store
    .listForCwd(cwd)
    .filter((j) => j.scope === "project");
  return textResult(
    `Trusted project ${resolve(cwd)}. ${projectJobs.length} project job(s) can now auto-fire when due. ` +
      `(Only trust projects you have inspected: .pi/schedule.json can contain shell jobs.)`,
    { trusted: resolve(cwd), projectJobs: projectJobs.length },
  );
}

function handleCancel(store: ScheduleStore, id: string | undefined, cwd: string) {
  if (!id?.trim()) {
    return textResult('Error: "id" is required for cancel', {
      error: "id_required",
    });
  }
  const removed = store.remove(id.trim(), cwd);
  if (!removed) {
    return textResult(`Job ${id} not found.`, { error: "not_found" });
  }
  return textResult(`Cancelled job ${removed.id} "${removed.name}".`, {
    job: removed,
  });
}

function handleEnable(
  store: ScheduleStore,
  id: string | undefined,
  cwd: string,
  enabled: boolean,
) {
  if (!id?.trim()) {
    return textResult(
      `Error: "id" is required for ${enabled ? "enable" : "disable"}`,
      { error: "id_required" },
    );
  }
  const job = store.setEnabled(id.trim(), cwd, enabled);
  if (!job) {
    return textResult(`Job ${id} not found.`, { error: "not_found" });
  }
  return textResult(
    `${enabled ? "Enabled" : "Disabled"} job ${job.id} "${job.name}".`,
    { job },
  );
}

async function handleRunNow(
  store: ScheduleStore,
  runner: ScheduleRunner,
  id: string | undefined,
  cwd: string,
  ctx: ExtensionContext,
) {
  if (!id?.trim()) {
    return textResult('Error: "id" is required for run_now', {
      error: "id_required",
    });
  }
  const job = store.get(id.trim(), cwd);
  if (!job) {
    return textResult(`Job ${id} not found.`, { error: "not_found" });
  }
  if (job.terminated) {
    return textResult(
      `Job ${job.id} "${job.name}" is terminated (${job.terminated}). Cancel and recreate to run again.`,
      { error: "terminated", job },
    );
  }

  const results = await runner.fireDue(ctx, {
    source: "run_now",
    jobIds: [job.id],
  });
  const updated = results[0] ?? store.get(job.id, cwd);

  // Report actual outcome — never invent "Fired" (fail-plausible in our own tool).
  if (!results.length || !updated) {
    return textResult(
      `Did not fire job ${job.id} "${job.name}": runner returned no result ` +
        `(another wave may be active, or the job became unavailable). ` +
        `Check schedule action=history id=${job.id}.`,
      { error: "not_fired", job: updated ?? job },
    );
  }

  const kind = updated.action ?? "prompt";
  switch (updated.lastStatus) {
    case "ok":
      return textResult(
        `Delivered job ${updated.id} "${updated.name}" (kind=${kind}, tier=${updated.tier}).` +
          (updated.lastShell
            ? ` shell exit=${updated.lastShell.code}.`
            : "") +
          ` Check schedule action=history id=${updated.id}.`,
        { job: updated, status: "ok" },
      );
    case "locked":
      return textResult(
        `Job ${updated.id} "${updated.name}" is locked (already running). Not delivered.`,
        { job: updated, status: "locked", error: "locked" },
      );
    case "error":
      return textResult(
        `Failed to deliver job ${updated.id} "${updated.name}": ${updated.lastError ?? "unknown error"}`,
        { job: updated, status: "error", error: updated.lastError },
      );
    case "skipped":
      return textResult(
        `Job ${updated.id} "${updated.name}" was skipped: ${updated.lastError ?? "policy"}`,
        { job: updated, status: "skipped", error: updated.lastError },
      );
    default:
      return textResult(
        `Job ${updated.id} "${updated.name}" ended with status=${String(updated.lastStatus)}. ` +
          `Check schedule action=history id=${updated.id}.`,
        { job: updated, status: updated.lastStatus },
      );
  }
}

function handleHistory(
  ledger: RunLedger,
  id: string | undefined,
  limit: number | undefined,
) {
  const rows = ledger.history({
    jobId: id?.trim() || undefined,
    limit: limit && limit > 0 ? Math.min(limit, 50) : 10,
  });
  if (rows.length === 0) {
    return textResult("No run history yet.", { runs: [] });
  }
  const lines = rows.map(
    (r) =>
      `- ${r.endedAt}  ${r.status}  ${r.jobName}(${r.jobId})` +
      (r.action ? `  kind=${r.action}` : "") +
      `  src=${r.source}` +
      (r.detail ? `  ${r.detail}` : "") +
      `  runId=${r.runId}`,
  );
  return textResult(["Run history (newest first):", ...lines].join("\n"), {
    runs: rows,
  });
}
