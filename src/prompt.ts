/**
 * Isolated fire-prompt contract.
 *
 * Goal: reduce fail-plausible / goal-drift by giving each scheduled fire a
 * clean, labeled payload with privilege + verification instructions.
 */

import { formatSchedule } from "./schedule.js";
import { tierContract } from "./policy.js";
import type { FireSource, PrivilegeTier, ScheduledJob } from "./types.js";

export interface FirePromptInput {
  job: ScheduledJob;
  runId: string;
  source: FireSource;
  forced?: boolean;
}

/**
 * Build the user message injected when a job fires.
 * Kept pure for tests.
 */
export function buildFirePrompt(input: FirePromptInput): string {
  const { job, runId, source, forced } = input;
  const tier: PrivilegeTier = job.tier ?? "read_only";
  const schedule = formatSchedule(job.schedule);
  const kind = forced ? "force-run" : source;

  return [
    `[scheduled-task]`,
    `runId: ${runId}`,
    `jobId: ${job.id}`,
    `name: ${job.name}`,
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
