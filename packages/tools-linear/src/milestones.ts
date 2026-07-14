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
  parseArgs,
  requireMutationSuccess,
  type LinearToolsConfig,
} from "./shared";

const LIST_MILESTONES_QUERY = `query ListMilestones($projectId: String!, $first: Int!, $after: String) {
  project(id: $projectId) {
    projectMilestones(first: $first, after: $after) {
      nodes { id name description targetDate }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const MILESTONE_CREATE = `mutation MilestoneCreate($input: ProjectMilestoneCreateInput!) {
  projectMilestoneCreate(input: $input) {
    success
    projectMilestone { id name }
  }
}`;

const MILESTONE_UPDATE = `mutation MilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
  projectMilestoneUpdate(id: $id, input: $input) {
    success
    projectMilestone { id name }
  }
}`;

const ListMilestonesArgsSchema = type({
  project: "string > 0",
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

const SaveMilestoneArgsSchema = type({
  "id?": "string",
  project: "string > 0",
  name: "string > 0",
  "description?": "string",
  "targetDate?": "string",
});

export async function listMilestones(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListMilestonesArgsSchema, rawArgs, "linear_list_milestones");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_MILESTONES_QUERY,
    { projectId: args.project, ...paginationVariables(pagination) },
    signal,
  );
  if (!isRecord(data.project)) {
    throw new Error(`Linear project not found: ${args.project}`);
  }
  return connectionResult(data.project.projectMilestones);
}

export async function saveMilestone(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SaveMilestoneArgsSchema, rawArgs, "linear_save_milestone");
  const input: Record<string, unknown> = {
    name: args.name,
    projectId: args.project,
  };
  if (args.description !== undefined) input.description = args.description;
  if (args.targetDate !== undefined) input.targetDate = args.targetDate;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      MILESTONE_UPDATE,
      { id: args.id, input },
      signal,
    );
    return requireMutationSuccess(data, "projectMilestoneUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    MILESTONE_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "projectMilestoneCreate");
}

export const LINEAR_LIST_MILESTONES_DEFINITION: ToolDefinition = {
  name: "linear_list_milestones",
  description: "List milestones for a Linear project.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id or slug." },
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: ["project"],
  },
};

export const LINEAR_SAVE_MILESTONE_DEFINITION: ToolDefinition = {
  name: "linear_save_milestone",
  description: "Create or update a project milestone (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      project: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      targetDate: { type: "string" },
    },
    required: ["project", "name"],
  },
};