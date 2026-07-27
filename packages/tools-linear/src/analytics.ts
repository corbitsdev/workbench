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

const LIST_DASHBOARDS_QUERY = `query ListDashboards($first: Int!, $after: String) {
  dashboards(first: $first, after: $after) {
    nodes { id name description }
    pageInfo { endCursor hasNextPage }
  }
}`;

const ListDashboardsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export async function listDashboards(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListDashboardsArgsSchema,
    rawArgs,
    "linear_list_dashboards",
  );
  const pagination = resolveListPagination(
    args,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  try {
    const data = await fetchLinearGraphQL(
      config,
      LIST_DASHBOARDS_QUERY,
      paginationVariables(pagination),
      signal,
    );
    return connectionResult(data.dashboards);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      unsupported: true,
      reason:
        "Dashboard listing requires Linear analytics access or may not be exposed on this API version.",
      detail: message,
    };
  }
}

export const LINEAR_LIST_DASHBOARDS_DEFINITION: ToolDefinition = {
  name: "linear_list_dashboards",
  description:
    "List analytics dashboards when the token has access; otherwise returns an unsupported marker.",
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
