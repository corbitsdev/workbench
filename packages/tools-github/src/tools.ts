import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizeGitHubIssueOrPR, normalizeGitHubRepo } from "./normalize";
import {
  GitHubIssueOrPR,
  GitHubRepo,
  GitHubSearchIssuesResponse,
  GitHubSearchReposResponse,
} from "./types";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_DAYS = 30;
const DEFAULT_PER_LIST = 5;
const MAX_PER_LIST = 25;

// GitHubFetch is a function type — not expressible as an arktype schema; kept as plain type.
export type GitHubFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

// GitHubToolsConfig contains a function field (fetcher) — kept as plain type.
export type GitHubToolsConfig = {
  apiKey: string;
  fetcher?: GitHubFetch;
};

const GithubActivityArgs = type({
  query: "string > 0",
  "days?": "number",
  "limit?": "number",
});

export const GITHUB_ACTIVITY_DEFINITION: ToolDefinition = {
  name: "github_activity",
  description:
    'Search GitHub for recently active repositories, issues, and pull requests matching a topic. Scope the search tightly: pass specific keyword terms and a narrow days window rather than pulling everything — the default returns only a few results per category. Pass keyword terms only — do not include GitHub search qualifiers like is:issue, is:pr, or repo: in the query; those are added automatically. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "github", engagement: { upvotes, comments } }`; repos carry an `entityTag` (full repo name) and `comments: 0`, while issues/PRs map reactions to upvotes and carry a real comment count.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Topic keywords to search for (e.g. "AI agents", "LLM inference", "vector database"). Do not include GitHub qualifiers.',
      },
      days: {
        type: "number",
        description: "Number of days to look back (default 30).",
      },
      limit: {
        type: "number",
        description:
          "Maximum results per category — repos, issues, PRs each (1-25, default 5).",
      },
    },
    required: ["query"],
  },
};

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchGitHubJSON(
  url: URL,
  config: GitHubToolsConfig,
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: buildHeaders(config.apiKey),
    signal,
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      if (body.length > 0) {
        detail = `: ${body}`;
      }
    } catch {
      // body read failure is non-fatal; the status code is sufficient
    }
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}${detail}`,
    );
  }
  return response.json();
}

function parseReposResponse(raw: unknown): GitHubRepo[] {
  const parsed = GitHubSearchReposResponse(raw);
  if (parsed instanceof type.errors) {
    return [];
  }
  return parsed.items;
}

function parseIssuesResponse(raw: unknown): GitHubIssueOrPR[] {
  const parsed = GitHubSearchIssuesResponse(raw);
  if (parsed instanceof type.errors) {
    return [];
  }
  return parsed.items;
}

async function searchGitHub(
  config: GitHubToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = GithubActivityArgs(args);
  if (parsed instanceof type.errors) {
    const hasQuery =
      "query" in args &&
      typeof args.query === "string" &&
      args.query.length > 0;
    if (!hasQuery) {
      throw new Error("query is required");
    }
    throw new Error(`github_activity: ${parsed.summary}`);
  }

  const { query, days: rawDays, limit: rawLimit } = parsed;

  const days =
    typeof rawDays === "number" && rawDays > 0
      ? Math.floor(rawDays)
      : DEFAULT_DAYS;
  const cutoff = new Date(Date.now() - days * 86400 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const perList =
    typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_PER_LIST)
      : DEFAULT_PER_LIST;
  const perPage = String(perList);

  const reposUrl = new URL(`${GITHUB_API_BASE}/search/repositories`);
  reposUrl.searchParams.set("q", `${query} pushed:>=${cutoffDate}`);
  reposUrl.searchParams.set("sort", "stars");
  reposUrl.searchParams.set("per_page", perPage);

  const issuesUrl = new URL(`${GITHUB_API_BASE}/search/issues`);
  issuesUrl.searchParams.set("q", `${query} is:issue updated:>=${cutoffDate}`);
  issuesUrl.searchParams.set("sort", "reactions");
  issuesUrl.searchParams.set("per_page", perPage);

  const prsUrl = new URL(`${GITHUB_API_BASE}/search/issues`);
  prsUrl.searchParams.set("q", `${query} is:pr updated:>=${cutoffDate}`);
  prsUrl.searchParams.set("sort", "reactions");
  prsUrl.searchParams.set("per_page", perPage);

  const [reposRaw, issuesRaw, prsRaw] = await Promise.all([
    fetchGitHubJSON(reposUrl, config, signal),
    fetchGitHubJSON(issuesUrl, config, signal),
    fetchGitHubJSON(prsUrl, config, signal),
  ]);

  const repoItems = parseReposResponse(reposRaw);
  const issueItems = parseIssuesResponse(issuesRaw);
  const prItems = parseIssuesResponse(prsRaw);

  const allItems = [
    ...repoItems.map(normalizeGitHubRepo),
    ...issueItems.map(normalizeGitHubIssueOrPR),
    ...prItems.map(normalizeGitHubIssueOrPR),
  ];
  const items = allItems.filter((item) => new Date(item.publishedAt) >= cutoff);

  return JSON.stringify(items, null, 2);
}

export function createGitHubTools(config: GitHubToolsConfig): AgentTool[] {
  return [
    {
      kind: "string",
      definition: GITHUB_ACTIVITY_DEFINITION,
      handler: (args, signal) => searchGitHub(config, args, signal),
    },
  ];
}

export const GITHUB_HUB_TOOLS = {
  github_activity: {
    sideEffect: "read" as const,
    definition: GITHUB_ACTIVITY_DEFINITION,
    providerName: "github" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createGitHubTools({ apiKey: config.apiKey }),
  },
};
