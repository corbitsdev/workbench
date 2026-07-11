import { eq, and, inArray } from "drizzle-orm";
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

/**
 * Whether the calling user may resolve (approve/reject) an approval. True when
 * the approval targets the caller's own principal directly, or when it was
 * created by an agent instance the caller owns. The instance path is what makes
 * agent-created approvals resolvable at all: the sidecar records the agent's
 * synthetic per-instance principal, not the owning user's principal, so a
 * direct principal comparison never matches for a Myra approval.
 */
export async function callerCanResolveApproval(
  db: HubDb,
  approval: { principalId: string; tenantId: string },
  userId: string,
): Promise<boolean> {
  const callerPrincipal = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, approval.tenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userId),
    ),
  });
  if (!callerPrincipal) return false;
  if (approval.principalId === callerPrincipal.id) return true;

  const instance = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.principalId, approval.principalId),
      eq(agentInstance.tenantId, approval.tenantId),
    ),
  });
  if (!instance) return false;

  const owner = await resolveInstanceOwner(db, instance.id, userId);
  return owner !== null;
}

/**
 * The set of principal ids whose approvals a caller may see in a tenant: their
 * own user principal, plus the synthetic per-instance principals of every agent
 * instance they own. Used to scope the approvals list so one tenant member does
 * not see another member's pending tool-call arguments.
 */
export async function resolveOwnedApprovalPrincipalIds(
  db: HubDb,
  tenantId: string,
  callerPrincipalId: string,
): Promise<string[]> {
  const memberships = await db.query.memberAgentInstance.findMany({
    where: eq(memberAgentInstance.memberPrincipalId, callerPrincipalId),
  });
  if (memberships.length === 0) return [callerPrincipalId];

  const instanceIds = memberships.map((m) => m.instanceId);
  const instances = await db.query.agentInstance.findMany({
    where: and(
      inArray(agentInstance.id, instanceIds),
      eq(agentInstance.tenantId, tenantId),
    ),
  });
  return [callerPrincipalId, ...instances.map((i) => i.principalId)];
}
