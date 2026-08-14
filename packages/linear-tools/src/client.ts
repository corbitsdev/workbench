// A minimal Linear API client: one call, one shape — the issues
// assigned to or created by the caller, most-recently-updated first.
// Callers that need Linear's fuller surface (projects, cycles,
// comments, ...) extend this module rather than reach around it.
import { type } from "arktype";

export const LinearIssue = type({
  id: "string",
  identifier: "string",
  title: "string",
  "state?": "string",
  "url?": "string",
  updatedAt: "string",
});
export type LinearIssue = typeof LinearIssue.infer;

export interface LinearClientConfig {
  readonly apiKey: string;
  /** Override for tests; defaults to Linear's real GraphQL endpoint. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.linear.app/graphql";

const RECENT_ISSUES_QUERY = `
  query RecentAssignedIssues($updatedAfter: DateTimeOrDuration) {
    issues(
      filter: { assignee: { isMe: { eq: true } }, updatedAt: { gte: $updatedAfter } }
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        url
        updatedAt
        state {
          name
        }
      }
    }
  }
`;

interface LinearGraphQlIssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url?: string;
  readonly updatedAt: string;
  readonly state?: { readonly name?: string };
}

const LinearGraphQlResponse = type({
  "data?": {
    "issues?": {
      "nodes?": "unknown[]",
    },
  },
  "errors?": "unknown[]",
});

/**
 * Lists issues assigned to the caller, most-recently-updated first.
 * Throws on any transport, HTTP, GraphQL, or shape failure — callers
 * that need graceful degradation (e.g. the morning-brief tool) catch
 * at their own boundary rather than this client silently swallowing
 * errors.
 */
export async function listRecentLinearIssues(
  config: LinearClientConfig,
  params: { readonly since?: string } = {},
): Promise<readonly LinearIssue[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(config.baseUrl ?? DEFAULT_BASE_URL, {
    method: "POST",
    headers: {
      authorization: config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: RECENT_ISSUES_QUERY,
      variables: { updatedAfter: params.since },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Linear list-issues request failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = LinearGraphQlResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Linear list-issues response did not match the expected shape: ${parsed.summary}`,
    );
  }
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new Error(
      `Linear list-issues returned GraphQL errors: ${JSON.stringify(parsed.errors)}`,
    );
  }
  const nodes = (parsed.data?.issues?.nodes ?? []) as LinearGraphQlIssueNode[];
  return nodes.map((node) => {
    const issue: Record<string, unknown> = {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      updatedAt: node.updatedAt,
    };
    if (node.url !== undefined) issue["url"] = node.url;
    if (node.state?.name !== undefined) issue["state"] = node.state.name;
    const validated = LinearIssue(issue);
    if (validated instanceof type.errors) {
      throw new Error(
        `Linear list-issues response did not match the expected shape: ${validated.summary}`,
      );
    }
    return validated;
  });
}
