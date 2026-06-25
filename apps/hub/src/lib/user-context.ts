import { and, eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import { getConfig } from "../config";

export type UserContext = {
  tenantId: string;
  principalId: string;
};

const log = getLogger(["api", "workflow"]);

export async function getUserContext(
  db: HubDb,
  userId: string,
): Promise<UserContext | null> {
  // Resolve the caller's working context in the shared global org tenant
  // (CL-1452 cutover). Was the per-user `user-${userId}` personal tenant; now
  // every same-domain user is a member principal in the one global tenant.
  const { slug } = getConfig().globalTenant;
  const globalTenant = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.slug, slug),
  });

  if (!globalTenant) {
    log.error("Global tenant not found — is it seeded?", { slug });
    return null;
  }

  const principal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, globalTenant.id),
      eq(intxSchema.principal.kind, "user"),
      eq(intxSchema.principal.refId, userId),
    ),
  });

  if (!principal) {
    log.error("Member principal not found for user in global tenant", {
      userId,
      tenantId: globalTenant.id,
    });
    return null;
  }

  return {
    tenantId: globalTenant.id,
    principalId: principal.id,
  };
}

export async function getRequestedUserContext(
  db: HubDb,
  userId: string,
  requestedTenantId?: string | null,
): Promise<{ context: UserContext | null; forbidden: boolean }> {
  const userContext = await getUserContext(db, userId);
  if (!userContext) return { context: null, forbidden: false };
  if (!requestedTenantId || requestedTenantId === userContext.tenantId) {
    return { context: userContext, forbidden: false };
  }

  const requestedPrincipal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, requestedTenantId),
      eq(intxSchema.principal.kind, "user"),
      eq(intxSchema.principal.refId, userId),
      eq(intxSchema.principal.status, "active"),
    ),
  });
  if (!requestedPrincipal) return { context: null, forbidden: true };

  return {
    context: {
      tenantId: requestedTenantId,
      principalId: requestedPrincipal.id,
    },
    forbidden: false,
  };
}
