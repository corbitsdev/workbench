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

const LIST_ISSUE_LABELS_QUERY = `query ListIssueLabels($first: Int!, $after: String, $filter: IssueLabelFilter) {
  issueLabels(first: $first, after: $after, filter: $filter) {
    nodes { id name color description }
    pageInfo { endCursor hasNextPage }
  }
}`;

const LIST_PROJECT_LABELS_QUERY = `query ListProjectLabels($first: Int!, $after: String) {
  projectLabels(first: $first, after: $after) {
    nodes { id name color }
    pageInfo { endCursor hasNextPage }
  }
}`;

const LIST_INITIATIVE_LABELS_QUERY = `query ListInitiativeLabels($first: Int!, $after: String) {
  initiativeLabels(first: $first, after: $after) {
    nodes { id name color }
    pageInfo { endCursor hasNextPage }
  }
}`;

const ISSUE_LABEL_CREATE = `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

const ListIssueLabelsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "name?": "string",
  "team?": "string",
});

const CreateIssueLabelArgsSchema = type({
  name: "string > 0",
  "color?": "string",
  "description?": "string",
  "teamId?": "string",
});

const ListLabelsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export async function listIssueLabels(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListIssueLabelsArgsSchema,
    rawArgs,
    "linear_list_issue_labels",
  );
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const name = optionalString(args.name);
  const team = optionalString(args.team);
  const filter: Record<string, unknown> = {};
  if (name !== null) filter.name = { containsIgnoreCase: name };
  if (team !== null) filter.team = { id: { eq: team } };
  const data = await fetchLinearGraphQL(
    config,
    LIST_ISSUE_LABELS_QUERY,
    {
      ...paginationVariables(pagination),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.issueLabels);
}

export async function createIssueLabel(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    CreateIssueLabelArgsSchema,
    rawArgs,
    "linear_create_issue_label",
  );
  const input: Record<string, unknown> = { name: args.name };
  if (args.color !== undefined) input.color = args.color;
  if (args.description !== undefined) input.description = args.description;
  if (args.teamId !== undefined) input.teamId = args.teamId;
  const data = await fetchLinearGraphQL(
    config,
    ISSUE_LABEL_CREATE,
    { input },
    signal,
  );
  return data.issueLabelCreate ?? { success: false };
}

export async function listProjectLabels(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListLabelsArgsSchema,
    rawArgs,
    "linear_list_project_labels",
  );
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_PROJECT_LABELS_QUERY,
    paginationVariables(pagination),
    signal,
  );
  return connectionResult(data.projectLabels);
}

export async function listInitiativeLabels(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListLabelsArgsSchema,
    rawArgs,
    "linear_list_initiative_labels",
  );
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_INITIATIVE_LABELS_QUERY,
    paginationVariables(pagination),
    signal,
  );
  return connectionResult(data.initiativeLabels);
}

export const LINEAR_LIST_ISSUE_LABELS_DEFINITION: ToolDefinition = {
  name: "linear_list_issue_labels",
  description: "List issue labels, optionally filtered by team or name.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      name: { type: "string" },
      team: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_CREATE_ISSUE_LABEL_DEFINITION: ToolDefinition = {
  name: "linear_create_issue_label",
  description: "Create an issue label (write).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      color: { type: "string" },
      description: { type: "string" },
      teamId: { type: "string" },
    },
    required: ["name"],
  },
};

export const LINEAR_LIST_PROJECT_LABELS_DEFINITION: ToolDefinition = {
  name: "linear_list_project_labels",
  description: "List project labels in the workspace.",
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

export const LINEAR_LIST_INITIATIVE_LABELS_DEFINITION: ToolDefinition = {
  name: "linear_list_initiative_labels",
  description: "List initiative labels in the workspace.",
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