// One-in-flight-turn-per-workbench claims (CL-6331) — the same
// tryClaim/release shape `./write-claims.ts` proved out for
// `chat-orchestrator.ts`'s finalized-turn writes, reused here for a
// different resource: not "has this write already happened" but "is a
// turn already running for this workbench." A claim means "won the
// right to run the next turn", not "the turn finished successfully" —
// `tryClaim` alone can't tell the difference, exactly as write-claims'
// own doc comment notes for its case.
//
// This is deliberately its own store rather than a new
// `WriteClaimSurface` on `finalizedTurnWriteClaim`: that table is a
// durable de-dup ledger scoped to redelivered *writes*, with no notion
// of "this claim has been held too long, let something else through."
// A turn claim is process-local, in-memory state (see
// `./turn-queue.ts`'s own note on why "completion" here means "the
// dispatch call this seam makes settled", not "the agent's turn
// actually finished") and needs exactly that TTL escape hatch, so it
// is its own small store built to the same interface shape rather than
// a table this repo would otherwise have to bend to fit.
export type TurnClaim = {
  readonly workbenchId: string;
};

export type TurnClaimStore = {
  /**
   * Atomically claims `workbenchId`: `true` if this call won the claim
   * (the caller should run the next turn), `false` if a turn is
   * already in flight for this workbench (the caller must queue
   * instead, never dispatch).
   */
  tryClaim(claim: TurnClaim): Promise<boolean>;
  /**
   * Un-claims `workbenchId` — called once the turn that won the claim
   * has settled, success or failure alike, so the next queued batch (or
   * a fresh message) can run. Never left un-called on a path that can
   * still complete; the TTL below is only the backstop for a dispatch
   * that never settles at all.
   */
  release(claim: TurnClaim): Promise<void>;
};

/**
 * How long one agent turn may run before the room stops waiting on it.
 * One number, two enforcement points that must never drift: the section
 * body's own per-occurrence `timeout` (CL-6329, pinned into a room
 * agent's deployed definition by `./platform-adapter.ts`) and the claim
 * TTL that stops a workbench wedging behind a dispatch that never
 * settles.
 */
export const CHAT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * In-memory `TurnClaimStore`, with a TTL escape hatch: a claim older
 * than `ttlMs` is treated as available again even if `release` was
 * never called. This is the honest interim this seam can offer today —
 * `dispatchTurn` (`./workbench-service.ts`) only reaches "the mail was
 * handed to the agent's mailbox", not "the agent's turn finished", so
 * there is no outcome to observe here for the real turn hanging or the
 * process that ran it dying mid-turn. `release` still fires the moment
 * the dispatch call itself settles (the one outcome this seam *can*
 * see), and the TTL exists only to stop a workbench from wedging
 * forever behind a dispatch that never settles at all.
 */
export function createInMemoryTurnClaimStore(options: {
  readonly ttlMs: number;
  readonly now?: () => number;
}): TurnClaimStore {
  const now = options.now ?? Date.now;
  const claimedAt = new Map<string, number>();
  return {
    async tryClaim(claim) {
      const existing = claimedAt.get(claim.workbenchId);
      if (existing !== undefined && now() - existing < options.ttlMs) {
        return false;
      }
      claimedAt.set(claim.workbenchId, now());
      return true;
    },
    async release(claim) {
      claimedAt.delete(claim.workbenchId);
    },
  };
}
