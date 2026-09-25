import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import {
  connectionResult,
  paginationVariables,
  resolveListPagination,
} from "./pagination";
import { IssueIdArgsSchema } from "./schemas";
import { resolveTeamId } from "./teams";
import {
  BRIEF_SOURCE_SKIPPED_MARKER,
  DEFAULT_BRIEF_ISSUE_LIMIT,
  DEFAULT_ISSUE_LIMIT,
  extractMutationIssue,
  isBriefSourceFetchEnabled,
  isRecord,
  MAX_LIST_LIMIT_ISSUES,
  optionalBoolean,
  optionalPositiveInteger,
  optionalPriority,
  optionalString,
  optionalStringArray,
  parseArgs,
  requireMutationSuccess,
  requireNonEmptyString,
  requireString,
  type LinearToolsConfig,
} from "./shared";

const ISSUE_FIELDS = `
  id
  identifier
  title
  state { name }
  assignee { name }
  team { name }
  updatedAt
  url
`;

const BRIEF_ISSUE_FIELDS = `
  id
  identifier
  title
  state { name type }
  assignee { name }
  team { name }
  project { name }
  priority
  createdAt
  completedAt
  updatedAt
  url
`;

const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  title
  description
  state { name }
  assignee { name }
  team { name }
  priority
  url
  createdAt
  updatedAt
`;

const ISSUE_RELATIONS_FIELDS = `
  relations {
    nodes {
      type
      relatedIssue { id identifier title url }
    }
  }
`;

const ISSUE_CUSTOMER_NEEDS_FIELDS = `
  customerNeeds {
    nodes {
      id
      body
      priority
      customer { id name }
    }
  }
`;

function listIssuesQuery(fields: string): string {
  return `query ListIssues($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
  issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
    nodes {${fields}}
    pageInfo { endCursor hasNextPage }
  }
}`;
}

function listTeamIssuesQuery(fields: string): string {
  return `query ListTeamIssues($teamId: String!, $first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
  team(id: $teamId) {
    issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
      nodes {${fields}}
      pageInfo { endCursor hasNextPage }
    }
  }
}`;
}

const GET_ISSUE_QUERY = `query GetIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_DETAIL_FIELDS}
  }
}`;

const GET_ISSUE_WITH_RELATIONS_QUERY = `query GetIssueWithRelations($id: String!) {
  issue(id: $id) {
    ${ISSUE_DETAIL_FIELDS}
    ${ISSUE_RELATIONS_FIELDS}
  }
}`;

const GET_ISSUE_WITH_CUSTOMER_NEEDS_QUERY = `query GetIssueWithCustomerNeeds($id: String!) {
  issue(id: $id) {
    ${ISSUE_DETAIL_FIELDS}
    ${ISSUE_CUSTOMER_NEEDS_FIELDS}
  }
}`;

const GET_ISSUE_FULL_QUERY = `query GetIssueFull($id: String!) {
  issue(id: $id) {
    ${ISSUE_DETAIL_FIELDS}
    ${ISSUE_RELATIONS_FIELDS}
    ${ISSUE_CUSTOMER_NEEDS_FIELDS}
  }
}`;

const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url }
  }
}`;

const UPDATE_ISSUE_MUTATION = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier title url }
  }
}`;

const ARCHIVE_ISSUE_MUTATION = `mutation ArchiveIssue($id: String!) {
  issueArchive(id: $id) {
    success
  }
}`;

const DELETE_ISSUE_MUTATION = `mutation DeleteIssue($id: String!) {
  issueDelete(id: $id) {
    success
  }
}`;

const ISSUE_RELATION_CREATE = `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { id type }
  }
}`;

const ISSUE_RELATION_DELETE = `mutation IssueRelationDelete($id: String!) {
  issueRelationDelete(id: $id) {
    success
  }
}`;

const ISSUE_TEAM_QUERY = `query IssueTeam($id: String!) {
  issue(id: $id) {
    team { id }
  }
}`;

const TEAM_STATE_BY_NAME_QUERY = `query TeamStateByName($teamId: String!, $name: String!) {
  team(id: $teamId) {
    states(filter: { name: { eqIgnoreCase: $name } }) {
      nodes { id }
    }
  }
}`;

const ListIssuesArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "teamId?": "string",
  "team?": "string",
  "state?": "string",
  "assignee?": "string",
  "project?": "string",
  "cycle?": "string",
  "label?": "string",
  "priority?": "number",
  "query?": "string",
  "orderBy?": "'createdAt' | 'updatedAt'",
  "updatedAfter?": "string",
  "createdAfter?": "string",
  "enabledSources?": "string[]",
});

const GetIssueArgsSchema = type({
  id: "string > 0",
  "includeRelations?": "boolean",
  "includeCustomerNeeds?": "boolean",
});

const CreateIssueArgsSchema = type({
  teamId: "string > 0",
  title: "string > 0",
  "description?": "string",
  "priority?": "number",
});

const UpdateIssueArgsSchema = type({
  id: "string > 0",
  "title?": "string",
  "description?": "string",
  "priority?": "number",
  "state?": "string",
  "assignee?": "string",
  "project?": "string",
  "teamId?": "string",
  "cycle?": "string",
  "milestone?": "string",
  "dueDate?": "string",
  "estimate?": "number",
  "labelIds?": "string[]",
});

const LinkIssuesArgsSchema = type({
  action: "'add' | 'remove'",
  "issueId?": "string > 0",
  "relatedIssueId?": "string > 0",
  "type?": "'blocks' | 'blocked' | 'related' | 'duplicate'",
  "relationId?": "string",
});

const WORKFLOW_STATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveWorkflowStateId(
  config: LinearToolsConfig,
  issueId: string,
  state: string,
  signal: AbortSignal,
  teamIdOverride: string | null = null,
): Promise<string> {
  if (WORKFLOW_STATE_ID_PATTERN.test(state)) {
    return state;
  }
  let teamId = teamIdOverride;
  if (teamId === null) {
    const issueData = await fetchLinearGraphQL(
      config,
      ISSUE_TEAM_QUERY,
      { id: issueId },
      signal,
    );
    if (!isRecord(issueData.issue) || !isRecord(issueData.issue.team)) {
      throw new Error(`Linear issue not found: ${issueId}`);
    }
    teamId = requireNonEmptyString(issueData.issue.team.id, "team.id");
  }
  const teamData = await fetchLinearGraphQL(
    config,
    TEAM_STATE_BY_NAME_QUERY,
    { teamId, name: state },
    signal,
  );
  if (!isRecord(teamData.team)) {
    throw new Error(`Linear team not found: ${teamId}`);
  }
  const states = teamData.team.states;
  if (
    !isRecord(states) ||
    !Array.isArray(states.nodes) ||
    states.nodes.length === 0
  ) {
    throw new Error(`Workflow state not found: ${state}`);
  }
  const first = states.nodes[0];
  if (!isRecord(first)) {
    throw new Error(`Workflow state not found: ${state}`);
  }
  return requireNonEmptyString(first.id, "state.id");
}

function buildIssueFilter(
  args: Record<string, unknown>,
  briefShaped: boolean,
): Record<string, unknown> | null {
  const state = optionalString(args.state);
  const assignee = optionalString(args.assignee);
  const project = optionalString(args.project);
  const cycle = optionalString(args.cycle);
  const label = optionalString(args.label);
  const query = optionalString(args.query);
  const priority = optionalPriority(args.priority);
  const filter: Record<string, unknown> = {};
  if (state !== null) {
    filter.state = { name: { eqIgnoreCase: state } };
  }
  if (assignee !== null) {
    filter.assignee = { name: { eqIgnoreCase: assignee } };
  }
  if (project !== null) {
    filter.project = { id: { eq: project } };
  }
  if (cycle !== null) {
    filter.cycle = { id: { eq: cycle } };
  }
  if (label !== null) {
    filter.labels = { name: { eqIgnoreCase: label } };
  }
  if (query !== null) {
    filter.title = { containsIgnoreCase: query };
  }
  if (priority !== null) {
    filter.priority = { eq: priority };
  }
  if (briefShaped) {
    // Brief path: createdAfter is a historical alias for the updatedAt bound.
    const updatedAfter =
      optionalString(args.updatedAfter) ?? optionalString(args.createdAfter);
    if (updatedAfter !== null) {
      filter.updatedAt = { gt: updatedAfter };
    }
  } else {
    const updatedAfter = optionalString(args.updatedAfter);
    const createdAfter = optionalString(args.createdAfter);
    if (updatedAfter !== null) {
      filter.updatedAt = { gt: updatedAfter };
    }
    if (createdAfter !== null) {
      filter.createdAt = { gt: createdAfter };
    }
  }
  return Object.keys(filter).length > 0 ? filter : null;
}

function buildOrderBy(args: Record<string, unknown>): string | null {
  const field = optionalString(args.orderBy);
  if (field === "createdAt" || field === "updatedAt") {
    return field;
  }
  return null;
}

type BriefIssueBuckets = {
  newIssues: unknown[];
  completedIssues: unknown[];
  updatedIssues: unknown[];
};

function bucketBriefIssues(
  nodes: unknown[],
  cutoff: string | null,
): BriefIssueBuckets {
  const buckets: BriefIssueBuckets = {
    newIssues: [],
    completedIssues: [],
    updatedIssues: [],
  };
  for (const node of nodes) {
    if (cutoff !== null && isRecord(node)) {
      const completedAt = optionalString(node.completedAt);
      if (completedAt !== null && completedAt > cutoff) {
        buckets.completedIssues.push(node);
        continue;
      }
      const createdAt = optionalString(node.createdAt);
      if (createdAt !== null && createdAt > cutoff) {
        buckets.newIssues.push(node);
        continue;
      }
    }
    buckets.updatedIssues.push(node);
  }
  return buckets;
}

export type IssueListSavedView = {
  id: string;
  name: string;
};

export type IssueListSavedViewScope =
  | { applied: false }
  | ({ applied: true } & IssueListSavedView);

export type IssueListScope = {
  directFilters: Record<string, unknown> | null;
  teamScope: { teamId: string | null };
  savedView: IssueListSavedViewScope;
};

export type ListIssuesOptions = {
  savedView?: IssueListSavedView | null;
};

// CL-8905 seam: no saved-view input exists on the list path yet, so the view
// scope is unapplied unless the caller supplies an already-resolved view.
// CL-8905 owns the view arg, filterData merge, and {id, name} resolution and
// will feed its result through here; CL-8908 owns view id/name validation.
export function resolveSavedView(
  resolvedView?: IssueListSavedView | null,
): IssueListSavedViewScope {
  if (resolvedView !== undefined && resolvedView !== null) {
    return {
      applied: true,
      id: resolvedView.id,
      name: resolvedView.name,
    };
  }
  return { applied: false };
}

export async function listIssues(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
  options?: ListIssuesOptions,
): Promise<unknown> {
  const args = parseArgs(ListIssuesArgsSchema, rawArgs, "linear_list_issues");
  const enabledSources = optionalStringArray(args.enabledSources);
  if (!isBriefSourceFetchEnabled("linear", enabledSources)) {
    return BRIEF_SOURCE_SKIPPED_MARKER;
  }

  const briefShaped = enabledSources !== undefined;
  const pagination = resolveListPagination(
    args,
    briefShaped ? DEFAULT_BRIEF_ISSUE_LIMIT : DEFAULT_ISSUE_LIMIT,
    MAX_LIST_LIMIT_ISSUES,
  );
  const teamId = optionalString(args.teamId) ?? optionalString(args.team);
  const filter = buildIssueFilter(args, briefShaped);
  const briefCutoff = briefShaped
    ? (optionalString(args.updatedAfter) ?? optionalString(args.createdAfter))
    : null;
  const explicitOrderBy = buildOrderBy(args);
  const orderBy =
    explicitOrderBy ??
    (briefShaped && briefCutoff !== null ? "updatedAt" : null);
  const fields = briefShaped ? BRIEF_ISSUE_FIELDS : ISSUE_FIELDS;
  const savedView = resolveSavedView(options?.savedView);
  const buildScope = (teamScopeId: string | null): IssueListScope => ({
    directFilters: filter,
    teamScope: { teamId: teamScopeId },
    savedView,
  });
  const withScope = (result: unknown, scope: IssueListScope): unknown =>
    isRecord(result) ? { ...result, scope } : result;
  const shapeResult = (
    connection: unknown,
    teamScopeId: string | null,
  ): unknown => {
    const scope = buildScope(teamScopeId);
    const shaped = connectionResult(connection);
    if (!briefShaped) return withScope(shaped, scope);
    if (!isRecord(shaped) || !Array.isArray(shaped.nodes)) {
      return withScope(bucketBriefIssues([], briefCutoff), scope);
    }
    return withScope(bucketBriefIssues(shaped.nodes, briefCutoff), scope);
  };

  const variables: Record<string, unknown> = {
    ...paginationVariables(pagination),
    ...(filter !== null ? { filter } : {}),
    ...(orderBy !== null ? { orderBy } : {}),
  };

  if (teamId !== null) {
    const resolvedTeamId = await resolveTeamId(config, teamId, signal);
    const data = await fetchLinearGraphQL(
      config,
      listTeamIssuesQuery(fields),
      { teamId: resolvedTeamId, ...variables },
      signal,
    );
    if (!isRecord(data.team)) {
      throw new Error(`Linear team not found: ${teamId}`);
    }
    return shapeResult(data.team.issues, resolvedTeamId);
  }

  const data = await fetchLinearGraphQL(
    config,
    listIssuesQuery(fields),
    variables,
    signal,
  );
  return shapeResult(data.issues, null);
}

export async function getIssue(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetIssueArgsSchema, rawArgs, "linear_get_issue");
  const includeRelations = args.includeRelations === true;
  const includeCustomerNeeds = args.includeCustomerNeeds === true;
  const query =
    includeRelations && includeCustomerNeeds
      ? GET_ISSUE_FULL_QUERY
      : includeRelations
        ? GET_ISSUE_WITH_RELATIONS_QUERY
        : includeCustomerNeeds
          ? GET_ISSUE_WITH_CUSTOMER_NEEDS_QUERY
          : GET_ISSUE_QUERY;
  const data = await fetchLinearGraphQL(config, query, { id: args.id }, signal);
  if (data.issue === null || data.issue === undefined) {
    throw new Error(`Linear issue not found: ${args.id}`);
  }
  return data.issue;
}

export async function createIssue(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(CreateIssueArgsSchema, rawArgs, "linear_create_issue");
  const resolvedTeamId = await resolveTeamId(config, args.teamId, signal);
  const input: Record<string, unknown> = {
    teamId: resolvedTeamId,
    title: args.title,
  };
  if (args.description !== undefined) {
    input.description = args.description;
  }
  const priority = optionalPriority(args.priority);
  if (priority !== null) {
    input.priority = priority;
  }
  const data = await fetchLinearGraphQL(
    config,
    CREATE_ISSUE_MUTATION,
    { input },
    signal,
  );
  return extractMutationIssue(data, "issueCreate");
}

export async function updateIssue(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(UpdateIssueArgsSchema, rawArgs, "linear_update_issue");
  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = args.title;
  if (args.description !== undefined) input.description = args.description;
  const priority = optionalPriority(args.priority);
  if (priority !== null) input.priority = priority;
  let teamIdForState: string | null = null;
  if (args.teamId !== undefined) {
    teamIdForState = await resolveTeamId(config, args.teamId, signal);
    input.teamId = teamIdForState;
  }
  if (args.state !== undefined) {
    input.stateId = await resolveWorkflowStateId(
      config,
      args.id,
      args.state,
      signal,
      teamIdForState,
    );
  }
  if (args.assignee !== undefined) {
    input.assigneeId = args.assignee;
  }
  if (args.project !== undefined) {
    input.projectId = args.project;
  }
  if (args.cycle !== undefined) {
    input.cycleId = args.cycle;
  }
  if (args.milestone !== undefined) {
    input.projectMilestoneId = args.milestone;
  }
  if (args.dueDate !== undefined) {
    input.dueDate = args.dueDate;
  }
  if (args.estimate !== undefined) {
    input.estimate = args.estimate;
  }
  if (args.labelIds !== undefined) {
    input.labelIds = args.labelIds;
  }
  if (Object.keys(input).length === 0) {
    throw new Error("At least one field to update is required");
  }
  const data = await fetchLinearGraphQL(
    config,
    UPDATE_ISSUE_MUTATION,
    { id: args.id, input },
    signal,
  );
  return extractMutationIssue(data, "issueUpdate");
}

export async function archiveIssue(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(IssueIdArgsSchema, rawArgs, "linear_archive_issue");
  const data = await fetchLinearGraphQL(
    config,
    ARCHIVE_ISSUE_MUTATION,
    { id: args.id },
    signal,
  );
  return requireMutationSuccess(data, "issueArchive");
}

export async function deleteIssue(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(IssueIdArgsSchema, rawArgs, "linear_delete_issue");
  const data = await fetchLinearGraphQL(
    config,
    DELETE_ISSUE_MUTATION,
    { id: args.id },
    signal,
  );
  return requireMutationSuccess(data, "issueDelete");
}

export async function linkIssues(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(LinkIssuesArgsSchema, rawArgs, "linear_link_issues");
  if (args.action === "remove") {
    const relationId = optionalString(args.relationId);
    if (relationId === null) {
      throw new Error(
        "relationId is required when action is remove (use the issue relation edge id, not a related issue id)",
      );
    }
    const data = await fetchLinearGraphQL(
      config,
      ISSUE_RELATION_DELETE,
      { id: relationId },
      signal,
    );
    return requireMutationSuccess(data, "issueRelationDelete");
  }
  const issueId = optionalString(args.issueId);
  const relatedIssueId = optionalString(args.relatedIssueId);
  if (issueId === null || relatedIssueId === null) {
    throw new Error(
      "issueId and relatedIssueId are required when action is add",
    );
  }
  const relationType = args.type ?? "related";
  let createIssueId = issueId;
  let createRelatedId = relatedIssueId;
  let apiType: "blocks" | "related" | "duplicate" = "related";
  if (relationType === "blocks") {
    apiType = "blocks";
  } else if (relationType === "blocked") {
    apiType = "blocks";
    createIssueId = relatedIssueId;
    createRelatedId = issueId;
  } else if (relationType === "duplicate") {
    apiType = "duplicate";
  } else {
    apiType = "related";
  }
  const data = await fetchLinearGraphQL(
    config,
    ISSUE_RELATION_CREATE,
    {
      input: {
        issueId: createIssueId,
        relatedIssueId: createRelatedId,
        type: apiType,
      },
    },
    signal,
  );
  return requireMutationSuccess(data, "issueRelationCreate");
}

export const LINEAR_LIST_ISSUES_DEFINITION: ToolDefinition = {
  name: "linear_list_issues",
  description:
    "List Linear issues across the workspace. Read-only. Scope with team, state, assignee, project, cycle, label, priority, or query; supports cursor pagination and orderBy (createdAt|updatedAt). Brief heartbeat calls may pass enabledSources; brief-shaped results are bucketed into newIssues/completedIssues/updatedIssues and default orderBy to updatedAt when a cutoff is present. Every response carries a top-level scope object with the effective directFilters (the GraphQL IssueFilter sent, or null), teamScope.teamId (the resolved team id, or null), and savedView ({applied:false} when no saved view scoped the results, otherwise {applied:true,id,name}).",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Page size (alias for first)." },
      first: {
        type: "number",
        description:
          "Maximum issues (default 10, max 250; brief-shaped calls default to 50).",
      },
      cursor: { type: "string", description: "Pagination cursor (after)." },
      after: { type: "string", description: "Pagination cursor alias." },
      teamId: { type: "string", description: "Team id filter." },
      team: { type: "string", description: "Team name or id filter." },
      state: { type: "string", description: "Workflow state name." },
      assignee: { type: "string", description: "Assignee name." },
      project: { type: "string", description: "Project id." },
      cycle: { type: "string", description: "Cycle id." },
      label: { type: "string", description: "Label name." },
      priority: { type: "number", description: "Priority 0-4." },
      query: { type: "string", description: "Title search substring." },
      orderBy: {
        type: "string",
        description: "createdAt or updatedAt (descending).",
      },
      updatedAfter: {
        type: "string",
        description: "ISO updatedAt lower bound (updatedAt.gt).",
      },
      createdAfter: {
        type: "string",
        description:
          "ISO createdAt lower bound (createdAt.gt). On brief-shaped calls (enabledSources present), falls back to updatedAt.gt when updatedAfter is absent.",
      },
      enabledSources: {
        type: "array",
        items: { type: "string" },
        description: "Brief-internal source gate.",
      },
    },
    required: [],
  },
};

export const LINEAR_GET_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_get_issue",
  description:
    'Get a Linear issue by UUID or identifier (e.g. "ENG-123"). Optional includeRelations returns this issue\'s outbound relation edges only (blocks, related, duplicate); inverse edges such as blocked-by require querying the related issue.',
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue id or identifier." },
      includeRelations: {
        type: "boolean",
        description:
          "When true, include this issue's outbound relation edges (blocks, related, duplicate). Does not include inverse edges (e.g. blocked-by from another issue); query the related issue for those.",
      },
      includeCustomerNeeds: {
        type: "boolean",
        description: "Include linked customer needs when true.",
      },
    },
    required: ["id"],
  },
};

export const LINEAR_CREATE_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_create_issue",
  description:
    "Create a Linear issue (write, approval-gated). Requires teamId and title.",
  inputSchema: {
    type: "object",
    properties: {
      teamId: { type: "string", description: "Team id." },
      title: { type: "string", description: "Issue title." },
      description: { type: "string", description: "Markdown body." },
      priority: { type: "number", description: "0-4 priority." },
    },
    required: ["teamId", "title"],
  },
};

export const LINEAR_UPDATE_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_update_issue",
  description:
    "Update an existing Linear issue (write). Pass id plus fields to change.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue id or identifier." },
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "number" },
      state: { type: "string", description: "State id or name." },
      assignee: { type: "string", description: "User id." },
      project: { type: "string", description: "Project id." },
      teamId: { type: "string" },
      cycle: { type: "string", description: "Cycle id." },
      milestone: { type: "string", description: "Project milestone id." },
      dueDate: { type: "string", description: "ISO due date." },
      estimate: { type: "number" },
      labelIds: {
        type: "array",
        items: { type: "string" },
        description: "Label ids to set on the issue.",
      },
    },
    required: ["id"],
  },
};

export const LINEAR_ARCHIVE_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_archive_issue",
  description: "Archive a Linear issue (write).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

export const LINEAR_DELETE_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_delete_issue",
  description: "Permanently delete a Linear issue (write).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

export const LINEAR_LINK_ISSUES_DEFINITION: ToolDefinition = {
  name: "linear_link_issues",
  description:
    "Add or remove relations between issues (blocks, blocked, related, duplicate).",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "add or remove." },
      issueId: { type: "string" },
      relatedIssueId: { type: "string" },
      type: { type: "string", description: "Relation type for add." },
      relationId: { type: "string", description: "Relation id for remove." },
    },
    required: ["action"],
  },
};
