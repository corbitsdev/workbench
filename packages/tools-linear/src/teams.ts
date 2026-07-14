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

const TEAM_BY_NAME_QUERY = `query TeamByName($name: String!) {
  teams(first: 1, filter: { name: { eqIgnoreCase: $name } }) {
    nodes { id }
  }
}`;

export async function resolveTeamId(
  config: LinearToolsConfig,
  teamOrId: string,
  signal: AbortSignal,
): Promise<string> {
  const direct = await fetchLinearGraphQL(
    config,
    GET_TEAM_QUERY,
    { id: teamOrId },
    signal,
  );
  if (direct.team !== null && direct.team !== undefined) {
    const row = direct.team as Record<string, unknown>;
    const id = optionalString(row.id);
    if (id !== null) {
      return id;
    }
  }
  const byName = await fetchLinearGraphQL(
    config,
    TEAM_BY_NAME_QUERY,
    { name: teamOrId },
    signal,
  );
  const nodes = (byName.teams as Record<string, unknown> | undefined)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`Linear team not found: ${teamOrId}`);
  }
  const first = nodes[0];
  if (typeof first !== "object" || first === null) {
    throw new Error(`Linear team not found: ${teamOrId}`);
  }
  const id = optionalString((first as Record<string, unknown>).id);
  if (id === null) {
    throw new Error(`Linear team not found: ${teamOrId}`);
  }
  return id;
}

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
  const teamId = await resolveTeamId(config, args.id, signal);
  const data = await fetchLinearGraphQL(config, GET_TEAM_QUERY, { id: teamId }, signal);
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