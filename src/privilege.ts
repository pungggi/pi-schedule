/**
 * Structural privilege enforcement for scheduled turns.
 *
 * Uses pi's tool_call hook to block mutating tools while a read_only/suggest
 * scheduled delivery is the active agent turn (until agent_settled).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrivilegeTier } from "./types.js";

const MUTATE_TOOLS = new Set(["edit", "write", "bash"]);
const SUGGEST_BLOCK = new Set(["bash"]); // drafts OK; shell is the high-blast tool

export class PrivilegeGuard {
  /** Stack of active scheduled-turn tiers (supports multi-fire followUps). */
  private stack: PrivilegeTier[] = [];

  attach(pi: ExtensionAPI): void {
    pi.on("tool_call", async (event) => {
      const tier = this.stack[this.stack.length - 1];
      if (!tier || tier === "mutate") return;

      const name = event.toolName;
      if (tier === "read_only" && MUTATE_TOOLS.has(name)) {
        return {
          block: true,
          reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=read_only`,
        };
      }
      if (tier === "suggest" && SUGGEST_BLOCK.has(name)) {
        return {
          block: true,
          reason: `[pi-schedule] blocked ${name}: active scheduled job is tier=suggest (no shell)`,
        };
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
