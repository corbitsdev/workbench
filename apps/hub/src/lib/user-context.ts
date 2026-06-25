import { and, eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import { getRootTenantId } from "./tenant-provisioning";

export type UserContext = {
  tenantId: string;
  principalId: string;
};

const log = getLogger(["api", "workflow"]);

export async function getUserContext(
  db: HubDb,
  userId: string,
): Promise<UserContext | null> {
  // Default home is the deployment's root tenant (signup places users there).
  // Resolution goes through the shared helper rather than inlining the slug, so
  // there is one place that maps the configured root to a tenant id.
  const rootTenantId = await getRootTenantId(db as never);

  if (!rootTenantId) {
    log.error("Root tenant not found — is it seeded?");
    return null;
  }

  const principal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, rootTenantId),
      eq(intxSchema.principal.kind, "user"),
      eq(intxSchema.principal.refId, userId),
    ),
  });

  if (!principal) {
    log.error("Member principal not found for user in root tenant", {
      userId,
      tenantId: rootTenantId,
    });
    return null;
  }

  return {
    tenantId: rootTenantId,
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
