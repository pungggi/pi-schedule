/**
 * Structural privilege enforcement for scheduled turns.
 *
 * Uses pi's tool_call hook to block mutating tools while a read_only/suggest
 * scheduled delivery is the active agent turn (until agent_settled).
 *
 * Blocks also set `terminate: true` (pi ≥ 0.84.1): a scheduled turn that has
 * wandered off-contract into a mutating tool has no productive path inside the
 * privilege fence, so a fully-blocked batch ends the turn without a wasted
 * follow-up model call. The batch semantics protect mixed batches — if the
 * same batch also ran allowed read tools (which don't set terminate), the turn
 * continues so the agent can still report findings in text. No scheduled turn
 * active → no block, so interactive turns are unaffected. On pi < 0.84.1 the
 * extra `terminate` field is ignored and blocks behave as before.
 *
 * Critical: `schedule` is itself a mutating surface. A read_only/suggest fired
 * turn must NOT be able to persist a `kind=shell` job (or any state change),
 * because that job later fires as tier=mutate — a read_only → shell-escalation
 * vector. So mutating schedule actions (create/cancel/enable/disable/run_now)
 * are blocked under read_only and suggest. list/history stay allowed (reads).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrivilegeTier } from "./types.js";

const MUTATE_TOOLS = new Set(["edit", "write", "bash"]);
const SUGGEST_BLOCK = new Set(["bash"]); // drafts OK; shell is the high-blast tool

/** schedule actions that mutate job state / trigger fires. */
const SCHEDULE_MUTATE_ACTIONS = new Set([
  "create",
  "cancel",
  "enable",
  "disable",
  "run_now",
]);

/** True if a schedule tool_call would mutate state (vs a read like list/history). */
function isScheduleMutation(event: { toolName: string; input?: unknown }): boolean {
  if (event.toolName !== "schedule") return false;
  const action = (event.input as { action?: unknown } | undefined)?.action;
  return typeof action === "string" && SCHEDULE_MUTATE_ACTIONS.has(action);
}

export class PrivilegeGuard {
  /** Stack of active scheduled-turn tiers (supports multi-fire followUps). */
  private stack: PrivilegeTier[] = [];

  attach(pi: ExtensionAPI): void {
    pi.on("tool_call", async (event) => {
      const tier = this.stack[this.stack.length - 1];
      if (!tier || tier === "mutate") return;

      const name = event.toolName;
      const scheduleMut = isScheduleMutation(
        event as { toolName: string; input?: unknown },
      );

      if (tier === "read_only") {
        if (MUTATE_TOOLS.has(name)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=read_only`,
          };
        }
        if (scheduleMut) {
          return {
            block: true,
            reason:
              `[pi-schedule] blocked schedule ${String((event as { input?: { action?: unknown } }).input?.action)}: ` +
              `active scheduled job is tier=read_only (schedule mutations need tier=mutate; list/history are allowed)`,
            terminate: true,
          };
        }
        return;
      }
      if (tier === "suggest") {
        if (SUGGEST_BLOCK.has(name)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=suggest (no shell)`,
          };
        }
        if (scheduleMut) {
          return {
            block: true,
            reason:
              `[pi-schedule] blocked schedule ${String((event as { input?: { action?: unknown } }).input?.action)}: ` +
              `active scheduled job is tier=suggest (schedule mutations need tier=mutate)`,
            terminate: true,
          };
        }
        return;
      }
      return;
    });

    pi.on("agent_settled", async () => {
      // One settled turn completes one scheduled delivery (or user turn).
      // Pop at most one so stacked follow-ups still enforce.
      if (this.stack.length > 0) this.stack.pop();
    });
  }

  /** Call after successfully injecting a scheduled prompt. */
  enter(tier: PrivilegeTier): void {
    this.stack.push(tier);
  }

  /** Test helper / emergency clear. */
  clear(): void {
    this.stack = [];
  }

  depth(): number {
    return this.stack.length;
  }
}
