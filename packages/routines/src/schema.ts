// The two tables `@corbits/routines` owns: the routine itself (the
// named, product-facing entity) and the link table correlating each
// launched run back to the routine that launched it. Tenancy,
// principals, and the run/session rows a launch writes stay native
// platform schema under vendor/intx/db — this package only adds its
// own state, keyed by tenant.
import {
  boolean,
  integer,
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
  // The due-fire clock: the next minute this routine's trigger matches,
  // recomputed on create, on every trigger/enabled change, and on each
  // fire. A scheduler tests `nextFireAt <= now`, not "does this exact
  // instant match" — a fire due while the process was down stays due
  // (and gets caught up) instead of being silently skipped. `null` for
  // a manual or disabled routine, which never auto-fires.
  nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
  // The last time this routine actually fired on its own schedule —
  // observability only, never read back into a fire decision.
  lastFireAt: timestamp("last_fire_at", { withTimezone: true }),
  // Soft-delete: a deleted routine's run history must stay reachable
  // (`GET /routines/:id/runs`), so deleting never removes the row —
  // it stops the routine appearing in lists or firing, and nothing
  // else.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Consecutive launch failures since the last success. The scheduler
  // backs off exponentially off this counter, then dead-letters once
  // it reaches `MAX_ROUTINE_FIRE_FAILURES` (see store.ts).
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  // When set, the scheduler never claims this routine again until an
  // operator re-enables/edits it (which clears the dead-letter).
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
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
 *
 * Failed launches that never produced a platform run still get a row
 * (`triggeredBy: "schedule-failed"`, synthetic `runId`, `error` set) so
 * the history surface can show the failure without inventing a second
 * bookkeeping path.
 */
export const routineRun = pgTable(
  "routine_run",
  {
    tenantId: text("tenant_id").notNull(),
    routineId: text("routine_id").notNull(),
    runId: text("run_id").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.runId] })],
);

/**
 * Free-text drafting path for routines. Only an approved draft creates
 * a `routine` row; until then nothing is schedulable.
 */
export const routineDraft = pgTable("routine_draft", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  prompt: text("prompt").notNull(),
  /** draft | reviewed | approved | discarded */
  status: text("status").notNull(),
  proposedSteps: jsonb("proposed_steps").notNull().default([]),
  proposedTrigger: jsonb("proposed_trigger"),
  proposedName: text("proposed_name"),
  definitionId: text("definition_id"),
  deliveryChannelId: text("delivery_channel_id").notNull(),
  scope: text("scope").notNull(),
  autonomy: jsonb("autonomy"),
  createdBy: text("created_by").notNull(),
  approvedRoutineId: text("approved_routine_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
