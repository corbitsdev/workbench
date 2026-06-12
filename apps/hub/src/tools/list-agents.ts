import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { schema as intxSchema } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import {
  parseListLimit,
  parsePrincipalIds,
  resolveStatusFilter,
  type AgentInstanceStatus,
} from '@workbench/tools-agents';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { memberAgentInstance } from '../db/schema';
import type { ContextToolEntry } from '../lib/tool-registry';

export const LIST_AGENTS_DEFINITION: ToolDefinition = {
  name: 'list_agents',
  description:
    'List the agents you can address. Returns each agent instance with its name, mail address, status, definition id, and instance id. Use the address with mail_send to message an agent. By default returns your own operator\'s running agents — the agents owned by the same user you act for. Pass a status to filter (or "all" for every status), and a principals array of member principal ids (from list_principals) to list another operator\'s agents instead.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          'Status filter: deployed, running, updating, error, stopped, or all. Defaults to running (agents reachable right now). Use all to return every status.',
      },
      principals: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Member (user) principal ids whose agents to list. Defaults to your own operator. Get ids from list_principals to address another operator's agents.",
      },
      limit: {
        type: 'number',
        description: 'Maximum number of agents to return (1-200, default 50).',
      },
    },
    required: [],
  },
};

export type ListAgentsContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
};

/**
 * Resolve which agent-instance ids to list, honouring per-user ownership.
 *
 * - Explicit `memberPrincipals` → every instance those members own.
 * - Otherwise resolve the caller's owning member (the user this agent acts for)
 *   via `member_agent_instance` and return that member's instances.
 * - Returns `null` when the caller is not a member-owned instance (e.g. a
 *   dispatched or admin-launched agent). The caller's owner is unknown, so the
 *   handler fails closed: in the shared org tenant a tenant-wide listing would
 *   expose every other operator's agents.
 */
export async function resolveOwnedInstanceIds(
  db: DB['db'],
  context: { tenantId: string; principalId: string },
  memberPrincipals: string[] | undefined
): Promise<string[] | null> {
  let members = memberPrincipals;

  if (members === undefined) {
    const callerRows = await db
      .select({ id: intxSchema.agentInstance.id })
      .from(intxSchema.agentInstance)
      .where(
        and(
          eq(intxSchema.agentInstance.tenantId, context.tenantId),
          eq(intxSchema.agentInstance.principalId, context.principalId)
        )
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
          eq(memberAgentInstance.instanceId, callerInstanceId)
        )
      )
      .limit(1);

    const ownerPrincipalId = ownerRows[0]?.memberPrincipalId;
    if (ownerPrincipalId === undefined) return null;
    members = [ownerPrincipalId];
  }

  const ownedRows = await db
    .select({ instanceId: memberAgentInstance.instanceId })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, context.tenantId),
        inArray(memberAgentInstance.memberPrincipalId, members)
      )
    );

  return ownedRows.map((row) => row.instanceId);
}

export function createListAgentsTool(context: ListAgentsContext): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: LIST_AGENTS_DEFINITION,
      handler: async (args) => {
        const status = resolveStatusFilter(args.status);
        const memberPrincipals = parsePrincipalIds(args.principals);
        const limit = parseListLimit(args.limit);

        const instanceIds = await resolveOwnedInstanceIds(context.db, context, memberPrincipals);

        // Fail closed: an unresolved owner (null) or an owner with no instances
        // ([]) returns an empty directory, never a tenant-wide listing — in the
        // shared org tenant that would expose every other operator's agents.
        if (instanceIds === null || instanceIds.length === 0) {
          return JSON.stringify({ agents: [] }, null, 2);
        }

        const conditions = [
          eq(intxSchema.agentInstance.tenantId, context.tenantId),
          inArray(intxSchema.agentInstance.id, instanceIds),
        ];
        if (status !== undefined) {
          conditions.push(eq(intxSchema.agentInstance.status, status as AgentInstanceStatus));
        }

        const rows = await context.db
          .select({
            instanceId: intxSchema.agentInstance.id,
            name: intxSchema.agent.name,
            address: intxSchema.agentInstance.address,
            status: intxSchema.agentInstance.status,
            agentDefinitionId: intxSchema.agentInstance.agentId,
          })
          .from(intxSchema.agentInstance)
          .innerJoin(intxSchema.agent, eq(intxSchema.agentInstance.agentId, intxSchema.agent.id))
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
    definition: LIST_AGENTS_DEFINITION,
    createTools: (context) =>
      createListAgentsTool({
        db: context.db,
        tenantId: context.tenantId,
        principalId: context.principalId,
      }),
  },
};
