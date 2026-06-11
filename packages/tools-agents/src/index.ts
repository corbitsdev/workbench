import type { AgentTool } from '@intx/agent';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import { and, desc, eq } from 'drizzle-orm';

export type { ToolDefinition };

const AGENT_INSTANCE_STATUSES = ['deployed', 'running', 'updating', 'error', 'stopped'] as const;
type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const LIST_AGENTS_DEFINITION: ToolDefinition = {
  name: 'list_agents',
  description:
    'List the agents in this workbench so you can address them. Returns each agent instance with its name, mail address, status, definition id, and instance id. Use the address with mail_send to message an agent. Optionally filter by status (e.g. running).',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          'Optional status filter: deployed, running, updating, error, or stopped. Use running to find agents reachable right now.',
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
};

function parseStatus(value: unknown): AgentInstanceStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('status must be a string');
  }
  if (!AGENT_INSTANCE_STATUSES.includes(value as AgentInstanceStatus)) {
    throw new Error(`status must be one of: ${AGENT_INSTANCE_STATUSES.join(', ')}`);
  }
  return value as AgentInstanceStatus;
}

function parseLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT);
}

export function createAgentsTools(context: ListAgentsContext): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: LIST_AGENTS_DEFINITION,
      handler: async (args) => {
        const status = parseStatus(args.status);
        const limit = parseLimit(args.limit);

        const conditions = [eq(intxSchema.agentInstance.tenantId, context.tenantId)];
        if (status !== undefined) {
          conditions.push(eq(intxSchema.agentInstance.status, status));
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

/**
 * Hub tool registry entry for the agent directory. A context tool (no provider
 * credential): it reads the tenant's agent instances directly from the
 * Interchange db. Import and spread into the hub's KNOWN_TOOLS to register.
 */
export const AGENTS_HUB_TOOLS = {
  list_agents: {
    definition: LIST_AGENTS_DEFINITION,
    createTools: (context: { db: DB['db']; tenantId: string }): AgentTool[] =>
      createAgentsTools(context),
  },
};
