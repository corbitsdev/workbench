import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type LinearFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type LinearToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: LinearFetch;
};

const DEFAULT_BASE_URL = "https://api.linear.app/graphql";
const DEFAULT_ISSUE_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIMIT = 100;

function linearHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    "Content-Type": "application/json",
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(config: LinearToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Linear apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Linear baseUrl must be a valid URL");
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

function graphqlErrorMessage(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return "unknown error";
  }
  const messages = errors
    .map((entry) =>
      isRecord(entry) && typeof entry.message === "string"
        ? entry.message
        : null,
    )
    .filter((message): message is string => message !== null);
  return messages.length > 0 ? messages.join("; ") : "unknown error";
}

async function fetchLinearGraphQL(
  config: LinearToolsConfig,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const fetcher = config.fetcher ?? fetch;
  const endpoint =
    config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: linearHeaders(config.apiKey),
    body: JSON.stringify({ query, variables }),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(
      await response.text().catch(() => ""),
    );
    const detail = response.statusText || bodyText;
    throw new Error(`Linear API error: ${response.status} ${detail ?? ""}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("Linear response is not a valid object");
  }
  if (payload.errors !== undefined) {
    throw new Error(
      `Linear GraphQL error: ${graphqlErrorMessage(payload.errors)}`,
    );
  }
  if (!isRecord(payload.data)) {
    throw new Error("Linear response is missing data");
  }
  return payload.data;
}

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

const LIST_ISSUES_QUERY = `query ListIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter) {
    nodes {${ISSUE_FIELDS}}
  }
}`;

const LIST_TEAM_ISSUES_QUERY = `query ListTeamIssues($teamId: String!, $first: Int!, $filter: IssueFilter) {
  team(id: $teamId) {
    issues(first: $first, filter: $filter) {
      nodes {${ISSUE_FIELDS}}
    }
  }
}`;

const GET_ISSUE_QUERY = `query GetIssue($id: String!) {
  issue(id: $id) {
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
  }
}`;

const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}`;

const LIST_TEAMS_QUERY = `query ListTeams($first: Int!) {
  teams(first: $first) {
    nodes { id name key }
  }
}`;

const LIST_USERS_QUERY = `query ListUsers($first: Int!) {
  users(first: $first) {
    nodes { id name email active }
  }
}`;

function buildIssueFilter(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const state = optionalString(args.state);
  const assignee = optionalString(args.assignee);
  const filter: Record<string, unknown> = {};
  if (state !== null) {
    filter.state = { name: { eqIgnoreCase: state } };
  }
  if (assignee !== null) {
    filter.assignee = { name: { eqIgnoreCase: assignee } };
  }
  return Object.keys(filter).length > 0 ? filter : null;
}

async function listIssues(
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const first = optionalPositiveInteger(
    args.first,
    DEFAULT_ISSUE_LIMIT,
    MAX_LIMIT,
  );
  const teamId = optionalString(args.teamId);
  const filter = buildIssueFilter(args);

  if (teamId !== null) {
    const data = await fetchLinearGraphQL(
      config,
      LIST_TEAM_ISSUES_QUERY,
      { teamId, first, ...(filter !== null ? { filter } : {}) },
      signal,
    );
    if (!isRecord(data.team)) {
      throw new Error(`Linear team not found: ${teamId}`);
    }
    return data.team.issues;
  }

  const data = await fetchLinearGraphQL(
    config,
    LIST_ISSUES_QUERY,
    { first, ...(filter !== null ? { filter } : {}) },
    signal,
  );
  return data.issues;
}

async function getIssue(
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const id = optionalString(args.id);
  if (id === null) {
    throw new Error("id is required");
  }
  const data = await fetchLinearGraphQL(
    config,
    GET_ISSUE_QUERY,
    { id },
    signal,
  );
  if (data.issue === null || data.issue === undefined) {
    throw new Error(`Linear issue not found: ${id}`);
  }
  return data.issue;
}

function optionalPriority(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 4
  ) {
    return null;
  }
  return value;
}

async function createIssue(
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = optionalString(args.teamId);
  if (teamId === null) {
    throw new Error("teamId is required");
  }
  const title = optionalString(args.title);
  if (title === null) {
    throw new Error("title is required");
  }
  const input: Record<string, unknown> = { teamId, title };
  const description = optionalString(args.description);
  if (description !== null) {
    input.description = description;
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
  if (!isRecord(data.issueCreate) || !isRecord(data.issueCreate.issue)) {
    throw new Error("Linear did not return the created issue");
  }
  return data.issueCreate.issue;
}

async function listTeams(
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const first = optionalPositiveInteger(
    args.first,
    DEFAULT_LIST_LIMIT,
    MAX_LIMIT,
  );
  const data = await fetchLinearGraphQL(
    config,
    LIST_TEAMS_QUERY,
    { first },
    signal,
  );
  return data.teams;
}

async function listUsers(
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const first = optionalPositiveInteger(
    args.first,
    DEFAULT_LIST_LIMIT,
    MAX_LIMIT,
  );
  const data = await fetchLinearGraphQL(
    config,
    LIST_USERS_QUERY,
    { first },
    signal,
  );
  return data.users;
}

const LIST_ISSUES_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    first: {
      type: "number",
      description: "Maximum number of issues to return (1-100, default 10).",
    },
    teamId: {
      type: "string",
      description: "Optional team id to scope the issues to a single team.",
    },
    state: {
      type: "string",
      description:
        'Optional workflow state name to filter by (e.g. "Todo", "In Progress", "Done"). Case-insensitive.',
    },
    assignee: {
      type: "string",
      description: "Optional assignee name to filter by. Case-insensitive.",
    },
  },
  required: [],
};

const GET_ISSUE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string",
      description: 'Issue UUID or identifier (e.g. "ENG-123").',
    },
  },
  required: ["id"],
};

const CREATE_ISSUE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    teamId: {
      type: "string",
      description:
        "Team id the issue belongs to (required). Get one from linear_list_teams.",
    },
    title: {
      type: "string",
      description: "Issue title (required).",
    },
    description: {
      type: "string",
      description: "Optional issue body in markdown.",
    },
    priority: {
      type: "number",
      description:
        "Optional priority: 0 (none), 1 (urgent), 2 (high), 3 (medium), 4 (low).",
    },
  },
  required: ["teamId", "title"],
};

const LIST_LIMIT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    first: {
      type: "number",
      description: "Maximum number of records to return (1-100, default 25).",
    },
  },
  required: [],
};

export const LINEAR_LIST_ISSUES_DEFINITION: ToolDefinition = {
  name: "linear_list_issues",
  description:
    "List Linear issues across the workspace. Read-only. Scope the query with teamId, state, and/or assignee rather than listing everything; returns 10 issues by default (max 100). Returns issue id, identifier, title, state, assignee, team, updatedAt, and url.",
  inputSchema: LIST_ISSUES_INPUT_SCHEMA,
};

export const LINEAR_GET_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_get_issue",
  description:
    'Get a single Linear issue by UUID or identifier (e.g. "ENG-123"). Read-only. Returns id, identifier, title, description, state, assignee, team, priority, url, createdAt, and updatedAt.',
  inputSchema: GET_ISSUE_INPUT_SCHEMA,
};

export const LINEAR_CREATE_ISSUE_DEFINITION: ToolDefinition = {
  name: "linear_create_issue",
  description:
    "Create a real Linear issue in the workspace. This is a write: it persists a new issue in Linear and requires human approval before it runs. Requires teamId (get one from linear_list_teams) and title; description (markdown) and priority (0-4) are optional. Returns the created issue's id, identifier, title, and url.",
  inputSchema: CREATE_ISSUE_INPUT_SCHEMA,
};

export const LINEAR_LIST_TEAMS_DEFINITION: ToolDefinition = {
  name: "linear_list_teams",
  description:
    "List Linear teams in the workspace. Read-only. Returns team id, name, and key.",
  inputSchema: LIST_LIMIT_INPUT_SCHEMA,
};

export const LINEAR_LIST_USERS_DEFINITION: ToolDefinition = {
  name: "linear_list_users",
  description:
    "List Linear users in the workspace. Read-only. Returns user id, name, email, and active status.",
  inputSchema: LIST_LIMIT_INPUT_SCHEMA,
};

type LinearHandler = (
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

function buildLinearHandler(config: LinearToolsConfig, handler: LinearHandler) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await handler(config, args, signal));
}

export function createLinearTools(config: LinearToolsConfig): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: "string",
      definition: LINEAR_LIST_ISSUES_DEFINITION,
      handler: buildLinearHandler(config, listIssues),
    },
    {
      kind: "string",
      definition: LINEAR_GET_ISSUE_DEFINITION,
      handler: buildLinearHandler(config, getIssue),
    },
    {
      kind: "string",
      definition: LINEAR_LIST_TEAMS_DEFINITION,
      handler: buildLinearHandler(config, listTeams),
    },
    {
      kind: "string",
      definition: LINEAR_LIST_USERS_DEFINITION,
      handler: buildLinearHandler(config, listUsers),
    },
    {
      kind: "string",
      definition: LINEAR_CREATE_ISSUE_DEFINITION,
      handler: buildLinearHandler(config, createIssue),
    },
  ];
}

function createLinearToolFor(
  config: LinearToolsConfig,
  definition: ToolDefinition,
  handler: LinearHandler,
): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: "string",
      definition,
      handler: buildLinearHandler(config, handler),
    },
  ];
}

function resolveConfig(config: {
  apiKey: string;
  baseURL: string;
}): LinearToolsConfig {
  return config.baseURL.length > 0
    ? { apiKey: config.apiKey, baseUrl: config.baseURL }
    : { apiKey: config.apiKey };
}

/**
 * Hub tool registry entries for linear. Each entry declares the tool definition,
 * the Interchange provider name for credential resolution, and a factory that
 * returns the AgentTool handlers given resolved credentials.
 *
 * Import and spread into the hub's KNOWN_TOOLS to register. No hub logic changes
 * are needed when new entries are added here.
 */
export const LINEAR_HUB_TOOLS = {
  linear_list_issues: {
    sideEffect: "read" as const,
    definition: LINEAR_LIST_ISSUES_DEFINITION,
    providerName: "linear" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createLinearToolFor(
        resolveConfig(config),
        LINEAR_LIST_ISSUES_DEFINITION,
        listIssues,
      ),
  },
  linear_get_issue: {
    sideEffect: "read" as const,
    definition: LINEAR_GET_ISSUE_DEFINITION,
    providerName: "linear" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createLinearToolFor(
        resolveConfig(config),
        LINEAR_GET_ISSUE_DEFINITION,
        getIssue,
      ),
  },
  linear_list_teams: {
    sideEffect: "read" as const,
    definition: LINEAR_LIST_TEAMS_DEFINITION,
    providerName: "linear" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createLinearToolFor(
        resolveConfig(config),
        LINEAR_LIST_TEAMS_DEFINITION,
        listTeams,
      ),
  },
  linear_list_users: {
    sideEffect: "read" as const,
    definition: LINEAR_LIST_USERS_DEFINITION,
    providerName: "linear" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createLinearToolFor(
        resolveConfig(config),
        LINEAR_LIST_USERS_DEFINITION,
        listUsers,
      ),
  },
  linear_create_issue: {
    sideEffect: "write" as const,
    definition: LINEAR_CREATE_ISSUE_DEFINITION,
    providerName: "linear" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createLinearToolFor(
        resolveConfig(config),
        LINEAR_CREATE_ISSUE_DEFINITION,
        createIssue,
      ),
  },
};
