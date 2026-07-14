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
  parseArgs,
  type LinearToolsConfig,
} from "./shared";

const LIST_VIEWS_QUERY = `query ListViews($first: Int!, $after: String) {
  customViews(first: $first, after: $after) {
    nodes { id name description filterData team { name } }
    pageInfo { endCursor hasNextPage }
  }
}`;

const ListViewsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export async function listViews(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListViewsArgsSchema, rawArgs, "linear_list_views");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_VIEWS_QUERY,
    paginationVariables(pagination),
    signal,
  );
  return connectionResult(data.customViews);
}

export const LINEAR_LIST_VIEWS_DEFINITION: ToolDefinition = {
  name: "linear_list_views",
  description: "List custom views in the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: [],
  },
};