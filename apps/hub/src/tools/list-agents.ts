import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";
import {
  LIST_AGENTS_DEFINITION,
  parseListLimit,
  parsePrincipalIds,
  resolveStatusFilter,
  type AgentInstanceStatus,
} from "@workbench/tools-agents";
import { and, desc, eq, inArray, isNull, or } from "./sql-predicates";
import { memberAgentInstance } from "../db/schema";
import type { ContextToolEntry } from "../lib/tool-registry";

export { LIST_AGENTS_DEFINITION };

export type ListAgentsContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
};

/**
 * Resolve which agent-instance ids to list, honouring per-user ownership.
 *
 * - Explicit `memberPrincipals` → every instance those members own, scoped to
 *   context.tenantId only (explicit principal lists come from list_principals
 *   which is already tenant-scoped).
 * - Otherwise resolve the caller's owning member (the user this agent acts for)
 *   via `member_agent_instance`, then collect all of that user's principals
 *   across every tenant they belong to, and return instances from all of them.
 *   This ensures agents deployed in workbench (child) tenants are visible even
 *   when the calling agent (Myra) lives in the global org tenant.
 * - Returns `null` when the caller is not a member-owned instance (e.g. a
 *   dispatched or admin-launched agent). The caller's owner is unknown, so the
 *   handler fails closed: in the shared org tenant a tenant-wide listing would
 *   expose every other operator's agents.
 */
/**
 * Resolve the member principal id that owns the calling agent instance (the
 * user this agent acts for), via the caller's own `agentInstance` row and its
 * `member_agent_instance` mapping. Returns `null` when the caller is not a
 * member-owned instance (e.g. a dispatched or admin-launched agent) —
 * callers must fail closed on `null`, never fall back to a tenant-wide scope.
 */
export async function resolveOwningMemberPrincipalId(
  db: DB["db"],
  context: { tenantId: string; principalId: string },
): Promise<string | null> {
  const callerRows = await db
    .select({ id: intxSchema.agentInstance.id })
    .from(intxSchema.agentInstance)
    .where(
      and(
        eq(intxSchema.agentInstance.tenantId, context.tenantId),
        eq(intxSchema.agentInstance.principalId, context.principalId),
      ),
    )
    .limit(1);

  const callerInstanceId = callerRows[0]?.id;
  if (callerInstanceId === undefined) return null;

  const ownerRows = await db
    .select({ memberPrincipalId: memberAgentInstance.memberPrincipalId })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, context.tenantId),
        eq(memberAgentInstance.instanceId, callerInstanceId),
      ),
    )
    .limit(1);

  return ownerRows[0]?.memberPrincipalId ?? null;
}

export async function resolveOwnedInstanceIds(
  db: DB["db"],
  context: { tenantId: string; principalId: string },
  memberPrincipals: string[] | undefined,
): Promise<string[] | null> {
  if (memberPrincipals !== undefined) {
    const ownedRows = await db
      .select({ instanceId: memberAgentInstance.instanceId })
      .from(memberAgentInstance)
      .where(
        and(
          eq(memberAgentInstance.tenantId, context.tenantId),
          inArray(memberAgentInstance.memberPrincipalId, memberPrincipals),
        ),
      );
    return ownedRows.map((row) => row.instanceId);
  }

  const ownerPrincipalId = await resolveOwningMemberPrincipalId(db, context);
  if (ownerPrincipalId === null) return null;

  // Resolve the user's refId from their member principal so we can find all
  // their principals across every tenant (global org + workbenches).
  const ownerPrincipalRows = await db
    .select({ refId: intxSchema.principal.refId })
    .from(intxSchema.principal)
    .where(eq(intxSchema.principal.id, ownerPrincipalId))
    .limit(1);
  const userRefId = ownerPrincipalRows[0]?.refId;
  if (!userRefId) return null;

  // Collect every user principal for this person across all tenants.
  const allUserPrincipals = await db
    .select({ id: intxSchema.principal.id })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.kind, "user"),
        eq(intxSchema.principal.refId, userRefId),
        or(
          isNull(intxSchema.principal.status),
          eq(intxSchema.principal.status, "active"),
        ),
      ),
    );

  if (allUserPrincipals.length === 0) return null;

  const allPrincipalIds = allUserPrincipals.map((p) => p.id);

  // Return instances owned by any of those principals in any tenant.
  const ownedRows = await db
    .select({ instanceId: memberAgentInstance.instanceId })
    .from(memberAgentInstance)
    .where(inArray(memberAgentInstance.memberPrincipalId, allPrincipalIds));

  return ownedRows.map((row) => row.instanceId);
}

export function createListAgentsTool(context: ListAgentsContext): AgentTool[] {
  return [
    {
      kind: "string",
      definition: LIST_AGENTS_DEFINITION,
      handler: async (args) => {
        const status = resolveStatusFilter(args.status);
        const memberPrincipals = parsePrincipalIds(args.principals);
        const limit = parseListLimit(args.limit);

        const instanceIds = await resolveOwnedInstanceIds(
          context.db,
          context,
          memberPrincipals,
        );

        // Fail closed: an unresolved owner (null) or an owner with no instances
        // ([]) returns an empty directory, never a tenant-wide listing — in the
        // shared org tenant that would expose every other operator's agents.
        if (instanceIds === null || instanceIds.length === 0) {
          return JSON.stringify({ agents: [] }, null, 2);
        }

        const conditions = [inArray(intxSchema.agentInstance.id, instanceIds)];
        if (status !== undefined) {
          conditions.push(
            eq(intxSchema.agentInstance.status, status as AgentInstanceStatus),
          );
        }

        const rows = await context.db
          .select({
            instanceId: intxSchema.agentInstance.id,
            name: intxSchema.agent.name,
            description: intxSchema.agent.description,
            address: intxSchema.agentInstance.address,
            status: intxSchema.agentInstance.status,
            agentDefinitionId: intxSchema.agentInstance.agentId,
          })
          .from(intxSchema.agentInstance)
          .innerJoin(
            intxSchema.agent,
            eq(intxSchema.agentInstance.agentId, intxSchema.agent.id),
          )
          .where(and(...conditions))
          .orderBy(desc(intxSchema.agentInstance.createdAt))
          .limit(limit);

        return JSON.stringify({ agents: rows }, null, 2);
      },
    },
  ];
}

export const LIST_AGENTS_HUB_TOOLS: Record<string, ContextToolEntry> = {
  list_agents: {
    sideEffect: "read",
    definition: LIST_AGENTS_DEFINITION,
    createTools: (context) =>
      createListAgentsTool({
        db: context.db,
        tenantId: context.tenantId,
        principalId: context.principalId,
      }),
  },
};
