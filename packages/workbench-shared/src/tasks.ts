import { type } from "arktype";

// Native Workbench task model. These schemas are the API boundary
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
  "assigneePrincipalId?": "string",
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

// A bare array of tasks, for callers (agent tools, internal projectors) that
// consume the collection without pagination.
export const TaskListSchema = TaskSchema.array();
export type TaskList = typeof TaskListSchema.infer;

// The GET /me/tasks response: one keyset-paginated page of the caller's tasks,
// newest first, with an opaque cursor for the next page when one exists.
export const TaskListResponseSchema = type({
  items: TaskSchema.array(),
  "nextCursor?": "string",
});
export type TaskListResponse = typeof TaskListResponseSchema.infer;

// Request body for POST /me/tasks. The server owns tenancy, ownership,
// attribution, and `source` — the client only describes the work.
export const CreateTaskBodySchema = type({
  title: "string > 0",
  "body?": "string",
  "due?": "string",
  "links?": TaskLinkSchema.array(),
});
export type CreateTaskBody = typeof CreateTaskBodySchema.infer;

// Request body for PATCH /me/tasks/:id. Every field optional; an empty patch is
// rejected by the route.
// `assigneePrincipalId: null` clears the assignee; omitted leaves it
// untouched. Only the task owner may set this (enforced server-side — the
// update WHERE clause is already scoped to the caller's own owned tasks).
export const UpdateTaskBodySchema = type({
  "title?": "string > 0",
  "body?": "string",
  "status?": TaskStatusSchema,
  "due?": "string | null",
  "assigneePrincipalId?": "string | null",
});
export type UpdateTaskBody = typeof UpdateTaskBodySchema.infer;

// Request body for POST /me/tasks/bulk — one status transition applied to every
// owned id that matches (unknown or non-owned ids are skipped).
export const TaskBulkPatchBodySchema = type({
  ids: "string[]>=1",
  status: TaskStatusSchema,
});
export type TaskBulkPatchBody = typeof TaskBulkPatchBodySchema.infer;

export const TaskBulkPatchResponseSchema = type({
  updated: "number",
  ids: "string[]",
});
export type TaskBulkPatchResponse = typeof TaskBulkPatchResponseSchema.infer;

/** Open task statuses — shared with the Now feed composition in `now-feed.ts`. */
export const openTaskStatuses = ["open", "in_progress", "waiting"] as const;

/** Sort key for open tasks in management surfaces (lower = more urgent). */
export const taskStatusUrgency: Record<
  (typeof openTaskStatuses)[number],
  number
> = {
  in_progress: 0,
  open: 1,
  waiting: 2,
};

// Request body for POST /me/tasks/:id/push. The session-authed human's click is
// the approval; `operation` defaults to `create`.
export const PushTaskBodySchema = type({
  adapterId: "string > 0",
  "operation?": "'create' | 'update' | 'close' | 'comment'",
});
export type PushTaskBody = typeof PushTaskBodySchema.infer;

// Two user-visible push outcomes: linked ("synced") or still sending
// ("pending"). Failure never appears here.
export const PushTaskResponseSchema = type({
  status: "'synced' | 'pending'",
  "externalId?": "string",
  "externalUrl?": "string",
  "deduped?": "boolean",
});
export type PushTaskResponse = typeof PushTaskResponseSchema.infer;

// The display-only half of the adapter registry (id + label), so the web
// client can render a chip/action without importing the server-side
// `@workbench/tasks` package (which pulls in adapter execution and fetcher
// deps that have no place in a browser bundle). Kept in lockstep by hand with
// `TASK_ADAPTERS` in `packages/tasks/src/registry.ts` — the same
// hand-maintained-catalog convention as `CREDENTIAL_PROVIDER_CATALOG`.
export const TaskAdapterCatalogEntrySchema = type({
  id: "string",
  label: "string",
});
export type TaskAdapterCatalogEntry =
  typeof TaskAdapterCatalogEntrySchema.infer;

export const TASK_ADAPTER_CATALOG: TaskAdapterCatalogEntry[] = [
  { id: "attio", label: "Attio" },
  { id: "linear", label: "Linear" },
];

// Shared display-label lookup for a task adapter id, falling back to the raw
// id for an adapter not (yet) in the catalog rather than rendering blank.
export function adapterLabel(adapterId: string): string {
  return (
    TASK_ADAPTER_CATALOG.find((entry) => entry.id === adapterId)?.label ??
    adapterId
  );
}
