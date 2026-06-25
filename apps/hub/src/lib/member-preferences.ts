import { and, eq } from 'drizzle-orm';
import { type } from 'arktype';
import { getLogger } from '@intx/log';
import { MemberPreferences } from '@workbench/shared';
import { memberPreferences } from '../db/schema';
import type { HubDb } from '../db';

const log = getLogger(['hub', 'member-preferences']);

// Reads a member's stored preferences, returning an empty map when none exist.
// A stored blob that fails validation (legacy/garbage) is tolerated as empty so
// a single bad row never breaks the /me bootstrap.
export async function readMemberPreferences(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string
): Promise<MemberPreferences> {
  const row = await db.query.memberPreferences.findFirst({
    where: and(
      eq(memberPreferences.tenantId, tenantId),
      eq(memberPreferences.memberPrincipalId, memberPrincipalId)
    ),
  });
  if (!row) return {};
  const parsed = MemberPreferences(row.preferences);
  if (parsed instanceof type.errors) {
    log.warn('Stored member preferences failed validation; treating as empty', {
      tenantId,
      memberPrincipalId,
      error: parsed.summary,
    });
    return {};
  }
  return parsed;
}

// Merges a partial patch into the member's stored preferences (last-writer-wins
// per key) and returns the merged result. Upserts on (tenant, principal).
export async function mergeMemberPreferences(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  patch: MemberPreferences
): Promise<MemberPreferences> {
  const current = await readMemberPreferences(db, tenantId, memberPrincipalId);
  const next: MemberPreferences = { ...current, ...patch };
  await db
    .insert(memberPreferences)
    .values({ tenantId, memberPrincipalId, preferences: next })
    .onConflictDoUpdate({
      target: [memberPreferences.tenantId, memberPreferences.memberPrincipalId],
      set: { preferences: next, updatedAt: new Date() },
    });
  return next;
}
