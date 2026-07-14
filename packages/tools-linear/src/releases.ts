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

const LIST_RELEASES_QUERY = `query ListReleases($first: Int!, $after: String, $filter: ReleaseFilter) {
  releases(first: $first, after: $after, filter: $filter) {
    nodes { id name version pipeline { name } stage { name } }
    pageInfo { endCursor hasNextPage }
  }
}`;

const RELEASE_CREATE = `mutation ReleaseCreate($input: ReleaseCreateInput!) {
  releaseCreate(input: $input) {
    success
    release { id name version }
  }
}`;

const RELEASE_UPDATE = `mutation ReleaseUpdate($id: String!, $input: ReleaseUpdateInput!) {
  releaseUpdate(id: $id, input: $input) {
    success
    release { id name version }
  }
}`;

const ListReleasesArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
  "pipeline?": "string",
});

const SaveReleaseArgsSchema = type({
  "id?": "string",
  name: "string > 0",
  pipeline: "string > 0",
  "version?": "string",
  "description?": "string",
});

export async function listReleases(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListReleasesArgsSchema, rawArgs, "linear_list_releases");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const query = optionalString(args.query);
  const pipeline = optionalString(args.pipeline);
  const filter: Record<string, unknown> = {};
  if (query !== null) filter.name = { containsIgnoreCase: query };
  if (pipeline !== null) filter.pipeline = { id: { eq: pipeline } };
  const data = await fetchLinearGraphQL(
    config,
    LIST_RELEASES_QUERY,
    {
      ...paginationVariables(pagination),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.releases);
}

export async function saveRelease(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SaveReleaseArgsSchema, rawArgs, "linear_save_release");
  const input: Record<string, unknown> = {
    name: args.name,
    pipelineId: args.pipeline,
  };
  if (args.version !== undefined) input.version = args.version;
  if (args.description !== undefined) input.description = args.description;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      RELEASE_UPDATE,
      { id: args.id, input },
      signal,
    );
    return requireMutationSuccess(data, "releaseUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    RELEASE_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "releaseCreate");
}

export const LINEAR_LIST_RELEASES_DEFINITION: ToolDefinition = {
  name: "linear_list_releases",
  description: "List releases with optional pipeline and query filters.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string" },
      pipeline: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_SAVE_RELEASE_DEFINITION: ToolDefinition = {
  name: "linear_save_release",
  description: "Create or update a release (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      pipeline: { type: "string" },
      version: { type: "string" },
      description: { type: "string" },
    },
    required: ["name", "pipeline"],
  },
};