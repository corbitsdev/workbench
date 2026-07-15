import type {
  Task,
  TaskExternalRef,
  TaskLink,
  TaskStatus,
} from "@workbench/shared";

// The task API projection: row -> wire `Task`, and the ref-visibility rule
// governing which external refs a caller may see. Structural row types (not
// the hub's drizzle-inferred `TaskRow`/`TaskExternalRefRow`) so this package
// stays DB-agnostic — the hub's rows satisfy these shapes without a cast.

export type TaskRowLike = {
  id: string;
  tenantId: string;
  ownerPrincipalId: string;
  createdByPrincipalId: string;
  assigneePrincipalId: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  source: Task["source"];
  sourceRef: string | null;
  due: Date | null;
  links: TaskLink[];
  createdAt: Date;
  updatedAt: Date;
};

export type TaskExternalRefRowLike = {
  adapterId: string;
  externalId: string | null;
  externalUrl: string | null;
  syncState: TaskExternalRef["syncState"];
  lastSyncedAt: Date | null;
};

export function toExternalRef(row: TaskExternalRefRowLike): TaskExternalRef {
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

export function toApiTask(
  row: TaskRowLike,
  refs: TaskExternalRefRowLike[],
): Task {
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

/**
 * The task ref-visibility rule: a principal may see a task it owns OR is
 * assigned to. Mutation stays owner-only (see the hub's `getOwnerTask`); this
 * is the read-visibility predicate behind the single-task deep-link route
 * (`getVisibleTask`) and the "my tasks" feed (`listOwnerTasks`), both of which
 * express it as a DB-level OR for query efficiency — this pure form is the
 * single documented, testable definition those queries must match.
 */
export function isTaskVisibleTo(
  row: { ownerPrincipalId: string; assigneePrincipalId: string | null },
  principalId: string,
): boolean {
  return (
    row.ownerPrincipalId === principalId ||
    row.assigneePrincipalId === principalId
  );
}
