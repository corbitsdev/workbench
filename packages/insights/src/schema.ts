// Workbench-owned usage and pricing tables. Inference emits token
// usage on the live event stream but the platform event-collector
// deliberately drops it — this package is the product sink that
// persists those events so Insights can query real numbers.
//
// These tables live in their own `insights` Postgres schema, fully
// siloed from the platform's `public` schema — see
// docs/package-migrations.md. `tenantId` is a plain text identifier,
// not a foreign key, so referencing platform tenant/principal ids
// works identically from a named schema.
import {
  integer,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const insightsSchema = pgSchema("insights");

/**
 * One row per model-turn of inference usage. `turnId` is unique so a
 * collector restart can re-deliver the same event without double-counting.
 */
export const usageTurn = insightsSchema.table(
  "usage_turn",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    thinkingTokens: integer("thinking_tokens").notNull().default(0),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("usage_turn_turn_id_uidx").on(table.turnId)],
);

export type UsageTurnRow = typeof usageTurn.$inferSelect;

/**
 * Operator-editable static price table. A null rate means "no rate
 * known" — cost queries must return absent for that class, never a
 * fabricated zero.
 */
export const modelPrice = insightsSchema.table("model_price", {
  model: text("model").primaryKey(),
  /** USD per 1M input tokens. Null = no rate. */
  inputPerMTok: numeric("input_per_m_tok"),
  outputPerMTok: numeric("output_per_m_tok"),
  cacheReadPerMTok: numeric("cache_read_per_m_tok"),
  cacheWritePerMTok: numeric("cache_write_per_m_tok"),
  thinkingPerMTok: numeric("thinking_per_m_tok"),
});

export type ModelPriceRow = typeof modelPrice.$inferSelect;
