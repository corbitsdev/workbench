import { eq, and } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

const { agentInstance, principal } = intxSchema;

/**
 * Resolves the caller's principal in the instance's tenant and verifies they
 * own the instance via memberAgentInstance. Returns null when either check
 * fails. Resolving the caller in the instance's tenant (rather than a tenant
 * supplied by the request) is what keeps the ownership check tenancy-correct:
 * memberAgentInstance.memberPrincipalId lives in the same tenant the instance
 * was provisioned in.
 */
export async function resolveInstanceOwner(
  db: HubDb,
  instanceId: string,
  userId: string,
): Promise<{ principalId: string; tenantId: string } | null> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  if (!instance) return null;

  const callerPrincipal = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, instance.tenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userId),
    ),
  });
  if (!callerPrincipal) return null;

  const ownership = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.instanceId, instanceId),
      eq(memberAgentInstance.memberPrincipalId, callerPrincipal.id),
    ),
  });
  if (!ownership) return null;

  return { principalId: callerPrincipal.id, tenantId: instance.tenantId };
}
