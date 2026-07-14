import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import {
  connectionResult,
  paginationVariables,
  resolveListPagination,
} from "./pagination";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isRecord,
  optionalString,
  parseArgs,
  type LinearToolsConfig,
} from "./shared";
import { resolveTeamId } from "./teams";

const LIST_STATUSES_QUERY = `query ListStatuses($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    states(first: $first, after: $after) {
      nodes { id name type color }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const GET_STATUS_QUERY = `query GetStatus($teamId: String!, $name: String!) {
  team(id: $teamId) {
    states(filter: { name: { eqIgnoreCase: $name } }) {
      nodes { id name type color }
    }
  }
}`;

const ListStatusesArgsSchema = type({
  team: "string > 0",
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

const GetStatusArgsSchema = type({
  "team?": "string > 0",
  "name?": "string > 0",
  "id?": "string",
});

export async function listIssueStatuses(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListStatusesArgsSchema,
    rawArgs,
    "linear_list_issue_statuses",
  );
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const resolvedTeamId = await resolveTeamId(config, args.team, signal);
  const data = await fetchLinearGraphQL(
    config,
    LIST_STATUSES_QUERY,
    { teamId: resolvedTeamId, ...paginationVariables(pagination) },
    signal,
  );
  if (!isRecord(data.team)) {
    throw new Error(`Linear team not found: ${args.team}`);
  }
  return connectionResult(data.team.states);
}

export async function getIssueStatus(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetStatusArgsSchema, rawArgs, "linear_get_issue_status");
  const statusId = optionalString(args.id);
  if (statusId !== null) {
    const data = await fetchLinearGraphQL(
      config,
      `query GetStatusById($id: String!) { workflowState(id: $id) { id name type color } }`,
      { id: statusId },
      signal,
    );
    if (data.workflowState === null || data.workflowState === undefined) {
      throw new Error(`Linear status not found: ${statusId}`);
    }
    return data.workflowState;
  }
  const team = optionalString(args.team);
  const name = optionalString(args.name);
  if (team === null || name === null) {
    throw new Error(
      "team and name are required when id is omitted for linear_get_issue_status",
    );
  }
  const resolvedTeamId = await resolveTeamId(config, team, signal);
  const data = await fetchLinearGraphQL(
    config,
    GET_STATUS_QUERY,
    { teamId: resolvedTeamId, name },
    signal,
  );
  if (!isRecord(data.team) || !isRecord(data.team.states)) {
    throw new Error(`Linear team not found: ${args.team}`);
  }
  const nodes = data.team.states.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`Linear status not found: ${args.name}`);
  }
  return nodes[0];
}

export const LINEAR_LIST_ISSUE_STATUSES_DEFINITION: ToolDefinition = {
  name: "linear_list_issue_statuses",
  description: "List workflow states for a team.",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string" },
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: ["team"],
  },
};

export const LINEAR_GET_ISSUE_STATUS_DEFINITION: ToolDefinition = {
  name: "linear_get_issue_status",
  description: "Get a workflow state by id or by team + name.",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string" },
      name: { type: "string" },
      id: { type: "string" },
    },
    required: [],
  },
};