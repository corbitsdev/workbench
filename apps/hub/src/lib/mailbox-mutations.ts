import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { principalMailbox } from "../db/schema";
import type { HubDb } from "../db";
import type { MailboxBulkAction } from "@workbench/shared";

export type MailboxMutationScope = {
  tenantId: string;
  principalId: string;
};

function scopedInbound(
  scope: MailboxMutationScope,
  extra: Parameters<typeof and>[0][] = [],
) {
  return and(
    eq(principalMailbox.tenantId, scope.tenantId),
    eq(principalMailbox.principalId, scope.principalId),
    eq(principalMailbox.direction, "inbound"),
    ...extra,
  );
}

function scopedActiveInbound(
  scope: MailboxMutationScope,
  extra: Parameters<typeof and>[0][] = [],
) {
  return scopedInbound(scope, [
    isNull(principalMailbox.archivedAt),
    isNull(principalMailbox.trashedAt),
    ...extra,
  ]);
}

export async function markMailboxMessageUnread(
  db: HubDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  const updated = await db
    .update(principalMailbox)
    .set({ readAt: null })
    .where(scopedActiveInbound(scope, [eq(principalMailbox.id, scope.id)]))
    .returning({ id: principalMailbox.id });
  return updated.length > 0;
}

export async function trashMailboxMessage(
  db: HubDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  const updated = await db
    .update(principalMailbox)
    .set({
      trashedAt: sql`COALESCE(${principalMailbox.trashedAt}, now())`,
      archivedAt: null,
    })
    .where(scopedInbound(scope, [eq(principalMailbox.id, scope.id)]))
    .returning({ id: principalMailbox.id });
  return updated.length > 0;
}

export async function archiveMailboxMessage(
  db: HubDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  const updated = await db
    .update(principalMailbox)
    .set({
      archivedAt: sql`COALESCE(${principalMailbox.archivedAt}, now())`,
      trashedAt: null,
    })
    .where(
      scopedInbound(scope, [
        eq(principalMailbox.id, scope.id),
        isNull(principalMailbox.trashedAt),
      ]),
    )
    .returning({ id: principalMailbox.id });
  return updated.length > 0;
}

export async function restoreMailboxMessage(
  db: HubDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  const updated = await db
    .update(principalMailbox)
    .set({ archivedAt: null, trashedAt: null })
    .where(scopedInbound(scope, [eq(principalMailbox.id, scope.id)]))
    .returning({ id: principalMailbox.id });
  return updated.length > 0;
}

export async function countUnreadActiveMailbox(
  db: HubDb,
  scope: MailboxMutationScope,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(principalMailbox)
    .where(
      scopedInbound(scope, [
        isNull(principalMailbox.readAt),
        isNull(principalMailbox.archivedAt),
        isNull(principalMailbox.trashedAt),
      ]),
    );
  return rows[0]?.count ?? 0;
}

export async function applyMailboxBulkAction(
  db: HubDb,
  scope: MailboxMutationScope,
  action: MailboxBulkAction,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const baseWhere = scopedInbound(scope, [inArray(principalMailbox.id, ids)]);

  switch (action) {
    case "mark_read": {
      const updated = await db
        .update(principalMailbox)
        .set({ readAt: sql`COALESCE(${principalMailbox.readAt}, now())` })
        .where(baseWhere)
        .returning({ id: principalMailbox.id });
      return updated.map((row) => row.id);
    }
    case "mark_unread": {
      const updated = await db
        .update(principalMailbox)
        .set({ readAt: null })
        .where(scopedActiveInbound(scope, [inArray(principalMailbox.id, ids)]))
        .returning({ id: principalMailbox.id });
      return updated.map((row) => row.id);
    }
    case "trash": {
      const updated = await db
        .update(principalMailbox)
        .set({
          trashedAt: sql`COALESCE(${principalMailbox.trashedAt}, now())`,
          archivedAt: null,
        })
        .where(baseWhere)
        .returning({ id: principalMailbox.id });
      return updated.map((row) => row.id);
    }
    case "archive": {
      const updated = await db
        .update(principalMailbox)
        .set({
          archivedAt: sql`COALESCE(${principalMailbox.archivedAt}, now())`,
          trashedAt: null,
        })
        .where(
          scopedInbound(scope, [
            inArray(principalMailbox.id, ids),
            isNull(principalMailbox.trashedAt),
          ]),
        )
        .returning({ id: principalMailbox.id });
      return updated.map((row) => row.id);
    }
    case "restore": {
      const updated = await db
        .update(principalMailbox)
        .set({ archivedAt: null, trashedAt: null })
        .where(baseWhere)
        .returning({ id: principalMailbox.id });
      return updated.map((row) => row.id);
    }
  }
}
