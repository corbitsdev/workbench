import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  createPrincipalsTools,
  LIST_PRINCIPALS_DEFINITION,
} from "./principals";

export type { ToolDefinition };
export {
  createPrincipalsTools,
  LIST_PRINCIPALS_DEFINITION,
  resolvePrincipalKind,
  resolvePrincipalStatusFilter,
} from "./principals";
export type { ListPrincipalsContext } from "./principals";
export { IDENTITY_GET_DEFINITION, IDENTITY_SET_DEFINITION } from "./identity";

const AgentInstanceStatusSchema = type(
  "'deployed' | 'running' | 'updating' | 'error' | 'stopped'",
);
export type AgentInstanceStatus = typeof AgentInstanceStatusSchema.infer;

export const AGENT_INSTANCE_STATUSES = [
  "deployed",
  "running",
  "updating",
  "error",
  "stopped",
] as const satisfies readonly AgentInstanceStatus[];

const ALL_STATUSES = "all";
const STATUS_VALUES = [...AGENT_INSTANCE_STATUSES, ALL_STATUSES] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const PrincipalIdsSchema = type("string[]");

/**
 * Resolve the agent-instance status filter. Defaults to `running` (the agents
 * reachable right now); `all` removes the filter; anything else must be one of
 * the known instance statuses.
 */
export function resolveStatusFilter(
  value: unknown,
): AgentInstanceStatus | undefined {
  if (value === undefined) return "running";
  if (typeof value !== "string") {
    throw new Error("status must be a string");
  }
  if (value === ALL_STATUSES) return undefined;
  const parsed = AgentInstanceStatusSchema(value);
  if (parsed instanceof type.errors) {
    throw new Error(`status must be one of: ${STATUS_VALUES.join(", ")}`);
  }
  return parsed;
}

/**
 * Validate an optional `principals` argument. Returns the provided ids, or
 * `undefined` when the argument is absent (the caller decides the default).
 */
export function parsePrincipalIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("principals must be an array of principal ids");
  }
  if (value.length === 0) {
    throw new Error("principals must be a non-empty array of principal ids");
  }
  const parsed = PrincipalIdsSchema(value);
  if (parsed instanceof type.errors) {
    throw new Error("principals must contain only strings");
  }
  return parsed;
}

export function parseListLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT);
}

/**
 * Hub tool registry entries owned by this package. The agent directory
 * (`list_agents`) lives in the hub because it resolves per-user instance
 * ownership from the hub-owned `member_agent_instance` table; this package
 * exposes the principal directory and the shared, db-free query helpers it
 * reuses.
 */
export const SEARCH_AGENTS_DEFINITION: ToolDefinition = {
  name: "search_agents",
  description:
    "Search the agents you can address by keyword. Matches against each agent's name and description so you can find the right specialist before messaging it with mail_send. Returns the same fields as list_agents (name, description, mail address, status, definition id, instance id), ranked by match strength, scoped to your own operator's agents (or another operator's via principals, from list_principals).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to match against agent name and description.",
      },
      principals: {
        type: "array",
        items: { type: "string" },
        description:
          "Member (user) principal ids whose agents to search. Defaults to your own operator. Get ids from list_principals to search another operator's agents.",
      },
      limit: {
        type: "number",
        description: "Maximum number of matches to return (1-200, default 50).",
      },
    },
    required: ["query"],
  },
};

export const LIST_AGENTS_DEFINITION: ToolDefinition = {
  name: "list_agents",
  description:
    "List the agents you can address. Returns each agent instance with its name, description (what the agent is for — use it to pick the right specialist), mail address, status, definition id, and instance id. Use the address with mail_send to message an agent. By default returns your own operator's running agents — the agents owned by the same user you act for. Pass a status to filter (or \"all\" for every status), and a principals array of member principal ids (from list_principals) to list another operator's agents instead.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Status filter: deployed, running, updating, error, stopped, or all. Defaults to running (agents reachable right now). Use all to return every status.",
      },
      principals: {
        type: "array",
        items: { type: "string" },
        description:
          "Member (user) principal ids whose agents to list. Defaults to your own operator. Get ids from list_principals to address another operator's agents.",
      },
      limit: {
        type: "number",
        description: "Maximum number of agents to return (1-200, default 50).",
      },
    },
    required: [],
  },
};

export const AGENTS_HUB_TOOLS = {
  list_principals: {
    sideEffect: "read" as const,
    definition: LIST_PRINCIPALS_DEFINITION,
    createTools: (context: { db: DB["db"]; tenantId: string }): AgentTool[] =>
      createPrincipalsTools(context),
  },
};
