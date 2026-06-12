import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import type { ToolDefinition } from '@intx/types/runtime';
import { createPrincipalsTools, LIST_PRINCIPALS_DEFINITION } from './principals';

export type { ToolDefinition };
export {
  createPrincipalsTools,
  LIST_PRINCIPALS_DEFINITION,
  resolvePrincipalKind,
  resolvePrincipalStatusFilter,
} from './principals';
export type { ListPrincipalsContext } from './principals';

export const AGENT_INSTANCE_STATUSES = [
  'deployed',
  'running',
  'updating',
  'error',
  'stopped',
] as const;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

const DEFAULT_STATUS: AgentInstanceStatus = 'running';
const ALL_STATUSES = 'all';
const STATUS_VALUES = [...AGENT_INSTANCE_STATUSES, ALL_STATUSES] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Resolve the agent-instance status filter. Defaults to `running` (the agents
 * reachable right now); `all` removes the filter; anything else must be one of
 * the known instance statuses.
 */
export function resolveStatusFilter(value: unknown): AgentInstanceStatus | undefined {
  if (value === undefined) return DEFAULT_STATUS;
  if (typeof value !== 'string') {
    throw new Error('status must be a string');
  }
  if (value === ALL_STATUSES) return undefined;
  if (!AGENT_INSTANCE_STATUSES.includes(value as AgentInstanceStatus)) {
    throw new Error(`status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
  return value as AgentInstanceStatus;
}

/**
 * Validate an optional `principals` argument. Returns the provided ids, or
 * `undefined` when the argument is absent (the caller decides the default).
 */
export function parsePrincipalIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('principals must be an array of principal ids');
  }
  if (value.length === 0) {
    throw new Error('principals must be a non-empty array of principal ids');
  }
  if (!value.every((id) => typeof id === 'string')) {
    throw new Error('principals must contain only strings');
  }
  return value as string[];
}

export function parseListLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT);
}

/**
 * Hub tool registry entries owned by this package. The agent directory
 * (`list_agents`) lives in the hub because it resolves per-user instance
 * ownership from the hub-owned `member_agent_instance` table; this package
 * exposes the principal directory and the shared, db-free query helpers it
 * reuses.
 */
export const AGENTS_HUB_TOOLS = {
  list_principals: {
    definition: LIST_PRINCIPALS_DEFINITION,
    createTools: (context: { db: DB['db']; tenantId: string }): AgentTool[] =>
      createPrincipalsTools(context),
  },
};
