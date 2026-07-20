/**
 * Isolated fire-prompt contract.
 *
 * Goal: reduce fail-plausible / goal-drift by giving each scheduled fire a
 * clean, labeled payload with privilege + verification instructions.
 */

import { formatSchedule } from "./schedule.js";
import { tierContract } from "./policy.js";
import type {
  FireSource,
  PrivilegeTier,
  ScheduledJob,
  ShellRunResult,
} from "./types.js";

export interface FirePromptInput {
  job: ScheduledJob;
  runId: string;
  source: FireSource;
  forced?: boolean;
}

/**
 * Build the user message injected when a prompt job fires.
 * Kept pure for tests.
 */
export function buildFirePrompt(input: FirePromptInput): string {
  const { job, runId, source, forced } = input;
  const tier: PrivilegeTier = job.tier ?? "read_only";
  const schedule = formatSchedule(job.schedule);
  const kind = forced ? "force-run" : source;
  const action = job.action ?? "prompt";

  return [
    `[scheduled-task]`,
    `runId: ${runId}`,
    `jobId: ${job.id}`,
    `name: ${job.name}`,
    `action: ${action}`,
    `schedule: ${schedule}`,
    `source: ${kind}`,
    `tier: ${tier}`,
    ``,
    `## Task`,
    job.prompt.trim(),
    ``,
    `## Contract`,
    `- This is an isolated scheduled run. Focus only on this task.`,
    `- If tools fail or data is missing, report the failure; do NOT invent findings.`,
    `- If there is nothing actionable, say so explicitly (e.g. "No findings").`,
    `- Prefer evidence (paths, commands, versions, links) over unsupported claims.`,
    `- Do not create, cancel, or modify other schedules unless this task explicitly requires it.`,
    tierContract(tier),
  ].join("\n");
}

export interface ShellFollowUpInput {
  job: ScheduledJob;
  runId: string;
  source: FireSource;
  forced?: boolean;
  result: ShellRunResult;
  instruction: string;
}

/**
 * Build the agent wake-up message after a scheduled shell command.
 */
export function buildShellFollowUpPrompt(input: ShellFollowUpInput): string {
  const { job, runId, source, forced, result, instruction } = input;
  const tier: PrivilegeTier = job.tier ?? "mutate";
  const schedule = formatSchedule(job.schedule);
  const kind = forced ? "force-run" : source;
  const status = result.ok ? "success" : "failure";

  return [
    `[scheduled-task]`,
    `runId: ${runId}`,
    `jobId: ${job.id}`,
    `name: ${job.name}`,
    `action: shell`,
    `schedule: ${schedule}`,
    `source: ${kind}`,
    `tier: ${tier}`,
    `shellStatus: ${status}`,
    `exitCode: ${result.code}`,
    `killed: ${result.killed}`,
    ``,
    `## Scheduled command`,
    "```",
    result.command,
    "```",
    `cwd: ${result.cwd}`,
    `timeoutMs: ${result.timeoutMs}`,
    ``,
    `## stdout`,
    "```",
    result.stdout.trim() || "(empty)",
    "```",
    ``,
    `## stderr`,
    "```",
    result.stderr.trim() || "(empty)",
    "```",
    ``,
    `## Instruction`,
    instruction.trim(),
    ``,
    `## Contract`,
    `- This is an isolated scheduled run after a shell action. Focus only on this result.`,
    `- If tools fail or data is missing, report the failure; do NOT invent findings.`,
    `- If there is nothing actionable, say so explicitly (e.g. "No findings").`,
    `- Prefer evidence (paths, commands, versions, links) over unsupported claims.`,
    `- Do not create, cancel, or modify other schedules unless this task explicitly requires it.`,
    tierContract(tier),
  ].join("\n");
}

/** Compact notify / list label for a job. */
export function notifyLabel(job: ScheduledJob): string {
  const body = job.prompt.trim() || job.name;
  return `[pi-schedule] ${job.name}: ${body}`;
}
