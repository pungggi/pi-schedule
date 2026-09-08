/**
 * Conservative secret redaction for *persisted* shell output.
 *
 * Scope: `lastShell.stdout/stderr` land in `schedules.json` on disk, where
 * they outlive the session and are readable by any agent/user with home-dir
 * access. Scheduled shell commands routinely echo credentials (CI tokens in
 * URLs, `Authorization` headers, package-registry output). These patterns
 * redact the common shapes before persistence.
 *
 * Deliberately conservative: only well-known token shapes and explicit
 * key/token/secret/password assignments are touched; free text is left alone.
 * The transient copies (follow-up prompt, session message) keep full output —
 * the agent needs it for the task, and it lives only in session context.
 *
 * NOT covered (documented): secrets embedded in the command string itself —
 * the command must stay verbatim to be re-runnable; do not put secrets in
 * `command` (see README).
 */

/** Well-known credential shapes (GitHub, OpenAI, Slack, AWS, Google, npm, JWTs). */
const KNOWN_TOKEN_SHAPES =
  /\b(?:ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

/** Bearer authorization headers. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

/** Explicit assignments: api_key=…, "token": "…", password: …, etc. */
const ASSIGNMENT =
  /\b((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(["']?)[^\s"',;\\]{8,}\2/gi;

/** Redact common credential shapes from text destined for disk. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(BEARER, "$1[REDACTED]")
    .replace(ASSIGNMENT, "$1$2[REDACTED]$2")
    .replace(KNOWN_TOKEN_SHAPES, "[REDACTED]");
}
