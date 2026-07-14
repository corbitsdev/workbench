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

const LIST_USERS_QUERY = `query ListUsers($first: Int!, $after: String, $filter: UserFilter) {
  users(first: $first, after: $after, filter: $filter) {
    nodes { id name email active admin }
    pageInfo { endCursor hasNextPage }
  }
}`;

const GET_USER_QUERY = `query GetUser($id: String!) {
  user(id: $id) {
    id name email active admin
  }
}`;

const ListUsersArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
  "team?": "string",
});

const GetUserArgsSchema = type({ id: "string > 0" });

export async function listUsers(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListUsersArgsSchema, rawArgs, "linear_list_users");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const query = optionalString(args.query);
  const team = optionalString(args.team);
  const filter: Record<string, unknown> = {};
  if (query !== null) {
    filter.name = { containsIgnoreCase: query };
  }
  if (team !== null) {
    filter.team = { id: { eq: team } };
  }
  const data = await fetchLinearGraphQL(
    config,
    LIST_USERS_QUERY,
    {
      ...paginationVariables(pagination),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.users);
}

export async function getUser(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetUserArgsSchema, rawArgs, "linear_get_user");
  const data = await fetchLinearGraphQL(config, GET_USER_QUERY, { id: args.id }, signal);
  if (data.user === null || data.user === undefined) {
    throw new Error(`Linear user not found: ${args.id}`);
  }
  return data.user;
}

export const LINEAR_LIST_USERS_DEFINITION: ToolDefinition = {
  name: "linear_list_users",
  description: "List Linear users with optional query and team filter.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string" },
      team: { type: "string", description: "Team id to scope users." },
    },
    required: [],
  },
};

export const LINEAR_GET_USER_DEFINITION: ToolDefinition = {
  name: "linear_get_user",
  description: "Get a Linear user by id, name, or email.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};