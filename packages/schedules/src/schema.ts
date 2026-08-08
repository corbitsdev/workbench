// The one product table `@corbits/schedules` owns: a tenant-scoped
// schedule row naming the workflow definition it launches, its trigger
// (cron or interval, see `./trigger.ts`), the input payload each
// launch carries, and the bookkeeping (`last_run_at`/`next_run_at`)
// the ticking scheduler reads and advances. `input` and `trigger` are
// jsonb so their shape can grow without a migration; only the columns
// the scheduler and routes query directly (`enabled`, `next_run_at`)
// are real columns.
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workflowDefinitionId: text("workflow_definition_id").notNull(),
  trigger: jsonb("trigger").notNull(),
  input: jsonb("input").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
