// Durable redelivery-dedup for `chat-orchestrator.ts`'s finalized-turn
// write surfaces (CL-6039) — see `finalizedTurnWriteClaim`'s own doc
// comment in `./schema.ts` for the table shape and why it exists.
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
  };
}

/**
 * In-memory `WriteClaimStore`, for tests only. Deliberately constructed
 * OUTSIDE `createChatOrchestrator`/`createArtifactDeliveryHandler` and
 * handed in as a dependency, unlike `postedApprovalIds`/
 * `ingestedChannelDays` in `./chat-orchestrator.ts` (plain `Set`s
 * instantiated once per orchestrator and lost on the next one) — a test
 * can hold the same fake store across two separate orchestrator/handler
 * instances to prove a claim survives what a hub restart looks like from
 * the write surfaces' point of view, which an in-process `Set` never
 * could.
 */
export function createInMemoryWriteClaimStore(): WriteClaimStore {
  const claimed = new Set<string>();
  return {
    async tryClaim(claim) {
      const key = `${claim.tenantId}:${claim.surface}:${claim.claimKey}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}
