// Workbench-owned eval-run history: one row per (eval, config) run,
// carrying the whole step/scorer transcript as JSONB rather than a
// fully normalized shape — a run result is written once and read back
// whole (by the CLI reporter, and eventually a read route), never
// queried per-scorer, so normalizing it into more tables would only
// add join cost with no query this package needs.
//
// This table lives in its own `evals` Postgres schema, fully siloed
// from the platform's `public` schema — see docs/package-migrations.md.
// `id` is this package's own id, not a workflow_run id: one eval run
// can (and for a live config, does) drive many workflow runs across
// its steps.
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const evalsSchema = pgSchema("evals");

export const evalRun = evalsSchema.table("run", {
  id: text("id").primaryKey(),
  evalName: text("eval_name").notNull(),
  configName: text("config_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  /** The run's `EvalStepRecord[]` — see ../types.ts — verbatim. */
  steps: jsonb("steps").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EvalRunRow = typeof evalRun.$inferSelect;
