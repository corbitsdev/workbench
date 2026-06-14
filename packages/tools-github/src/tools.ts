import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeGitHubPR, normalizeGitHubRepo } from './normalize';
import type { GitHubPR, GitHubRepo } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_DAYS = 30;

export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubToolsConfig = {
  apiKey: string;
  fetcher?: GitHubFetch;
};

export const GITHUB_ACTIVITY_DEFINITION: ToolDefinition = {
  name: 'github_activity',
  description:
    'Search GitHub for recently active repositories and pull requests matching a query. Returns normalized research items with star and reaction counts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string.',
      },
      days: {
        type: 'number',
        description: 'Number of days to look back (default 30).',
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

function parseGitHubPR(value: unknown): GitHubPR {
  if (!isRecord(value)) {
    throw new Error('GitHub PR item is not an object');
  }
  const reactions = isRecord(value.reactions) ? value.reactions : {};
  return {
    html_url: typeof value.html_url === 'string' ? value.html_url : '',
    title: typeof value.title === 'string' ? value.title : '',
    reactions: {
      total_count: typeof reactions.total_count === 'number' ? reactions.total_count : 0,
    },
    created_at: typeof value.created_at === 'string' ? value.created_at : new Date().toISOString(),
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
  const cutoffDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const reposUrl = new URL(`${GITHUB_API_BASE}/search/repositories`);
  reposUrl.searchParams.set('q', `${query}+pushed:>=${cutoffDate}`);
  reposUrl.searchParams.set('sort', 'stars');
  reposUrl.searchParams.set('per_page', '20');

  const prsUrl = new URL(`${GITHUB_API_BASE}/search/issues`);
  prsUrl.searchParams.set('q', `${query}+type:pr+created:>=${cutoffDate}`);
  prsUrl.searchParams.set('sort', 'reactions');
  prsUrl.searchParams.set('per_page', '10');

  const [reposRaw, prsRaw] = await Promise.all([
    fetchGitHubJSON(reposUrl, config, signal),
    fetchGitHubJSON(prsUrl, config, signal),
  ]);

  const repoItems: GitHubRepo[] =
    isRecord(reposRaw) && Array.isArray(reposRaw.items) ? reposRaw.items.map(parseGitHubRepo) : [];

  const prItems: GitHubPR[] =
    isRecord(prsRaw) && Array.isArray(prsRaw.items) ? prsRaw.items.map(parseGitHubPR) : [];

  const items = [...repoItems.map(normalizeGitHubRepo), ...prItems.map(normalizeGitHubPR)];

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
