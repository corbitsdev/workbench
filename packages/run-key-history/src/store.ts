// Persistence for `run_key_history`, kept apart from the listener that
// drives it so the transaction shape is unit-testable without a real
// event bus. `RunKeyHistoryStore` is the seam; `createDrizzleRunKeyHistoryStore`
// is its production implementation over `./schema.ts`.
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runKeyHistory } from "./schema";

/**
 * The drizzle handle `createDrizzleRunKeyHistoryStore` operates
 * against. Generic over the host's schema record, the same shape
 * other packages' own drizzle handles use — the host hands in its own
 * `drizzle(sql, { schema })` instance unchanged, and no cast is
 * needed at the call site.
 */
export type RunKeyHistoryDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface RunKeyHistoryStore {
  /**
   * Records an observed `(runAddress, publicKey)` pair from an
   * `agent.deploy.ack`. Compares only against this table's own current
   * entry for `runAddress` — never `workflow_run` — so it never races
   * `@intx/hub-sessions`' independent write to that row on the same
   * event. A first sighting inserts one current entry; an unchanged
   * key no-ops; a changed key supersedes the old current entry and
   * inserts a new one, atomically.
   */
  recordObservedKey(runAddress: string, publicKey: string): Promise<void>;
  /** The row with `supersededAt === null` for `runAddress`, or `null`
   * if this address has never been observed. Test/inspection seam. */
  getCurrent(runAddress: string): Promise<{ publicKey: string } | null>;
}

function newRowId(): string {
  return `rkh_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createDrizzleRunKeyHistoryStore<
  TSchema extends Record<string, unknown>,
>(db: RunKeyHistoryDb<TSchema>): RunKeyHistoryStore {
  return {
    async recordObservedKey(runAddress, publicKey) {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(runKeyHistory)
          .where(
            and(
              eq(runKeyHistory.runAddress, runAddress),
              isNull(runKeyHistory.supersededAt),
            ),
          )
          .limit(1);

        if (current === undefined) {
          await tx.insert(runKeyHistory).values({
            id: newRowId(),
            runAddress,
            publicKey,
            recordedAt: new Date(),
            supersededAt: null,
          });
          return;
        }

        if (current.publicKey === publicKey) return;

        const now = new Date();
        await tx
          .update(runKeyHistory)
          .set({ supersededAt: now })
          .where(eq(runKeyHistory.id, current.id));
        await tx.insert(runKeyHistory).values({
          id: newRowId(),
          runAddress,
          publicKey,
          recordedAt: now,
          supersededAt: null,
        });
      });
    },

    async getCurrent(runAddress) {
      const [row] = await db
        .select()
        .from(runKeyHistory)
        .where(
          and(
            eq(runKeyHistory.runAddress, runAddress),
            isNull(runKeyHistory.supersededAt),
          ),
        )
        .limit(1);
      return row === undefined ? null : { publicKey: row.publicKey };
    },
  };
}
