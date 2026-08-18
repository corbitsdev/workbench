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

/**
 * One row per message run's stage timing (CL-6257). `messageRunId` is
 * unique for the same restart-safe reason `usage_turn.turnId` is: a
 * dispatch retry after a crash must never double-count a run. Every
 * `*At` column but `receivedAt`/`replyPostedAt` is nullable — a stage
 * that never ran (a warm session skips `reactorStartAt`) is an honest
 * null, never a fabricated timestamp.
 */
export const turnLatency = insightsSchema.table(
  "turn_latency",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    messageRunId: text("message_run_id").notNull(),
    status: text("status").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    reactorStartAt: timestamp("reactor_start_at", { withTimezone: true }),
    inferenceStartAt: timestamp("inference_start_at", { withTimezone: true }),
    firstTokenAt: timestamp("first_token_at", { withTimezone: true }),
    replyPostedAt: timestamp("reply_posted_at", {
      withTimezone: true,
    }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("turn_latency_message_run_id_uidx").on(table.messageRunId),
  ],
);

export type TurnLatencyRow = typeof turnLatency.$inferSelect;
