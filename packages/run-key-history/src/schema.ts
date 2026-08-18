// The one table this package owns: an append-only record of every
// public key a workflow run has ever been deployed under, keyed by the
// run's own mail address. It lives in its own `run_key_history`
// Postgres schema, fully siloed from `public` — see
// docs/package-migrations.md — and never reads or writes
// `workflow_run` itself: comparing against this table's own last
// entry is what lets its listener avoid racing `@intx/hub-sessions`'
// independent `workflow_run.public_key` update on the same
// `agent.deploy.ack` event.
import { index, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const runKeyHistorySchema = pgSchema("run_key_history");

/**
 * One row per key a run address has ever carried. `supersededAt` is
 * null exactly for the currently active key on record — every other
 * row for the same `runAddress` has it set, in ascending `recordedAt`
 * order, so the row with `supersededAt IS NULL` is always the single
 * source of "what does this listener think the key is right now".
 */
export const runKeyHistory = runKeyHistorySchema.table(
  "run_key_history",
  {
    id: text("id").primaryKey(),
    runAddress: text("run_address").notNull(),
    publicKey: text("public_key").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    index("run_key_history_run_address_idx").on(table.runAddress),
    index("run_key_history_current_idx").on(
      table.runAddress,
      table.supersededAt,
    ),
  ],
);

export type RunKeyHistoryRow = typeof runKeyHistory.$inferSelect;
