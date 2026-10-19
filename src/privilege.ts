/**
 * Structural privilege enforcement for scheduled turns.
 *
 * Uses pi's tool_call hook to block mutating tools while a read_only/suggest
 * scheduled delivery is the active agent turn.
 *
 * Fence window (v0.5): the fence activates when the fire prompt itself
 * becomes the active user message (`message_start` of the
 * `[scheduled-task]\nrunId: …` header) and deactivates when the agent run
 * settles (`agent_settled`) or a non-scheduled user message takes over the
 * loop. It does NOT activate at delivery time: registering at send time
 * fenced the tail of the calling interactive turn (a mid-turn `run_now`
 * blocked — and terminate-ended — the caller's own bash), and because pi
 * emits exactly ONE `agent_settled` per agent RUN (one `prompt()` plus all
 * its drained followUp continuations), a per-delivery stack leaked N−1 tiers
 * on every multi-fire wave, pinning read_only session-wide.
 *
 * Activation is keyed by runId, matched against deliveries this session
 * actually registered — a hand-typed `[scheduled-task]` message cannot
 * escalate anything (it can only suppress a stale fence, i.e. relax toward
 * the interactive default).
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
 * active → no block, so interactive turns are unaffected.
 *
 * Critical: `schedule` is itself a mutating surface. A read_only/suggest fired
 * turn must NOT be able to persist a `kind=shell` job (or any state change),
 * because that job later fires as tier=mutate — a read_only → shell-escalation
 * vector. So mutating schedule actions (create/cancel/enable/disable/run_now/trust)
 * are blocked under read_only and suggest. list/history stay allowed (reads).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { firePromptRunId } from "./prompt.js";
import type { FireCompletionMeta, PrivilegeTier } from "./types.js";

const MUTATE_TOOLS = new Set(["edit", "write", "bash"]);
/** Arbitrary-execution surfaces blocked under suggest (drafting tools stay open). */
const SUGGEST_BLOCK = new Set([
  "bash",
  "terminal_exec",
  "terminal_write",
  "terminal_write_file",
  "terminal_run",
  "terminal_start",
  "terminal_tools", // loader: activates terminal_retry/terminal_diff etc., which run caller-supplied commands
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

/** schedule actions that mutate job state / trigger fires / grant trust. */
const SCHEDULE_MUTATE_ACTIONS = new Set([
  "create",
  "cancel",
  "enable",
  "disable",
  "run_now",
  "trust",
]);

/** True if a schedule tool_call would mutate state (vs a read like list/history). */
function isScheduleMutation(event: { toolName: string; input?: unknown }): boolean {
  const action = (event.input as { action?: unknown } | undefined)?.action;
  return (
    event.toolName === "schedule" &&
    typeof action === "string" &&
    SCHEDULE_MUTATE_ACTIONS.has(action)
  );
}

/** A fire that was delivered but whose prompt has not started a turn yet. */
interface PendingFire {
  tier: PrivilegeTier;
  meta?: FireCompletionMeta;
  registeredAt: number;
}

/** Delivered to {@link PrivilegeGuard.onFireSettled} when a fired turn's run settles. */
export interface SettledFire {
  runId: string;
  tier: PrivilegeTier;
  meta?: FireCompletionMeta;
}

/** Max pending registrations (delivered, turn not started yet). Safety valve. */
export const MAX_PENDING = 32;
/** Pending registrations older than this are pruned (fire never started: cleared queue, dead session). */
export const PENDING_TTL_MS = 10 * 60_000;

/** Extract the prompt text from a user message content (string or content parts). */
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (
      p &&
      typeof p === "object" &&
      (p as { type?: string }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
    ) {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export class PrivilegeGuard {
  /** Delivered, awaiting their prompt's `message_start`. Keyed by runId. */
  private pending = new Map<string, PendingFire>();
  /** Fires whose prompt started a turn this agent run. Keyed by runId. */
  private active = new Map<string, PendingFire>();
  /**
   * True after a non-scheduled user message started a turn: interactive
   * input drives the loop now, so the fence stands down even though the
   * fired run has not settled yet (completion accounting still waits for
   * `agent_settled`). A later fire `message_start` re-arms the fence.
   */
  private suppressed = false;
  /** Optional completion-accounting hook (runner appends the ledger row). */
  onFireSettled?: (fire: SettledFire) => void;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  attach(pi: ExtensionAPI): void {
    pi.on("tool_call", async (event) => {
      const tier = this.fenceTier();
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

    // Fence activation: the fire prompt itself becomes the active user
    // message. Real user prompts have role "user"; pi-schedule's own custom
    // messages (notify/shell transcripts) carry role "custom" and are ignored,
    // so they neither arm nor suppress the fence.
    pi.on("message_start", async (event) => {
      const message = (
        event as { message?: { role?: unknown; content?: unknown } }
      ).message;
      if (!message || message.role !== "user") return;

      const runId = firePromptRunId(userMessageText(message.content));
      const fire = runId ? this.pending.get(runId) : undefined;
      if (fire && runId) {
        this.pending.delete(runId);
        this.active.set(runId, fire);
        this.suppressed = false; // our fire drives the loop again
        return;
      }
      // Any other user message takes over the loop → stand the fence down.
      // (Also covers a [scheduled-task]-shaped message we did not deliver:
      // transcript replay or hand-typed — it gets interactive privileges.)
      this.suppressed = true;
    });

    pi.on("agent_settled", async () => {
      // pi fires exactly one agent_settled per agent RUN (a prompt() plus all
      // drained followUp continuations), so a run may carry several fired
      // turns — emit a completion event for each, then clear the fence.
      if (this.active.size > 0 && this.onFireSettled) {
        for (const [runId, fire] of this.active) {
          try {
            this.onFireSettled({ runId, tier: fire.tier, meta: fire.meta });
          } catch {
            // completion accounting is best-effort; never break the settle path
          }
        }
      }
      this.active.clear();
      this.suppressed = false;
      this.prunePending();
    });
  }

  /**
   * Register a delivered fire. The fence arms only when this runId's prompt
   * actually starts a turn (message_start) — never at delivery time, so the
   * calling interactive turn (e.g. the turn that called run_now) is unaffected.
   */
  register(runId: string, tier: PrivilegeTier, meta?: FireCompletionMeta): void {
    this.prunePending();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(runId, { tier, meta, registeredAt: this.now() });
  }

  /** Drop registrations that never started a turn within the TTL. */
  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [runId, fire] of this.pending) {
      if (fire.registeredAt < cutoff) this.pending.delete(runId);
    }
  }

  /** Tier of the most recently started fire, or null when the fence is down. */
  fenceTier(): PrivilegeTier | null {
    if (this.suppressed || this.active.size === 0) return null;
    let tier: PrivilegeTier | null = null;
    // Map iterates in start order; the last-started fire drives the current turn.
    for (const fire of this.active.values()) tier = fire.tier;
    return tier;
  }

  /** True while a scheduled fire is the active turn (privilege fence armed). */
  fenceActive(): boolean {
    return this.fenceTier() !== null;
  }

  /** Number of delivered fires whose prompt has not started a turn yet. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Number of fires whose turn started in the current (unsettled) agent run. */
  activeFireCount(): number {
    return this.active.size;
  }

  /** Test hook / emergency clear. */
  clear(): void {
    this.pending.clear();
    this.active.clear();
    this.suppressed = false;
  }
}
