// The hub's `HubSignupTenancy` adapter (see
// packages/onboarding/src/genesis.ts): the native reads and writes the
// genesis-or-join first-signup decision needs — user/tenant counts,
// the root-tenant lookup, and the member-role join. Mirrors
// packages/chat/src/workbench-tenancy.ts's `addWorkbenchMember`
// (principalStore.create + principalRole "member") so a joined signup
// holds exactly the membership shape a workbench member holds. Reads
// native tables only; declares none of its own (see
// scripts/checks/no-product-tenancy.ts).
import { and, count, eq, isNull } from "drizzle-orm";
import { generateId } from "@intx/hub-common";
import {
  createPrincipalStore,
  type DB,
  type PrincipalKeyStore,
} from "@intx/db";
import {
  principal,
  principalRole,
  role,
  tenant,
  user as userTable,
} from "@intx/db/schema";
import type { HubSignupTenancy } from "@workbench/onboarding";

export function createHubSignupTenancy(
  db: DB["db"],
  principalKeyStore: PrincipalKeyStore,
): HubSignupTenancy {
  const principalStore = createPrincipalStore(db, principalKeyStore);
  return {
    countUsers: async () => {
      const [row] = await db.select({ n: count() }).from(userTable);
      return row?.n ?? 0;
    },
    countTenants: async () => {
      const [row] = await db.select({ n: count() }).from(tenant);
      return row?.n ?? 0;
    },
    findRootTenant: async () => {
      const [row] = await db
        .select({ id: tenant.id, slug: tenant.slug })
        .from(tenant)
        .where(isNull(tenant.parentId))
        .limit(1);
      return row ?? null;
    },
    addActiveMember: async ({ tenantId, userId, roleName }) =>
      db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: principal.id })
          .from(principal)
          .where(
            and(
              eq(principal.tenantId, tenantId),
              eq(principal.kind, "user"),
              eq(principal.refId, userId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return { principalId: existing.id };

        const [memberRole] = await tx
          .select({ id: role.id })
          .from(role)
          .where(and(eq(role.tenantId, tenantId), eq(role.name, roleName)))
          .limit(1);
        if (memberRole === undefined) {
          throw new Error(
            `signup join: tenant "${tenantId}" has no "${roleName}" system role`,
          );
        }

        const now = new Date();
        const created = await principalStore.create(
          {
            id: generateId("principal"),
            tenantId,
            kind: "user",
            refId: userId,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
          tx,
        );
        await tx.insert(principalRole).values({
          principalId: created.id,
          roleId: memberRole.id,
          createdAt: now,
        });
        return { principalId: created.id };
      }),
  };
}
