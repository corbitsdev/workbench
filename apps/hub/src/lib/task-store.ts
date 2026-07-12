import { and, desc, eq, inArray, or } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type {
  Task,
  TaskExternalRef,
  TaskLink,
  TaskStatus,
} from "@workbench/shared";
import {
  task,
  taskExternalRef,
  memberAgentInstance,
  type TaskExternalRefRow,
  type TaskRow,
} from "../db/schema";
import type { HubDb } from "../db";
import { deliverTaskMail } from "./deliver-task-mail";
import type { MailboxEventBus } from "./mailbox-events";
import { keysetBefore, takePage, type KeysetCursor } from "./keyset";

// Mirrors `TRIAGE_TEMPLATE_KEY` in ../services/mailbox-triage.ts. Duplicated
// rather than imported so this lib module (below services in the dependency
// direction) never depends on a service; a `memberAgentInstance.templateKey`
// audit would catch drift either way.
const TRIAGE_TEMPLATE_KEY = "myra-triage";

export type TaskPage = {
  items: Task[];
  nextCursor?: string;
};

// Owner-scoped persistence for native tasks. Every read and write is bound to
// (tenantId, ownerPrincipalId) so a member can never see or mutate another
// member's task — the same isolation guarantee as the schedules store.

const DEFAULT_TASK_LIMIT = 100;

export type CreateTaskInput = {
  tenantId: string;
  ownerPrincipalId: string;
  createdByPrincipalId: string;
  title: string;
  body?: string;
  source: Task["source"];
  sourceRef?: string;
  due?: string;
  links?: TaskLink[];
  mailboxEventBus?: MailboxEventBus;
  // Omitted defaults to the column default (`open`). Callers that create a
  // task on the owner's behalf ahead of their own review — mailbox triage's
  // `task_create` is the only one today — pass `waiting` so it starts parked
  // rather than nagging before the person has seen it.
  status?: TaskStatus;
};

export type UpdateTaskInput = {
  tenantId: string;
  ownerPrincipalId: string;
  /** The principal making this update — used to attribute "waiting on you" mail. */
  actorPrincipalId: string;
  id: string;
  title?: string;
  body?: string;
  status?: TaskStatus;
  due?: string | null;
  /** `null` clears the assignee; omitted leaves it untouched. */
  assigneePrincipalId?: string | null;
  mailboxEventBus?: MailboxEventBus;
};

function toExternalRef(row: TaskExternalRefRow): TaskExternalRef {
  const ref: TaskExternalRef = {
    adapterId: row.adapterId,
    externalId: row.externalId ?? "",
    syncState: row.syncState,
  };
  if (row.externalUrl !== null) ref.externalUrl = row.externalUrl;
  if (row.lastSyncedAt !== null) {
    ref.lastSyncedAt = row.lastSyncedAt.toISOString();
  }
  return ref;
}

export function toApiTask(row: TaskRow, refs: TaskExternalRefRow[]): Task {
  const result: Task = {
    id: row.id,
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    createdByPrincipalId: row.createdByPrincipalId,
    title: row.title,
    status: row.status,
    source: row.source,
    links: row.links,
    // Only refs with an established external object are user-visible; a pending
    // ref that has never linked stays server-side (the "sending…" affordance is
    // driven separately), never surfaced as an error.
    externalRefs: refs
      .filter((ref) => ref.externalId !== null)
      .map(toExternalRef),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.body !== null) result.body = row.body;
  if (row.sourceRef !== null) result.sourceRef = row.sourceRef;
  if (row.due !== null) result.due = row.due.toISOString();
  if (row.assigneePrincipalId !== null) {
    result.assigneePrincipalId = row.assigneePrincipalId;
  }
  return result;
}

async function loadRefsByTaskIds(
  db: HubDb,
  taskIds: string[],
): Promise<Map<string, TaskExternalRefRow[]>> {
  const byTask = new Map<string, TaskExternalRefRow[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select()
    .from(taskExternalRef)
    .where(inArray(taskExternalRef.taskId, taskIds));
  for (const row of rows) {
    const list = byTask.get(row.taskId) ?? [];
    list.push(row);
    byTask.set(row.taskId, list);
  }
  return byTask;
}

// The caller's "my tasks" feed: everything they own PLUS everything assigned
// to them, newest first in one merged, keyset-paginated stream. A single
// (tenant, member) principal id drives both sides of the OR, so the existing
// keyset cursor (createdAt, id) still orders the combined set correctly.
export async function listOwnerTasks(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    statuses?: TaskStatus[];
    limit?: number;
    cursor?: KeysetCursor;
  },
): Promise<TaskPage> {
  const ownerOrAssignee = or(
    eq(task.ownerPrincipalId, args.ownerPrincipalId),
    eq(task.assigneePrincipalId, args.ownerPrincipalId),
  );
  if (ownerOrAssignee === undefined) {
    throw new Error("Owner/assignee predicate construction failed");
  }
  const conditions = [eq(task.tenantId, args.tenantId), ownerOrAssignee];
  if (args.statuses !== undefined && args.statuses.length > 0) {
    conditions.push(inArray(task.status, args.statuses));
  }
  if (args.cursor) {
    const before = keysetBefore(task.createdAt, task.id, args.cursor);
    if (before) conditions.push(before);
  }
  const limit = args.limit ?? DEFAULT_TASK_LIMIT;
  const rows = await db
    .select()
    .from(task)
    .where(and(...conditions))
    .orderBy(desc(task.createdAt), desc(task.id))
    .limit(limit + 1);
  const page = takePage(rows, limit);
  const refs = await loadRefsByTaskIds(
    db,
    page.items.map((row) => row.id),
  );
  return {
    items: page.items.map((row) => toApiTask(row, refs.get(row.id) ?? [])),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function getOwnerTask(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; id: string },
): Promise<Task | null> {
  const [row] = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.id, args.id),
        eq(task.tenantId, args.tenantId),
        eq(task.ownerPrincipalId, args.ownerPrincipalId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refs = await loadRefsByTaskIds(db, [row.id]);
  return toApiTask(row, refs.get(row.id) ?? []);
}

// Read-only counterpart to getOwnerTask that also admits the caller as the
// task's assignee — used by the single-task deep-link route (GET
// /me/tasks/:id) so an assignee can open a task from their feed. Mutation
// routes (PATCH, push) stay on getOwnerTask: only the owner may write.
export async function getVisibleTask(
  db: HubDb,
  args: { tenantId: string; principalId: string; id: string },
): Promise<Task | null> {
  const visible = or(
    eq(task.ownerPrincipalId, args.principalId),
    eq(task.assigneePrincipalId, args.principalId),
  );
  if (visible === undefined) {
    throw new Error("Owner/assignee predicate construction failed");
  }
  const [row] = await db
    .select()
    .from(task)
    .where(and(eq(task.id, args.id), eq(task.tenantId, args.tenantId), visible))
    .limit(1);
  if (!row) return null;
  const refs = await loadRefsByTaskIds(db, [row.id]);
  return toApiTask(row, refs.get(row.id) ?? []);
}

/**
 * Task creation is prepare-only for every caller today — mailbox triage is
 * the sole write `task_create` is admitted to (see
 * packages/myra/src/personas/mailbox.ts). A triage-created task is work the
 * agent prepared on the member's behalf, not work it decided to surface as
 * immediately actionable, so it lands in `waiting` regardless of the
 * member's autonomy setting (`prepare_only` vs `execute_with_gates` gates
 * what triage may DO, not the status of what it merely leaves behind). A
 * non-triage caller falls through to `undefined` (the column default,
 * `open`) — none exist yet, since `task_create` is not granted outside the
 * mailbox persona.
 */
export async function resolveTriageTaskDefaultStatus(
  db: HubDb,
  args: { tenantId: string; principalId: string },
): Promise<TaskStatus | undefined> {
  const instanceRows = await db
    .select({ id: intxSchema.agentInstance.id })
    .from(intxSchema.agentInstance)
    .where(
      and(
        eq(intxSchema.agentInstance.tenantId, args.tenantId),
        eq(intxSchema.agentInstance.principalId, args.principalId),
      ),
    )
    .limit(1);
  const instanceId = instanceRows[0]?.id;
  if (!instanceId) return undefined;

  const mappingRows = await db
    .select({ templateKey: memberAgentInstance.templateKey })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, args.tenantId),
        eq(memberAgentInstance.instanceId, instanceId),
      ),
    )
    .limit(1);
  if (mappingRows[0]?.templateKey !== TRIAGE_TEMPLATE_KEY) return undefined;
  return "waiting";
}

/**
 * Counts tasks created by a given principal — used to cap how many tasks a
 * single ephemeral triage session (one per mail item, see
 * `mailbox-triage.ts`) may leave behind. Each triage run mints a fresh
 * instance/principal, so `createdByPrincipalId` is already scoped to one
 * mail item without needing to parse `sourceRef`.
 */
export async function countTasksCreatedBy(
  db: HubDb,
  args: { tenantId: string; createdByPrincipalId: string },
): Promise<number> {
  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.tenantId, args.tenantId),
        eq(task.createdByPrincipalId, args.createdByPrincipalId),
      ),
    );
  return rows.length;
}

/**
 * Finds an existing non-cancelled task for this owner with a matching
 * `sourceRef` — used to dedupe triage task creation against the same
 * message/mail item instead of creating a duplicate.
 */
export async function findOwnerTaskBySourceRef(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; sourceRef: string },
): Promise<Task | null> {
  const rows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.tenantId, args.tenantId),
        eq(task.ownerPrincipalId, args.ownerPrincipalId),
        eq(task.sourceRef, args.sourceRef),
      ),
    )
    .orderBy(desc(task.createdAt))
    .limit(10);
  const match = rows.find((row) => row.status !== "cancelled");
  if (!match) return null;
  const refs = await loadRefsByTaskIds(db, [match.id]);
  return toApiTask(match, refs.get(match.id) ?? []);
}

export async function createOwnerTask(
  db: HubDb,
  input: CreateTaskInput,
): Promise<Task> {
  const values: typeof task.$inferInsert = {
    tenantId: input.tenantId,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    title: input.title,
    source: input.source,
    links: input.links ?? [],
  };
  if (input.body !== undefined) values.body = input.body;
  if (input.sourceRef !== undefined) values.sourceRef = input.sourceRef;
  if (input.due !== undefined) values.due = new Date(input.due);
  if (input.status !== undefined) values.status = input.status;
  const [row] = await db.insert(task).values(values).returning();
  if (!row) throw new Error("Failed to create task");
  const created = toApiTask(row, []);
  await deliverTaskMail({
    db,
    tenantId: input.tenantId,
    task: created,
    event: input.source === "agent" ? "assigned" : "created",
    actorPrincipalId: input.createdByPrincipalId,
    ...(input.mailboxEventBus
      ? { mailboxEventBus: input.mailboxEventBus }
      : {}),
  });
  return created;
}

export async function updateOwnerTask(
  db: HubDb,
  input: UpdateTaskInput,
): Promise<Task | null> {
  // Only fetched when the assignee is in play, to detect a real change (vs. a
  // re-save of the same assignee) before mailing — every other field is a
  // blind write, same as before this feature.
  let priorAssigneePrincipalId: string | null | undefined;
  if (input.assigneePrincipalId !== undefined) {
    const [priorRow] = await db
      .select({ assigneePrincipalId: task.assigneePrincipalId })
      .from(task)
      .where(
        and(
          eq(task.id, input.id),
          eq(task.tenantId, input.tenantId),
          eq(task.ownerPrincipalId, input.ownerPrincipalId),
        ),
      )
      .limit(1);
    if (!priorRow) return null;
    priorAssigneePrincipalId = priorRow.assigneePrincipalId;
  }

  const set: Partial<typeof task.$inferInsert> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.body !== undefined) set.body = input.body;
  if (input.status !== undefined) set.status = input.status;
  if (input.due !== undefined) {
    set.due = input.due === null ? null : new Date(input.due);
  }
  if (input.assigneePrincipalId !== undefined) {
    set.assigneePrincipalId = input.assigneePrincipalId;
  }
  const [row] = await db
    .update(task)
    .set(set)
    .where(
      and(
        eq(task.id, input.id),
        eq(task.tenantId, input.tenantId),
        eq(task.ownerPrincipalId, input.ownerPrincipalId),
      ),
    )
    .returning();
  if (!row) return null;
  const refs = await loadRefsByTaskIds(db, [row.id]);
  const updated = toApiTask(row, refs.get(row.id) ?? []);
  if (input.status === "waiting") {
    await deliverTaskMail({
      db,
      tenantId: input.tenantId,
      task: updated,
      event: "waiting",
      actorPrincipalId: input.actorPrincipalId,
      ...(input.mailboxEventBus
        ? { mailboxEventBus: input.mailboxEventBus }
        : {}),
    });
  }
  const newAssigneePrincipalId = input.assigneePrincipalId;
  if (
    newAssigneePrincipalId !== undefined &&
    newAssigneePrincipalId !== null &&
    newAssigneePrincipalId !== (priorAssigneePrincipalId ?? null)
  ) {
    await deliverTaskMail({
      db,
      tenantId: input.tenantId,
      task: updated,
      event: "assigned",
      actorPrincipalId: input.actorPrincipalId,
      recipientPrincipalId: newAssigneePrincipalId,
      ...(input.mailboxEventBus
        ? { mailboxEventBus: input.mailboxEventBus }
        : {}),
    });
  }
  return updated;
}
