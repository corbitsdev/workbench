import { type } from "arktype";

// Native Workbench task model (CL-3302). These schemas are the API boundary
// shared by the hub routes, the task context tools, and the web client. The
// domain logic (adapter registry, push service) lives in `@workbench/tasks`;
// the tables live in the hub schema.

// The status vocabulary is deliberately the lowest common denominator every
// downstream system (Attio, Linear, GitHub, ...) can map onto: "someone should
// look" (open), "being worked" (in_progress), "parked, don't nag" (waiting),
// and the two terminals. There is no `failed` — a task never fails, an
// operation on it can, and that failure lives on the sync ref, never on the
// task itself (house rule: never surface a failure state to the user).
export const taskStatuses = [
  "open",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;
export const TaskStatusSchema = type.enumerated(...taskStatuses);
export type TaskStatus = typeof TaskStatusSchema.infer;

// Where a task came from. Drives how the inbox deep-links back to its origin
// (a mail item, a workflow run, an agent session, or a direct user action).
export const taskSources = ["mail", "workflow", "agent", "user"] as const;
export const TaskSourceSchema = type.enumerated(...taskSources);
export type TaskSource = typeof TaskSourceSchema.infer;

// A downstream sync ref's lifecycle. `pending` covers both "sending" and a
// stuck-forever send (the reconciler keeps retrying but never surfaces an error
// state); `detached` is an explicit user unlink so a re-send creates a fresh
// external object rather than reviving a stale ref.
export const taskSyncStates = ["pending", "synced", "detached"] as const;
export const TaskSyncStateSchema = type.enumerated(...taskSyncStates);
export type TaskSyncState = typeof TaskSyncStateSchema.infer;

// A link from a task to another Workbench object or an external URL.
export const TaskLinkSchema = type({
  kind: "'artifact' | 'workflow_run' | 'mail' | 'conversation' | 'url'",
  ref: "string",
  "label?": "string",
});
export type TaskLink = typeof TaskLinkSchema.infer;

// A task's mirror in a downstream system, as surfaced at the boundary. The
// attribution (`actorPrincipalId`) and any failure detail stay server-side on
// the `task_external_ref` row and are never part of this shape.
export const TaskExternalRefSchema = type({
  adapterId: "string",
  externalId: "string",
  "externalUrl?": "string",
  syncState: TaskSyncStateSchema,
  "lastSyncedAt?": "string",
});
export type TaskExternalRef = typeof TaskExternalRefSchema.infer;

export const TaskSchema = type({
  id: "string",
  tenantId: "string",
  ownerPrincipalId: "string",
  createdByPrincipalId: "string",
  title: "string",
  "body?": "string",
  status: TaskStatusSchema,
  source: TaskSourceSchema,
  "sourceRef?": "string",
  "due?": "string",
  links: TaskLinkSchema.array(),
  externalRefs: TaskExternalRefSchema.array(),
  createdAt: "string",
  updatedAt: "string",
});
export type Task = typeof TaskSchema.infer;
