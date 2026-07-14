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

const SEARCH_ISSUES_QUERY = `query SearchIssues($term: String!, $first: Int!, $after: String) {
  searchIssues(term: $term, first: $first, after: $after) {
    nodes {
      id identifier title url
      state { name }
      team { name }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

const SearchArgsSchema = type({
  query: "string > 0",
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export async function searchLinear(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SearchArgsSchema, rawArgs, "linear_search");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    SEARCH_ISSUES_QUERY,
    { term: args.query, ...paginationVariables(pagination) },
    signal,
  );
  return connectionResult(data.searchIssues);
}

export const LINEAR_SEARCH_DEFINITION: ToolDefinition = {
  name: "linear_search",
  description: "Search Linear issues by text term.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term." },
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: ["query"],
  },
};