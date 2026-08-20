// The connect-github card's repo picker (CL-6345): the authenticated
// user's own repositories, plus one honestly-limited open-PR count per
// repo. GitHub's `/user/repos` list has no open-PR count on the row
// itself, so getting one costs a second call per repo — the search API's
// `total_count`, which is exact and free of pagination, unlike walking
// `/pulls` pages. That is an N+1 fetch (one list call, one search call
// per repo returned); acceptable for the picker's own repo count (a
// handful of repos, not thousands), but a caller listing an org with
// hundreds of repos will feel it. A cheaper batched count is future work,
// not something this module fakes today.
import { type } from "arktype";

import type { GitHubClientConfig } from "./client";

const GitHubUserRepo = type({
  id: "number",
  full_name: "string",
});
const GitHubUserReposResponse = GitHubUserRepo.array();

const GitHubSearchTotalCount = type({ total_count: "number" });

const DEFAULT_BASE_URL = "https://api.github.com";
const PER_PAGE = 100;

export interface GitHubRepoSummary {
  readonly id: string;
  readonly name: string;
  readonly openPullRequestCount: number;
}

function headers(apiKey: string | undefined): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    base.authorization = `Bearer ${apiKey}`;
  }
  return base;
}

async function fetchJSON(
  config: GitHubClientConfig,
  url: URL,
): Promise<unknown> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, { headers: headers(config.apiKey) });
  if (!response.ok) {
    throw new Error(
      `GitHub request to ${url.pathname} failed: ` +
        `${String(response.status)} ${response.statusText}`,
    );
  }
  return response.json();
}

async function openPullRequestCountOf(
  config: GitHubClientConfig,
  base: string,
  fullName: string,
): Promise<number> {
  const url = new URL(`${base}/search/issues`);
  url.searchParams.set("q", `repo:${fullName} is:pr is:open`);
  url.searchParams.set("per_page", "1");
  const raw = await fetchJSON(config, url);
  const parsed = GitHubSearchTotalCount(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `GitHub open-PR count response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.total_count;
}

/**
 * Lists the repositories the connected credential can see, most
 * recently pushed first, with each repo's own open-PR count filled in.
 * Throws on any transport, HTTP, or shape failure; the connect-github
 * card's own host catches at its render boundary.
 */
export async function listRepos(
  config: GitHubClientConfig,
): Promise<readonly GitHubRepoSummary[]> {
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(`${base}/user/repos`);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("sort", "pushed");

  const raw = await fetchJSON(config, url);
  const repos = GitHubUserReposResponse(raw);
  if (repos instanceof type.errors) {
    throw new Error(
      `GitHub repos response did not match the expected shape: ${repos.summary}`,
    );
  }

  return Promise.all(
    repos.map(async (repo) => ({
      id: String(repo.id),
      name: repo.full_name,
      openPullRequestCount: await openPullRequestCountOf(
        config,
        base,
        repo.full_name,
      ),
    })),
  );
}

const GitHubAuthenticatedUser = type({ login: "string" });

/**
 * The authenticated PAT's own login — this connector authenticates a
 * person, not an organization (GitHub App/OAuth org-level connect is
 * CL-6343, not built here), so a caller showing "connected as" shows
 * this login, not an org name.
 */
export async function fetchAuthenticatedLogin(
  config: GitHubClientConfig,
): Promise<string> {
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  const raw = await fetchJSON(config, new URL(`${base}/user`));
  const parsed = GitHubAuthenticatedUser(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `GitHub authenticated-user response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.login;
}
