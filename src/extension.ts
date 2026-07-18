/**
 * pi-schedule — recurring tasks for pi agents.
 *
 * Reliability controls: run ledger, single-flight locks, missed-window
 * policy, privilege tiers (prompt + tool_call enforcement), fire caps.
 * See docs/RELIABILITY.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunLedger } from "./ledger.js";
import { JobLockManager } from "./lock.js";
import { PrivilegeGuard } from "./privilege.js";
import { ScheduleRunner } from "./runner.js";
import { ScheduleStore } from "./store.js";
import { registerScheduleTool } from "./tool.js";

export default function piScheduleExtension(pi: ExtensionAPI): void {
  const store = new ScheduleStore();
  const paths = store.pathsInfo();
  const ledger = new RunLedger(paths.runsFile);
  const locks = new JobLockManager(paths.lockDir);
  const privilege = new PrivilegeGuard();
  const runner = new ScheduleRunner({ store, pi, ledger, locks, privilege });

  runner.attach();
  registerScheduleTool(pi, store, runner, ledger);
}
