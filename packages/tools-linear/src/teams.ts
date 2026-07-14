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
  optionalString,
  parseArgs,
  type LinearToolsConfig,
} from "./shared";

const LIST_TEAMS_QUERY = `query ListTeams($first: Int!, $after: String, $filter: TeamFilter) {
  teams(first: $first, after: $after, filter: $filter) {
    nodes { id name key description }
    pageInfo { endCursor hasNextPage }
  }
}`;

const GET_TEAM_QUERY = `query GetTeam($id: String!) {
  team(id: $id) {
    id name key description private archivedAt
  }
}`;

const ListTeamsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
});

const GetTeamArgsSchema = type({ id: "string > 0" });

export async function listTeams(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListTeamsArgsSchema, rawArgs, "linear_list_teams");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const query = optionalString(args.query);
  const filter = query !== null ? { name: { containsIgnoreCase: query } } : null;
  const data = await fetchLinearGraphQL(
    config,
    LIST_TEAMS_QUERY,
    {
      ...paginationVariables(pagination),
      ...(filter !== null ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.teams);
}

export async function getTeam(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetTeamArgsSchema, rawArgs, "linear_get_team");
  const data = await fetchLinearGraphQL(config, GET_TEAM_QUERY, { id: args.id }, signal);
  if (data.team === null || data.team === undefined) {
    throw new Error(`Linear team not found: ${args.id}`);
  }
  return data.team;
}

export const LINEAR_LIST_TEAMS_DEFINITION: ToolDefinition = {
  name: "linear_list_teams",
  description: "List Linear teams with optional name query and cursor pagination.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string", description: "Filter teams by name." },
    },
    required: [],
  },
};

export const LINEAR_GET_TEAM_DEFINITION: ToolDefinition = {
  name: "linear_get_team",
  description: "Get a Linear team by id, key, or name.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};