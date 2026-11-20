/**
 * Origin-first delivery ladder — the pure decision that keeps a scheduled job
 * from barging into an arbitrary session when several are open on a project.
 *
 * A due job is evaluated independently inside every live session. This
 * function tells one session what role it should play for that job, using
 * only inputs every session can compute identically (its own id, the job's
 * recorded origin, and the shared live-session set). The runner still holds a
 * single-flight lock as the race backstop; this decision governs *intent*.
 *
 * Ladder:
 *  1. Origin session alive  → that session delivers a full agent turn;
 *                             every other session defers.
 *  2. Origin gone, lone session → full turn (a single session is never the
 *                             confusing case, so it keeps today's behavior).
 *  3. Origin gone, many sessions → deterministically elect one owner (the
 *                             lexicographically smallest live id) which emits
 *                             a NOTIFY (no surprise turn); the rest defer.
 *
 * Determinism matters: because every session sorts the same live set, they
 * all agree on the owner, so at most one session acts even before the lock.
 */
export type DeliveryRole = "turn" | "notify" | "defer";

export interface DeliveryDecisionInput {
  /** The evaluating session's own id. */
  selfSessionId: string;
  /** The session that created the job, if recorded (legacy rows omit it). */
  originSessionId?: string | null;
  /** Live session ids sharing this job's scope. Self is treated as alive. */
  aliveSessionIds: string[];
}

export function decideDelivery(input: DeliveryDecisionInput): DeliveryRole {
  const { selfSessionId, originSessionId } = input;

  // Self is always alive — presence may not have recorded it yet.
  const alive = new Set(input.aliveSessionIds);
  alive.add(selfSessionId);

  const originAlive = Boolean(originSessionId) && alive.has(originSessionId as string);
  if (originAlive) {
    return selfSessionId === originSessionId ? "turn" : "defer";
  }

  // Origin absent/dead.
  if (alive.size <= 1) {
    return "turn"; // lone session — not confusing, keep the full turn
  }

  const owner = [...alive].sort()[0];
  return selfSessionId === owner ? "notify" : "defer";
}
