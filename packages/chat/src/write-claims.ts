// Durable redelivery-dedup for `chat-orchestrator.ts`'s finalized-turn
// write surfaces (CL-6039) — see `finalizedTurnWriteClaim`'s own doc
// comment in `./schema.ts` for the table shape and why it exists.
//
// A claim means "won the right to attempt the write", not "the write
// succeeded" — `tryClaim` alone can't tell the difference. Every call
// site in `./chat-orchestrator.ts` therefore wraps its write in a
// try/catch that calls `release` on any throw, before its own
// log-and-drop catch runs: a write that fails un-claims itself so a
// redelivery can retry it, rather than the claim silently outliving a
// write that never happened. The residual gap this can't close: a
// process that dies between winning a claim and either finishing the
// write or reaching that catch block leaves a claimed-but-unwritten row
// behind — there is no sweep here to notice and re-open one of these,
// so that one entry is lost silently until a human does.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { finalizedTurnWriteClaim } from "./schema";

export type WriteClaimSurface = "memory" | "artifact" | "digest";

export type WriteClaim = {
  readonly tenantId: string;
  readonly surface: WriteClaimSurface;
  readonly claimKey: string;
};

export type WriteClaimStore = {
  /**
   * Atomically claims `(tenantId, surface, claimKey)`: `true` if this
   * call won the claim (the caller should proceed with its one write),
   * `false` if it was already claimed (an earlier delivery, or the
   * winner of a race with this very call — the caller must skip its
   * write either way).
   */
  tryClaim(claim: WriteClaim): Promise<boolean>;
  /**
   * Un-claims `(tenantId, surface, claimKey)` — called only when the
   * write this claim was won for then failed, so a later redelivery
   * sees no claim and retries it. Never called after a successful
   * write: a released claim and a never-attempted claim are
   * indistinguishable to `tryClaim`, which is exactly the point.
   */
  release(claim: WriteClaim): Promise<void>;
};

export type WriteClaimDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/**
 * Production store over `finalizedTurnWriteClaim`. A single atomic
 * `INSERT ... ON CONFLICT DO NOTHING`, never a select-then-branch: two
 * redelivered events racing this call both attempt the insert, Postgres
 * serializes them at the row lock, and the loser gets an empty
 * `returning()` rather than a thrown PK-violation — the same fix
 * `createDrizzleReactionStore` (`./reactions.ts`) uses for
 * `toggleReaction`.
 */
export function createDrizzleWriteClaimStore<
  TSchema extends Record<string, unknown>,
>(db: WriteClaimDb<TSchema>): WriteClaimStore {
  return {
    async tryClaim(claim) {
      const inserted = await db
        .insert(finalizedTurnWriteClaim)
        .values({
          tenantId: claim.tenantId,
          surface: claim.surface,
          claimKey: claim.claimKey,
        })
        .onConflictDoNothing({
          target: [
            finalizedTurnWriteClaim.tenantId,
            finalizedTurnWriteClaim.surface,
            finalizedTurnWriteClaim.claimKey,
          ],
        })
        .returning({ claimKey: finalizedTurnWriteClaim.claimKey });

      return inserted.length > 0;
    },
    async release(claim) {
      await db
        .delete(finalizedTurnWriteClaim)
        .where(
          and(
            eq(finalizedTurnWriteClaim.tenantId, claim.tenantId),
            eq(finalizedTurnWriteClaim.surface, claim.surface),
            eq(finalizedTurnWriteClaim.claimKey, claim.claimKey),
          ),
        );
    },
  };
}

/**
 * In-memory `WriteClaimStore`, for tests only. Deliberately constructed
 * OUTSIDE `createChatOrchestrator`/`createArtifactDeliveryHandler` and
 * handed in as a dependency, unlike `postedApprovalIds`/
 * `ingestedWorkbenchDays` in `./chat-orchestrator.ts` (plain `Set`s
 * instantiated once per orchestrator and lost on the next one) — a test
 * can hold the same fake store across two separate orchestrator/handler
 * instances to prove a claim survives what a hub restart looks like from
 * the write surfaces' point of view, which an in-process `Set` never
 * could.
 */
export function createInMemoryWriteClaimStore(): WriteClaimStore {
  const claimed = new Set<string>();
  const keyOf = (claim: WriteClaim) =>
    `${claim.tenantId}:${claim.surface}:${claim.claimKey}`;
  return {
    async tryClaim(claim) {
      const key = keyOf(claim);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    async release(claim) {
      claimed.delete(keyOf(claim));
    },
  };
}
