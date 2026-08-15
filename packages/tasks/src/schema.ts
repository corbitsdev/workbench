// The one product table @corbits/tasks owns: `task`, a row per
// spawn-and-return agent run. It lives in its own `tasks` Postgres
// schema, fully siloed from the platform's `public` schema — see
// docs/package-migrations.md. `tenantId`/`principalId`/`definitionId`
// are plain text identifiers, not foreign keys, so referencing
// platform rows works identically from a named schema.
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const tasksSchema = pgSchema("tasks");

export const TASK_STATUSES = [
  "queued",
  "running",
  "needs-you",
  "done",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * One row per launched task. `runId` is the folded run's own
 * `workflowRun.id` — the join key back to `@corbits/folded-runs` and
 * the sidecar's `agent.event` stream. `resultMailId` is set once the
 * finalized reply has been delivered to the Inbox (the mailbox row
 * id), so a task's own delivery is never re-sent on a duplicate
 * `connector.reply` for the same run. `status` never becomes
 * "needs-you" from this package's own code — a mid-task approval is
 * surfaced by the existing needs-you inbox flow, not by this table;
 * the value exists for a future UI that wants to reflect it without a
 * schema change. `plannerRunId` is set when a planner run chose this
 * task's agent — see CL-6051 — and is null for a task launched by a
 * direct manual pick. `agentName` is the launched definition's name at
 * launch time (`definitionRow.name` — the same source the result-mail
 * notification already reads), stored on the row so a listing never
 * has to re-resolve it against a definitions catalog that may exclude
 * the definition by the time anyone reads the row (a planner-created
 * agent, for instance, never appears in the invitable-definitions
 * listing — see CL-6051).
 */
export const task = tasksSchema.table("task", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  definitionId: text("definition_id").notNull(),
  agentName: text("agent_name").notNull(),
  prompt: text("prompt").notNull(),
  modelPreference: text("model_preference"),
  status: text("status").notNull().$type<TaskStatus>(),
  runId: text("run_id").notNull(),
  resultMailId: text("result_mail_id"),
  plannerRunId: text("planner_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type TaskRow = typeof task.$inferSelect;
