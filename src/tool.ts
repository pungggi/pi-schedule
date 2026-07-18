/**
 * Agent-facing `schedule` tool.
 *
 * Actions: create | list | cancel | enable | disable | run_now | history
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
  ] as const),
  name: Type.Optional(Type.String({ description: "Job name (create)" })),
  prompt: Type.Optional(
    Type.String({
      description:
        "Task prompt injected as a user message when due (create). Be specific.",
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
  /** Privilege tier for the fire prompt: read_only (default) | suggest | mutate */
  tier: Type.Optional(
    StringEnum(["read_only", "suggest", "mutate"] as const),
  ),
  id: Type.Optional(Type.String({ description: "Job id" })),
  /** history: max rows (default 10) */
  limit: Type.Optional(Type.Number({ description: "history limit" })),
});

const createLimiter = new CreateRateLimiter();

function summarize(job: ScheduledJob, now: Date = new Date()): string {
  const state = job.enabled ? "on" : "off";
  const next = formatRelative(job.nextRunAt, now);
  const last = job.lastRunAt ? formatRelative(job.lastRunAt, now) : "never";
  return [
    `- ${job.id}  ${job.name}  [${state}/${job.scope}/${job.tier}]`,
    `  schedule: ${formatSchedule(job.schedule)}  missedWindow: ${job.missedWindow}`,
    `  next: ${next}  last: ${last}  runs: ${job.runCount}` +
      (job.lastStatus ? `  lastStatus: ${job.lastStatus}` : ""),
    `  prompt: ${truncate(job.prompt, 120)}`,
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
): void {
  const runLedger = ledger ?? new RunLedger(store.pathsInfo().runsFile);

  pi.registerTool({
    name: "schedule",
    label: "Schedule",
    description:
      "Manage recurring agent tasks (security review, version checks, status polls). " +
      "Actions: create, list, cancel, enable, disable, run_now, history. " +
      'Schedules: every "30m"/"2h"/"1d" or dailyAt "09:00". ' +
      "Defaults: tier=read_only, missedWindow=catch_up_one. " +
      "Due jobs fire on session start (unless pi was launched with an initial prompt) " +
      "and while the session is open. See package docs/RELIABILITY.md.",
    parameters: ScheduleParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;

      try {
        switch (params.action) {
          case "create":
            return handleCreate(store, params, cwd);
          case "list":
            return handleList(store, cwd);
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
          default:
            return textResult(`Unknown action: ${String(params.action)}`, {
              error: "unknown_action",
            });
        }
      } catch (err) {
        if (err instanceof ScheduleParseError || err instanceof StoreError) {
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
    prompt?: string;
    every?: string;
    dailyAt?: string;
    scope?: ScheduleScope;
    missedWindow?: MissedWindowPolicy;
    tier?: PrivilegeTier;
  },
  cwd: string,
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
  if (!params.prompt?.trim()) {
    return textResult('Error: "prompt" is required for create', {
      error: "prompt_required",
    });
  }

  const schedule = scheduleFromParts({
    every: params.every,
    dailyAt: params.dailyAt,
  });
  const scope: ScheduleScope = params.scope ?? defaultScope(cwd);
  const missedWindow = params.missedWindow ?? DEFAULT_MISSED_WINDOW;
  const tier = params.tier ?? DEFAULT_TIER;

  const job = store.create({
    name: params.name,
    prompt: params.prompt,
    schedule,
    scope,
    projectPath: scope === "project" ? cwd : undefined,
    missedWindow,
    tier,
  });

  return textResult(
    [
      `Created job ${job.id} "${job.name}" (${formatSchedule(job.schedule)}, ${job.scope}).`,
      `tier=${job.tier}  missedWindow=${job.missedWindow}`,
      `Next run: ${formatRelative(job.nextRunAt)}.`,
      `Use schedule action=run_now id=${job.id} to fire immediately.`,
    ].join("\n"),
    { job },
  );
}

function handleList(store: ScheduleStore, cwd: string) {
  const jobs = store.listForCwd(cwd);
  if (jobs.length === 0) {
    return textResult(
      "No scheduled jobs. Create one with action=create, name, prompt, and every or dailyAt.",
      { jobs: [] },
    );
  }
  const body = ["Scheduled jobs:", ...jobs.map((j) => summarize(j))].join("\n");
  return textResult(body, { jobs });
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

  switch (updated.lastStatus) {
    case "ok":
      return textResult(
        `Delivered job ${updated.id} "${updated.name}". Isolated prompt injected ` +
          `(tier=${updated.tier}). Check schedule action=history id=${updated.id}.`,
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
      `- ${r.endedAt}  ${r.status}  ${r.jobName}(${r.jobId})  src=${r.source}` +
      (r.detail ? `  ${r.detail}` : "") +
      `  runId=${r.runId}`,
  );
  return textResult(["Run history (newest first):", ...lines].join("\n"), {
    runs: rows,
  });
}
