import { describe, expect, mock, test } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { createGitHubTools, type GitHubFetch } from './tools';

const mockReposResponse = {
  items: [
    {
      full_name: 'acme/cool-repo',
      html_url: 'https://github.com/acme/cool-repo',
      description: 'A cool repository',
      stargazers_count: 5000,
      pushed_at: '2026-06-10T00:00:00Z',
    },
  ],
};

const mockPRsResponse = {
  items: [
    {
      html_url: 'https://github.com/acme/cool-repo/pull/99',
      title: 'Add feature X',
      reactions: { total_count: 15 },
      created_at: '2026-06-08T00:00:00Z',
    },
  ],
};

function makeGitHubFetcher(
  reposResponse: unknown,
  prsResponse: unknown,
  status = 200
): GitHubFetch {
  return mock((url: string, _init?: RequestInit) => {
    const body = url.includes('/search/repositories') ? reposResponse : prsResponse;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
}

describe('github_activity tool', () => {
  test('returns normalized ResearchItems from repos and PRs', async () => {
    const fetcher = makeGitHubFetcher(mockReposResponse, mockPRsResponse);
    const runner = createToolRunner(createGitHubTools({ apiKey: 'test-token', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'github_activity', arguments: { query: 'AI agents' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(2);

    for (const item of items) {
      const validation = ResearchItem(item);
      expect(validation instanceof type.errors).toBe(false);
    }

    const repoItem = items[0] as Record<string, unknown>;
    expect(repoItem.source).toBe('github');
    expect(repoItem.entityTag).toBe('acme/cool-repo');
  });

  test('omits Authorization header when apiKey is empty', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: GitHubFetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 })
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: '', fetcher }));
    await runner.run(
      { id: 'call_1', name: 'github_activity', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    const headers = firstCall?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test('returns empty array when no items', async () => {
    const fetcher = makeGitHubFetcher({ items: [] }, { items: [] });
    const runner = createToolRunner(createGitHubTools({ apiKey: '', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'github_activity', arguments: { query: 'obscure' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test('surfaces HTTP error as tool error', async () => {
    const fetcher: GitHubFetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }))
    );
    const runner = createToolRunner(createGitHubTools({ apiKey: 'bad', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'github_activity', arguments: { query: 'AI' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('GitHub API error: 401');
  });

  test('surfaces missing query as tool error', async () => {
    const fetcher = makeGitHubFetcher({ items: [] }, { items: [] });
    const runner = createToolRunner(createGitHubTools({ apiKey: '', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'github_activity', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('query is required');
  });
});
