// The product tables @corbits/tasks owns: `task`, a row per
// spawn-and-return agent request, and `task_leg`, a row per agent run
// that request is carried out by. They live in their own `tasks`
// Postgres schema, fully siloed from the platform's `public` schema —
// see docs/package-migrations.md. `tenantId`/`principalId`/
// `definitionId` are plain text identifiers, not foreign keys, so
// referencing platform rows works identically from a named schema.
import {
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
 * direct manual pick.
 *
 * `runId` names the run of the task's FIRST leg only. A task that
 * hands its work through several agents in turn has one `task_leg`
 * row per hand-off; `task_leg` is the authority on which runs a task
 * spans, and this column stays the launch run's stable identity.
 */
export const task = tasksSchema.table("task", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  definitionId: text("definition_id").notNull(),
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

export const TASK_LEG_STATUSES = [
  "pending",
  "dispatching",
  "running",
  "done",
  "failed",
] as const;
export type TaskLegStatus = (typeof TASK_LEG_STATUSES)[number];

/**
 * One row per agent run a task is carried out by, in `position` order.
 * A task with a single agent has exactly one leg; a task that hands
 * its work on has one row per hand-off, each naming the run that
 * produced its input (`parentRunId`) and the run that carries it out
 * (`runId`, null until the leg is launched).
 *
 * `messageId` is the leg's delivery identity, derived from the task
 * and the position rather than minted per attempt. Together with
 * `parentRunId` it carries the platform's own
 * `(anchorRunId, messageId)` idempotency contract into this package:
 * the unique index below means a re-run of the hand-off can only ever
 * find the row that already exists, never create a second one.
 *
 * A leg becomes `running` only once its agent has actually been given
 * its prompt. `runId` is stamped while the leg is still `dispatching`,
 * inside the launch transaction — a run committed but unrecorded would
 * be relaunched by the next claim — and `startedAt` is stamped when the
 * prompt lands. So a `dispatching` leg carrying a `runId` and no
 * `startedAt` is a run that was created but never told what to do, and
 * it is still in the one state the dispatch-failure path matches: it
 * can be failed honestly rather than reported as an agent at work.
 * `startedAt` is what makes that distinction durable past the leg's own
 * terminal status, so a task's trace counts only the runs it really
 * passed through.
 *
 * `leaseExpiresAt` bounds a claimed-but-not-yet-started leg. A claim
 * that dies before it records its `runId` becomes claimable again once
 * the lease passes; a claim that DID record a `runId` never does, so
 * an expired lease redelivers the launch attempt without ever running
 * the agent twice. A leg still `dispatching` well past its lease is
 * going nowhere on its own — `listStuckLegDispatches` finds exactly
 * those, and the stuck-leg sweep fails them.
 *
 * Why this table is workbench-owned rather than platform schema: it
 * records why two runs belong to one piece of work — product
 * correlation, not delivery state. The platform's own
 * `workflow_run_dispatch` remains the authority on delivery.
 */
export const taskLeg = tasksSchema.table(
  "task_leg",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    position: integer("position").notNull(),
    definitionId: text("definition_id").notNull(),
    prompt: text("prompt").notNull(),
    modelPreference: text("model_preference"),
    parentRunId: text("parent_run_id"),
    messageId: text("message_id").notNull(),
    runId: text("run_id"),
    status: text("status").notNull().$type<TaskLegStatus>(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_leg_task_position_uidx").on(t.taskId, t.position),
    uniqueIndex("task_leg_task_message_uidx").on(t.taskId, t.messageId),
    uniqueIndex("task_leg_run_id_uidx").on(t.runId),
    index("task_leg_task_idx").on(t.taskId),
  ],
);

export type TaskLegRow = typeof taskLeg.$inferSelect;
