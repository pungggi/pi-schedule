/**
 * Project trust registry.
 *
 * Security gate for project-scope jobs: a `.pi/schedule.json` that arrives
 * with a cloned repository must not auto-fire (it can carry `action: "shell"`
 * or `tier: "mutate"` rows = arbitrary code execution). Automatic waves
 * (session_start / tick) only fire project jobs whose project root is listed
 * in `~/.pi-schedule/trusted.json`.
 *
 * Trust is granted explicitly:
 *   - `schedule action=trust` in the project, or
 *   - implicitly when a job is *created* with scope=project in an interactive
 *     (non-scheduled) turn.
 *
 * `run_now` always bypasses the gate: it is an explicit agent action with the
 * privilege of its calling context (interactive turn = user-granted; a fired
 * read_only/suggest turn is already blocked from calling run_now at all).
 *
 * Fail-closed: an unreadable or corrupt trust file means "untrusted".
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const TRUST_VERSION = 1 as const;

export interface TrustedProjectsFile {
  version: 1;
  /** Normalized absolute project root → trust record. */
  projects: Record<string, { trustedAt: string }>;
}

function normalizeKey(projectRoot: string): string {
  const key = resolve(projectRoot);
  // Windows paths are case-insensitive; store/compare lowercased so a
  // differently-cased cwd still matches.
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function emptyFile(): TrustedProjectsFile {
  return { version: TRUST_VERSION, projects: {} };
}

export class TrustStore {
  constructor(private readonly filePath: string) {}

  isTrusted(projectRoot: string): boolean {
    try {
      const key = normalizeKey(projectRoot);
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return false;
      const parsed = JSON.parse(raw) as Partial<TrustedProjectsFile>;
      if (parsed.version !== TRUST_VERSION || typeof parsed.projects !== "object" || parsed.projects === null) {
        return false;
      }
      const entry = (parsed.projects as Record<string, unknown>)[key];
      return entry !== null && typeof entry === "object";
    } catch {
      return false; // missing / unreadable / corrupt → fail closed
    }
  }

  /** Trust a project root (idempotent; refreshes trustedAt). */
  trust(projectRoot: string, at: Date = new Date()): void {
    const file = this.readForWrite();
    file.projects[normalizeKey(projectRoot)] = { trustedAt: at.toISOString() };
    this.write(file);
  }

  /** Trusted project roots (normalized), for list/diagnostics. */
  list(): string[] {
    return Object.keys(this.readForWrite().projects);
  }

  /**
   * Read for writing: a corrupt file is replaced with an empty registry on
   * the next trust() (we rewrite the whole file anyway). Reads for the
   * *gate* stay fail-closed via isTrusted().
   */
  private readForWrite(): TrustedProjectsFile {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return emptyFile();
      const parsed = JSON.parse(raw) as Partial<TrustedProjectsFile>;
      if (
        parsed.version !== TRUST_VERSION ||
        typeof parsed.projects !== "object" ||
        parsed.projects === null
      ) {
        return emptyFile();
      }
      return { version: TRUST_VERSION, projects: { ...parsed.projects } };
    } catch {
      return emptyFile();
    }
  }

  private write(file: TrustedProjectsFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }
}
