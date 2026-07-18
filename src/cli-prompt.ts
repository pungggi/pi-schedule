/**
 * Detect whether the current pi process was launched with an initial user
 * prompt (e.g. `pi "check this and that"` or `pi -p "…"`).
 *
 * Only the process-start session should skip due-job firing. Later
 * session_start reasons (new / resume / fork) must not inherit argv forever.
 */

import { parseArgs } from "@earendil-works/pi-coding-agent";

/**
 * Returns true when argv contains one or more initial message/file prompts.
 * Safe to call with process.argv; swallows parse errors and treats them as
 * "no prompt" so a bad flag never blocks the extension from loading.
 */
export function hasCliInitialPrompt(argv: string[] = process.argv): boolean {
  try {
    // argv[0]=node, argv[1]=script — parseArgs wants the user args only.
    const userArgs = argv.slice(2);
    const args = parseArgs(userArgs);
    if (args.messages.length > 0) return true;
    if (args.fileArgs.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether this session_start should suppress due-job auto-fire because of
 * a CLI initial prompt.
 *
 * Only applies to reason === "startup". `/new` and `/resume` must still
 * process due jobs even if the process was originally launched with a message.
 */
export function shouldSkipDueOnSessionStart(
  reason: string,
  hasPrompt: () => boolean = hasCliInitialPrompt,
): boolean {
  return reason === "startup" && hasPrompt();
}
