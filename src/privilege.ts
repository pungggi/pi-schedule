/**
 * Structural privilege enforcement for scheduled turns.
 *
 * Uses pi's tool_call hook to block mutating tools while a read_only/suggest
 * scheduled delivery is the active agent turn (until agent_settled).
 *
 * read_only is enforced **strict** (default): a known-read allowlist — any
 * tool not on it is blocked. A blocklist of core tools ({edit,write,bash})
 * cannot cover the ecosystem (terminal_*, MCP write tools, peer messaging),
 * so unknown tools fail closed. Set PI_SCHEDULE_PRIVILEGE_MODE=legacy to
 * restore the old core-tool blocklist (documented gap).
 *
 * suggest stays blocklist-based by design (edit/write are allowed there for
 * drafting), with the obvious arbitrary-exec surfaces (bash, terminal exec)
 * and peer messaging blocked.
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
/** Arbitrary-execution surfaces blocked under suggest (drafting tools stay open). */
const SUGGEST_BLOCK = new Set([
  "bash",
  "terminal_exec",
  "terminal_write",
  "terminal_write_file",
  "terminal_run",
  "terminal_start",
]);
/** Peer messaging: an injected scheduled turn must not drive other agents. */
const PEER_TOOLS = new Set(["agent_send", "agent_request"]);

/**
 * Tools allowed under tier=read_only in strict mode (the default).
 *
 * Deliberately excludes:
 * - `mcp` — the gateway executes arbitrary registered MCP tools; a name-level
 *   allow cannot tell a read from a write there
 * - every mutating/exec surface (fail closed for unknown names)
 */
export const READ_ONLY_ALLOW_TOOLS: ReadonlySet<string> = new Set([
  // core pi read/search
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "list",
  // research
  "web_search",
  "web_read",
  // semantic code search
  "auggie_codebase-retrieval",
  "codebase-retrieval",
  // session info / display / read-only terminal
  "list_peers",
  "show_file",
  "show_image",
  "terminal_read",
  "terminal_list",
  "terminal_wait",
]);

/** Enforcement mode for tier=read_only. strict = allowlist (default), legacy = core blocklist. */
export function privilegeMode(): "strict" | "legacy" {
  return process.env["PI_SCHEDULE_PRIVILEGE_MODE"] === "legacy"
    ? "legacy"
    : "strict";
}

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
      const lower = name.toLowerCase();
      const scheduleMut = isScheduleMutation(
        event as { toolName: string; input?: unknown },
      );

      if (tier === "read_only") {
        if (scheduleMut) {
          return {
            block: true,
            reason:
              `[pi-schedule] blocked schedule ${String((event as { input?: { action?: unknown } }).input?.action)}: ` +
              `active scheduled job is tier=read_only (schedule mutations need tier=mutate; list/history are allowed)`,
            terminate: true,
          };
        }
        if (MUTATE_TOOLS.has(lower)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=read_only`,
          };
        }
        if (PEER_TOOLS.has(lower)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=read_only (peer messaging can drive other agents)`,
          };
        }
        if (
          privilegeMode() === "strict" &&
          lower !== "schedule" &&
          !READ_ONLY_ALLOW_TOOLS.has(lower)
        ) {
          return {
            block: true,
            terminate: true,
            reason:
              `[pi-schedule] blocked ${name}: active scheduled job is tier=read_only, and ` +
              `${name} is not on the read-only allowlist (unknown tools fail closed). ` +
              `Set PI_SCHEDULE_PRIVILEGE_MODE=legacy to relax to the core-tool blocklist.`,
          };
        }
        return;
      }
      if (tier === "suggest") {
        if (SUGGEST_BLOCK.has(lower)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=suggest (no shell/exec)`,
          };
        }
        if (PEER_TOOLS.has(lower)) {
          return {
            block: true,
            terminate: true,
            reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=suggest (peer messaging can drive other agents)`,
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
      // Host invariant: pi fires exactly one `agent_settled` per agent turn
      // (scheduled fire OR interactive user turn), one turn at a time. So one
      // settle pops at most one scheduled tier. If the invariant ever breaks
      // (double/no settle on a future pi build), enter() caps growth at
      // MAX_DEPTH as a safety valve.
      if (this.stack.length > 0) this.stack.pop();
    });
  }

  /**
   * Defensive ceiling. The stack should mirror in-flight scheduled turns
   * (depth > 1 only for stacked follow-ups). If it grows past this, the host
   * invariant — exactly one `agent_settled` per fired turn — is not holding
   * (settles not firing, or firing without a matching enter). Trim oldest-first
   * so a leaked read_only/suggest can't pin privilege indefinitely.
   */
  private static readonly MAX_DEPTH = 16;

  /** Call after successfully injecting a scheduled prompt. */
  enter(tier: PrivilegeTier): void {
    while (this.stack.length >= PrivilegeGuard.MAX_DEPTH) {
      this.stack.shift();
    }
    this.stack.push(tier);
  }

  /** Test hook / emergency clear. */
  clear(): void {
    this.stack = [];
  }

  depth(): number {
    return this.stack.length;
  }
}
