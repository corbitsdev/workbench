// The two tables `@corbits/routines` owns: the routine itself (the
// named, product-facing entity) and the link table correlating each
// launched run back to the routine that launched it. Tenancy,
// principals, and the run/session rows a launch writes stay native
// platform schema under vendor/intx/db — this package only adds its
// own state, keyed by tenant.
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * A Routine: the named parent entity over workflow runs. `trigger` and
 * `input` are jsonb — record-as-truth, the same convention
 * `@corbits/chat`'s `channel_settings` uses — so new trigger shapes or
 * input fields never require a migration. `trigger` holds the arktype-
 * validated shape from `./trigger.ts`, or `null` for a manual,
 * run-now-only routine. `deliveryChannelId` is nullable: a routine
 * need not post its results anywhere.
 */
export const routine = pgTable("routine", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  definitionId: text("definition_id").notNull(),
  trigger: jsonb("trigger"),
  scope: text("scope").notNull(),
  input: jsonb("input").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  deliveryChannelId: text("delivery_channel_id"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Correlates a launched run (a `workflow_run.id` / folded-run instance
 * id, native platform schema) back to the routine that launched it. A
 * separate link table rather than a column grafted onto the platform's
 * own `workflow_run` — this package never migrates a table it doesn't
 * own — and it holds nothing else: run status, timing, and mail all
 * stay read off the platform's own run surfaces, joined by `runId`.
 */
export const routineRun = pgTable(
  "routine_run",
  {
    tenantId: text("tenant_id").notNull(),
    routineId: text("routine_id").notNull(),
    runId: text("run_id").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.runId] })],
);
