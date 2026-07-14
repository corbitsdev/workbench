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

const LIST_PROJECTS_QUERY = `query ListProjects($first: Int!, $after: String, $filter: ProjectFilter) {
  projects(first: $first, after: $after, filter: $filter) {
    nodes { id name slug state description url }
    pageInfo { endCursor hasNextPage }
  }
}`;

const GET_PROJECT_QUERY = `query GetProject($id: String!) {
  project(id: $id) {
    id name slug state description url lead { name } teams { nodes { name } }
  }
}`;

const PROJECT_CREATE = `mutation ProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    success
    project { id name slug url }
  }
}`;

const PROJECT_UPDATE = `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) {
    success
    project { id name slug url }
  }
}`;

const ListProjectsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
  "team?": "string",
});

const GetProjectArgsSchema = type({ id: "string > 0" });

const SaveProjectArgsSchema = type({
  "id?": "string",
  name: "string > 0",
  "description?": "string",
  "teamIds?": "string[]",
  "state?": "string",
});

export async function listProjects(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListProjectsArgsSchema, rawArgs, "linear_list_projects");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const query = optionalString(args.query);
  const team = optionalString(args.team);
  const filter: Record<string, unknown> = {};
  if (query !== null) filter.name = { containsIgnoreCase: query };
  if (team !== null) filter.teams = { id: { eq: team } };
  const data = await fetchLinearGraphQL(
    config,
    LIST_PROJECTS_QUERY,
    {
      ...paginationVariables(pagination),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.projects);
}

export async function getProject(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetProjectArgsSchema, rawArgs, "linear_get_project");
  const data = await fetchLinearGraphQL(
    config,
    GET_PROJECT_QUERY,
    { id: args.id },
    signal,
  );
  if (data.project === null || data.project === undefined) {
    throw new Error(`Linear project not found: ${args.id}`);
  }
  return data.project;
}

export async function saveProject(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SaveProjectArgsSchema, rawArgs, "linear_save_project");
  const input: Record<string, unknown> = { name: args.name };
  if (args.description !== undefined) input.description = args.description;
  if (args.teamIds !== undefined) input.teamIds = args.teamIds;
  if (args.state !== undefined) input.state = args.state;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      PROJECT_UPDATE,
      { id: args.id, input },
      signal,
    );
    return requireMutationSuccess(data, "projectUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    PROJECT_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "projectCreate");
}

export const LINEAR_LIST_PROJECTS_DEFINITION: ToolDefinition = {
  name: "linear_list_projects",
  description: "List Linear projects with optional query and team filter.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string" },
      team: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_GET_PROJECT_DEFINITION: ToolDefinition = {
  name: "linear_get_project",
  description: "Get a project by id, slug, or name.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

export const LINEAR_SAVE_PROJECT_DEFINITION: ToolDefinition = {
  name: "linear_save_project",
  description: "Create or update a Linear project (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      teamIds: { type: "array", items: { type: "string" } },
      state: { type: "string" },
    },
    required: ["name"],
  },
};