import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeGitHubIssueOrPR, normalizeGitHubRepo } from './normalize';
import type { GitHubIssueOrPR, GitHubRepo } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_DAYS = 30;
const DEFAULT_PER_LIST = 5;
const MAX_PER_LIST = 25;

export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubToolsConfig = {
  apiKey: string;
  fetcher?: GitHubFetch;
};

export const GITHUB_ACTIVITY_DEFINITION: ToolDefinition = {
  name: 'github_activity',
  description:
    'Search GitHub for recently active repositories, issues, and pull requests matching a topic. Scope the search tightly: pass specific keyword terms and a narrow days window rather than pulling everything — the default returns only a few results per category. Pass keyword terms only — do not include GitHub search qualifiers like is:issue, is:pr, or repo: in the query; those are added automatically. Returns normalized research items with star, reaction, and comment counts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Topic keywords to search for (e.g. "AI agents", "LLM inference", "vector database"). Do not include GitHub qualifiers.',
      },
      days: {
        type: 'number',
        description: 'Number of days to look back (default 30).',
      },
      limit: {
        type: 'number',
        description: 'Maximum results per category — repos, issues, PRs each (1-25, default 5).',
      },
    },
    required: ['query'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseGitHubRepo(value: unknown): GitHubRepo {
  if (!isRecord(value)) {
    throw new Error('GitHub repo item is not an object');
  }
  return {
    full_name: typeof value.full_name === 'string' ? value.full_name : '',
    html_url: typeof value.html_url === 'string' ? value.html_url : '',
    description: typeof value.description === 'string' ? value.description : undefined,
    stargazers_count: typeof value.stargazers_count === 'number' ? value.stargazers_count : 0,
    pushed_at: typeof value.pushed_at === 'string' ? value.pushed_at : new Date().toISOString(),
  };
}

function parseGitHubIssueOrPR(value: unknown): GitHubIssueOrPR {
  if (!isRecord(value)) {
    throw new Error('GitHub issue/PR item is not an object');
  }
  const reactions = isRecord(value.reactions) ? value.reactions : {};
  return {
    html_url: typeof value.html_url === 'string' ? value.html_url : '',
    title: typeof value.title === 'string' ? value.title : '',
    comments: typeof value.comments === 'number' ? value.comments : 0,
    reactions: {
      total_count: typeof reactions.total_count === 'number' ? reactions.total_count : 0,
    },
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date().toISOString(),
  };
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchGitHubJSON(
  url: URL,
  config: GitHubToolsConfig,
  signal: AbortSignal
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: buildHeaders(config.apiKey),
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.text();
      if (body.length > 0) {
        detail = `: ${body}`;
      }
    } catch {
      // body read failure is non-fatal; the status code is sufficient
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}${detail}`);
  }
  return response.json();
}

async function searchGitHub(
  config: GitHubToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const days =
    typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : DEFAULT_DAYS;
  const cutoff = new Date(Date.now() - days * 86400 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const perList =
    typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
      ? Math.min(args.limit, MAX_PER_LIST)
      : DEFAULT_PER_LIST;
  const perPage = String(perList);

  const reposUrl = new URL(`${GITHUB_API_BASE}/search/repositories`);
  reposUrl.searchParams.set('q', `${query} pushed:>=${cutoffDate}`);
  reposUrl.searchParams.set('sort', 'stars');
  reposUrl.searchParams.set('per_page', perPage);

  const issuesUrl = new URL(`${GITHUB_API_BASE}/search/issues`);
  issuesUrl.searchParams.set('q', `${query} is:issue updated:>=${cutoffDate}`);
  issuesUrl.searchParams.set('sort', 'reactions');
  issuesUrl.searchParams.set('per_page', perPage);

  const prsUrl = new URL(`${GITHUB_API_BASE}/search/issues`);
  prsUrl.searchParams.set('q', `${query} is:pr updated:>=${cutoffDate}`);
  prsUrl.searchParams.set('sort', 'reactions');
  prsUrl.searchParams.set('per_page', perPage);

  const [reposRaw, issuesRaw, prsRaw] = await Promise.all([
    fetchGitHubJSON(reposUrl, config, signal),
    fetchGitHubJSON(issuesUrl, config, signal),
    fetchGitHubJSON(prsUrl, config, signal),
  ]);

  const repoItems: GitHubRepo[] =
    isRecord(reposRaw) && Array.isArray(reposRaw.items) ? reposRaw.items.map(parseGitHubRepo) : [];

  const issueItems: GitHubIssueOrPR[] =
    isRecord(issuesRaw) && Array.isArray(issuesRaw.items)
      ? issuesRaw.items.map(parseGitHubIssueOrPR)
      : [];

  const prItems: GitHubIssueOrPR[] =
    isRecord(prsRaw) && Array.isArray(prsRaw.items) ? prsRaw.items.map(parseGitHubIssueOrPR) : [];

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
      kind: 'string',
      definition: GITHUB_ACTIVITY_DEFINITION,
      handler: (args, signal) => searchGitHub(config, args, signal),
    },
  ];
}

export const GITHUB_HUB_TOOLS = {
  github_activity: {
    definition: GITHUB_ACTIVITY_DEFINITION,
    providerName: 'github' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createGitHubTools({ apiKey: config.apiKey }),
  },
};
