/**
 * Read the current session id from an extension context, defensively.
 *
 * `ExtensionContext.sessionManager.getSessionId()` is the source of truth on
 * pi builds that expose it. Older builds (or the fakes in unit tests) may not,
 * so this returns undefined rather than throwing — callers treat "no session
 * id" as "cannot do origin routing" and fall back to today's behavior.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function sessionIdOf(ctx: ExtensionContext | undefined): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}
