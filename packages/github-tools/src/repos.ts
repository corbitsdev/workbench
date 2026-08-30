// The connect-github card's repo picker (CL-6345): the repositories the
// connected token can reach, most recently pushed first.
//
// One call, on purpose. This used to decorate every row with an exact
// open-PR count from the search API, which cost one `/search/issues` call
// per repo fired concurrently — and GitHub's search API allows 30 requests
// a minute and secondary-rate-limits bursts, so any account past a handful
// of repos got a 403 and the whole picker failed to load (CL-7189). The
// count was decoration on a checkbox row; the push timestamp that explains
// the ordering rides along on the list response for free.
import { type } from "arktype";

import type { GitHubClientConfig } from "./client";

const GitHubUserRepo = type({
  id: "number",
  full_name: "string",
  "pushed_at?": "string | null",
});
const GitHubUserReposResponse = GitHubUserRepo.array();

const DEFAULT_BASE_URL = "https://api.github.com";
const PER_PAGE = 100;

export interface GitHubRepoSummary {
  readonly id: string;
  readonly name: string;
  /** When GitHub last saw a push, ISO-8601 — absent on a repo that has
   * never been pushed to. */
  readonly lastPushedAt?: string;
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

/**
 * Lists the repositories the connected credential can see, most
 * recently pushed first. Throws on any transport, HTTP, or shape
 * failure; the connect-github card's own host catches at its render
 * boundary.
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

  return repos.map((repo) => ({
    id: String(repo.id),
    name: repo.full_name,
    ...(typeof repo.pushed_at === "string"
      ? { lastPushedAt: repo.pushed_at }
      : {}),
  }));
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
