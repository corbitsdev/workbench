// A minimal GitHub REST search client. The public search endpoints
// (`/search/repositories`, `/search/issues`) work keylessly — GitHub just
// rate-limits unauthenticated callers harder (60/hr vs 5000/hr with a
// token) — so, unlike Granola/Exa/Linear, "no credential" here means
// "lower rate limit," not "not connected." A caller-supplied token is
// used when present; every call still goes out either way.
import { type } from "arktype";

const GitHubRepo = type({
  full_name: "string",
  html_url: "string",
  "description?": "string | null",
  stargazers_count: "number",
  pushed_at: "string",
});

const GitHubIssueOrPR = type({
  html_url: "string",
  title: "string",
  comments: "number",
  reactions: { total_count: "number" },
  updated_at: "string",
});

const GitHubSearchReposResponse = type({ items: GitHubRepo.array() });
const GitHubSearchIssuesResponse = type({ items: GitHubIssueOrPR.array() });

export interface GitHubActivityItem {
  readonly url: string;
  readonly title: string;
  /** ISO 8601 — a repo's last push, or an issue/PR's last update. */
  readonly publishedAt: string;
  readonly source: "github";
  readonly engagement:
    | { readonly stars: number }
    | { readonly upvotes: number; readonly comments: number };
  /** Repos only: the full "owner/name" this item is about. */
  readonly entityTag?: string;
}

export interface GitHubClientConfig {
  /** Absent means unauthenticated (60 req/hr instead of 5000). */
  readonly apiKey?: string;
  /** Override for tests; defaults to the real GitHub API host. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_DAYS = 30;
const DEFAULT_PER_LIST = 5;
const MAX_PER_LIST = 25;

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchGitHubJSON(
  url: URL,
  config: GitHubClientConfig,
): Promise<unknown> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, { headers: buildHeaders(config.apiKey) });
  if (!response.ok) {
    throw new Error(
      `GitHub search request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

function normalizeRepo(repo: typeof GitHubRepo.infer): GitHubActivityItem {
  return {
    url: repo.html_url,
    title: `${repo.full_name}: ${repo.description ?? ""}`,
    publishedAt: repo.pushed_at,
    source: "github",
    engagement: { stars: repo.stargazers_count },
    entityTag: repo.full_name,
  };
}

function normalizeIssueOrPR(
  item: typeof GitHubIssueOrPR.infer,
): GitHubActivityItem {
  return {
    url: item.html_url,
    title: item.title,
    publishedAt: item.updated_at,
    source: "github",
    engagement: {
      upvotes: item.reactions.total_count,
      comments: item.comments,
    },
  };
}

function clampPerList(requested: number | undefined): number {
  if (
    requested === undefined ||
    !Number.isInteger(requested) ||
    requested <= 0
  ) {
    return DEFAULT_PER_LIST;
  }
  return Math.min(requested, MAX_PER_LIST);
}

/**
 * Searches GitHub for recently active repositories, issues, and pull
 * requests matching a topic. Throws on any transport, HTTP, or shape
 * failure — callers that need graceful degradation (e.g. this package's
 * `github_activity` tool) catch at their own boundary.
 */
export async function searchGitHubActivity(
  config: GitHubClientConfig,
  params: {
    readonly query: string;
    readonly days?: number;
    readonly limit?: number;
  },
): Promise<readonly GitHubActivityItem[]> {
  const days =
    typeof params.days === "number" && params.days > 0
      ? Math.floor(params.days)
      : DEFAULT_DAYS;
  const cutoff = new Date(Date.now() - days * 86400 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const perPage = String(clampPerList(params.limit));
  const base = config.baseUrl ?? DEFAULT_BASE_URL;

  const reposUrl = new URL(`${base}/search/repositories`);
  reposUrl.searchParams.set("q", `${params.query} pushed:>=${cutoffDate}`);
  reposUrl.searchParams.set("sort", "stars");
  reposUrl.searchParams.set("per_page", perPage);

  const issuesUrl = new URL(`${base}/search/issues`);
  issuesUrl.searchParams.set(
    "q",
    `${params.query} is:issue updated:>=${cutoffDate}`,
  );
  issuesUrl.searchParams.set("sort", "reactions");
  issuesUrl.searchParams.set("per_page", perPage);

  const prsUrl = new URL(`${base}/search/issues`);
  prsUrl.searchParams.set("q", `${params.query} is:pr updated:>=${cutoffDate}`);
  prsUrl.searchParams.set("sort", "reactions");
  prsUrl.searchParams.set("per_page", perPage);

  const [reposRaw, issuesRaw, prsRaw] = await Promise.all([
    fetchGitHubJSON(reposUrl, config),
    fetchGitHubJSON(issuesUrl, config),
    fetchGitHubJSON(prsUrl, config),
  ]);

  const repos = GitHubSearchReposResponse(reposRaw);
  const issues = GitHubSearchIssuesResponse(issuesRaw);
  const prs = GitHubSearchIssuesResponse(prsRaw);
  if (repos instanceof type.errors) {
    throw new Error(
      `GitHub repo search response did not match the expected shape: ${repos.summary}`,
    );
  }
  if (issues instanceof type.errors) {
    throw new Error(
      `GitHub issue search response did not match the expected shape: ${issues.summary}`,
    );
  }
  if (prs instanceof type.errors) {
    throw new Error(
      `GitHub PR search response did not match the expected shape: ${prs.summary}`,
    );
  }

  return [
    ...repos.items.map(normalizeRepo),
    ...issues.items.map(normalizeIssueOrPR),
    ...prs.items.map(normalizeIssueOrPR),
  ];
}
