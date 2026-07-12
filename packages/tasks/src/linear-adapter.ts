import {
  fetchLinearGraphQL,
  type LinearFetch,
  type LinearToolsConfig,
} from "@workbench/tools-linear";

import type {
  TaskAdapter,
  TaskAdapterExecutableOperation,
  TaskPushInput,
  TaskPushResult,
} from "./adapter";

// The Linear adapter mirrors the Attio adapter: a thin translation layer that
// maps the native task push vocabulary onto Linear's GraphQL API, delegating
// every HTTP/error concern to `@workbench/tools-linear`'s exported client.
// Tests mock only the fetcher, so the adapter -> tools-linear seam runs for
// real.

type LinearCredential = { apiKey: string; baseURL: string };

const LINEAR_TEAM_LINK_PREFIX = "linear:team:";

function findLinearTeamId(input: TaskPushInput): string | null {
  const teamIds = new Set<string>();
  for (const link of input.task.links) {
    if (!link.ref.startsWith(LINEAR_TEAM_LINK_PREFIX)) {
      continue;
    }
    const teamId = link.ref.slice(LINEAR_TEAM_LINK_PREFIX.length);
    if (teamId.length > 0) {
      teamIds.add(teamId);
    }
  }
  if (teamIds.size > 1) {
    throw new Error(
      `Linear adapter: task ${input.task.id} carries ambiguous linear team links (${[...teamIds].join(", ")})`,
    );
  }
  const [teamId] = teamIds;
  return teamId ?? null;
}

function requireLinearTeamId(input: TaskPushInput): string {
  const teamId = findLinearTeamId(input);
  if (teamId === null) {
    throw new Error(
      `Linear adapter: task ${input.task.id} carries no linear team link`,
    );
  }
  return teamId;
}

function buildIssueBody(input: TaskPushInput): string {
  const body = input.task.body ?? input.task.title;
  return `${body}\n\n<!-- idem:${input.idempotencyKey} -->\n— via Workbench task ${input.task.id} (actor ${input.actorPrincipalId})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolConfig(
  credential: LinearCredential,
  fetcher: LinearFetch,
): LinearToolsConfig {
  const config: LinearToolsConfig = { apiKey: credential.apiKey, fetcher };
  if (credential.baseURL.length > 0) {
    config.baseUrl = credential.baseURL;
  }
  return config;
}

const TEAM_STATES_QUERY = `query TaskAdapterTeamStates($teamId: String!) {
  team(id: $teamId) {
    states { nodes { id name type } }
  }
}`;

const ISSUE_CREATE_MUTATION = `mutation TaskAdapterCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

const ISSUE_UPDATE_MUTATION = `mutation TaskAdapterUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier url }
  }
}`;

const COMMENT_CREATE_MUTATION = `mutation TaskAdapterCreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

type LinearWorkflowStateType = "started" | "completed" | "canceled";

function targetStateType(
  status: TaskPushInput["task"]["status"],
): LinearWorkflowStateType | null {
  if (status === "in_progress" || status === "waiting") {
    return "started";
  }
  if (status === "done") {
    return "completed";
  }
  if (status === "cancelled") {
    return "canceled";
  }
  return null;
}

async function resolveStateId(
  config: LinearToolsConfig,
  teamId: string,
  stateType: LinearWorkflowStateType,
): Promise<string> {
  const data = await fetchLinearGraphQL(
    config,
    TEAM_STATES_QUERY,
    { teamId },
    new AbortController().signal,
  );
  if (
    !isRecord(data.team) ||
    !isRecord(data.team.states) ||
    !Array.isArray(data.team.states.nodes)
  ) {
    throw new Error(
      `Linear adapter: team not found or has no workflow states: ${teamId}`,
    );
  }
  const match = data.team.states.nodes.find(
    (node): node is Record<string, unknown> =>
      isRecord(node) && node.type === stateType,
  );
  if (typeof match?.id !== "string") {
    throw new Error(
      `Linear adapter: team ${teamId} has no workflow state of type "${stateType}"`,
    );
  }
  return match.id;
}

type LinearIssueRef = { id: string; url: string };

function extractIssue(
  data: Record<string, unknown>,
  mutationKey: string,
): LinearIssueRef {
  const mutation = data[mutationKey];
  if (!isRecord(mutation) || !isRecord(mutation.issue)) {
    throw new Error(`Linear adapter: ${mutationKey} did not return an issue`);
  }
  const { id, url } = mutation.issue;
  if (typeof id !== "string" || typeof url !== "string") {
    throw new Error(
      `Linear adapter: ${mutationKey} issue is missing id or url`,
    );
  }
  return { id, url };
}

type LinearAdapterDeps = { fetcher: LinearFetch };

export function createLinearTaskAdapter(deps: LinearAdapterDeps): TaskAdapter {
  async function createIssue(
    input: TaskPushInput,
    credential: LinearCredential,
  ): Promise<TaskPushResult> {
    const teamId = requireLinearTeamId(input);
    const config = toolConfig(credential, deps.fetcher);
    const issueInput = {
      teamId,
      title: input.task.title,
      description: buildIssueBody(input),
    };
    const data = await fetchLinearGraphQL(
      config,
      ISSUE_CREATE_MUTATION,
      { input: issueInput },
      new AbortController().signal,
    );
    const issue = extractIssue(data, "issueCreate");
    return { externalId: issue.id, externalUrl: issue.url, deduped: false };
  }

  async function updateIssue(
    input: TaskPushInput,
    credential: LinearCredential,
    forcedStateType: LinearWorkflowStateType | null,
  ): Promise<TaskPushResult> {
    if (input.externalRef === null) {
      throw new Error(
        `Linear adapter: cannot update task ${input.task.id} with no external ref`,
      );
    }
    const config = toolConfig(credential, deps.fetcher);
    const patch: Record<string, unknown> = { title: input.task.title };
    if (input.task.body !== undefined) {
      patch.description = input.task.body;
    }
    const stateType = forcedStateType ?? targetStateType(input.task.status);
    if (stateType !== null) {
      const teamId = requireLinearTeamId(input);
      patch.stateId = await resolveStateId(config, teamId, stateType);
    }
    const data = await fetchLinearGraphQL(
      config,
      ISSUE_UPDATE_MUTATION,
      { id: input.externalRef.externalId, input: patch },
      new AbortController().signal,
    );
    const issue = extractIssue(data, "issueUpdate");
    return { externalId: issue.id, externalUrl: issue.url, deduped: false };
  }

  async function commentIssue(
    input: TaskPushInput,
    credential: LinearCredential,
  ): Promise<TaskPushResult> {
    if (input.externalRef === null) {
      throw new Error(
        `Linear adapter: cannot comment on task ${input.task.id} with no external ref`,
      );
    }
    const config = toolConfig(credential, deps.fetcher);
    const data = await fetchLinearGraphQL(
      config,
      COMMENT_CREATE_MUTATION,
      {
        input: {
          issueId: input.externalRef.externalId,
          body: buildIssueBody(input),
        },
      },
      new AbortController().signal,
    );
    if (!isRecord(data.commentCreate) || data.commentCreate.success !== true) {
      throw new Error(
        `Linear adapter: failed to create comment on task ${input.task.id}`,
      );
    }
    return {
      externalId: input.externalRef.externalId,
      ...(input.externalRef.externalUrl === undefined
        ? {}
        : { externalUrl: input.externalRef.externalUrl }),
      deduped: false,
    };
  }

  async function execute(
    op: TaskAdapterExecutableOperation,
    input: TaskPushInput,
    credential: LinearCredential,
  ): Promise<TaskPushResult> {
    if (op === "create") {
      return createIssue(input, credential);
    }
    if (op === "comment") {
      return commentIssue(input, credential);
    }
    if (op === "close") {
      return updateIssue(input, credential, "completed");
    }
    // update
    return updateIssue(input, credential, null);
  }

  return {
    id: "linear",
    label: "Linear",
    providerName: "linear",
    operations: ["create", "update", "close", "comment"],
    externalRef: { idLabel: "Linear issue id" },
    execute,
  };
}
