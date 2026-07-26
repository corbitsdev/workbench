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
  requireMutationSuccess,
  type LinearToolsConfig,
} from "./shared";

const LIST_INITIATIVES_QUERY = `query ListInitiatives($first: Int!, $after: String, $filter: InitiativeFilter) {
  initiatives(first: $first, after: $after, filter: $filter) {
    nodes { id name status description }
    pageInfo { endCursor hasNextPage }
  }
}`;

const INITIATIVE_CREATE = `mutation InitiativeCreate($input: InitiativeCreateInput!) {
  initiativeCreate(input: $input) {
    success
    initiative { id name }
  }
}`;

const INITIATIVE_UPDATE = `mutation InitiativeUpdate($id: String!, $input: InitiativeUpdateInput!) {
  initiativeUpdate(id: $id, input: $input) {
    success
    initiative { id name }
  }
}`;

const ListInitiativesArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
});

const SaveInitiativeArgsSchema = type({
  "id?": "string",
  name: "string > 0",
  "description?": "string",
  "status?": "string",
});

export async function listInitiatives(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListInitiativesArgsSchema,
    rawArgs,
    "linear_list_initiatives",
  );
  const pagination = resolveListPagination(
    args,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const query = optionalString(args.query);
  const filter =
    query !== null ? { name: { containsIgnoreCase: query } } : null;
  const data = await fetchLinearGraphQL(
    config,
    LIST_INITIATIVES_QUERY,
    {
      ...paginationVariables(pagination),
      ...(filter !== null ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.initiatives);
}

export async function saveInitiative(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    SaveInitiativeArgsSchema,
    rawArgs,
    "linear_save_initiative",
  );
  const input: Record<string, unknown> = { name: args.name };
  if (args.description !== undefined) input.description = args.description;
  if (args.status !== undefined) input.status = args.status;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      INITIATIVE_UPDATE,
      { id: args.id, input },
      signal,
    );
    return requireMutationSuccess(data, "initiativeUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    INITIATIVE_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "initiativeCreate");
}

export const LINEAR_LIST_INITIATIVES_DEFINITION: ToolDefinition = {
  name: "linear_list_initiatives",
  description: "List workspace initiatives.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_SAVE_INITIATIVE_DEFINITION: ToolDefinition = {
  name: "linear_save_initiative",
  description: "Create or update an initiative (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
    },
    required: ["name"],
  },
};
