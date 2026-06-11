import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { normalizeGitHubPR, normalizeGitHubRepo } from './normalize';
import type { GitHubPR, GitHubRepo } from './types';

const repoFixture: GitHubRepo = {
  full_name: 'openai/openai-python',
  html_url: 'https://github.com/openai/openai-python',
  description: 'The official Python library for the OpenAI API',
  stargazers_count: 24000,
  pushed_at: '2026-06-10T18:00:00Z',
};

const prFixture: GitHubPR = {
  html_url: 'https://github.com/openai/openai-python/pull/1234',
  title: 'feat: add streaming support',
  reactions: { total_count: 42 },
  created_at: '2026-06-09T12:00:00Z',
};

describe('normalizeGitHubRepo', () => {
  test('maps all fields correctly', () => {
    const item = normalizeGitHubRepo(repoFixture);
    expect(item.url).toBe('https://github.com/openai/openai-python');
    expect(item.title).toBe('openai/openai-python: The official Python library for the OpenAI API');
    expect(item.publishedAt).toBe('2026-06-10T18:00:00Z');
    expect(item.source).toBe('github');
    expect(item.engagement.upvotes).toBe(24000);
    expect(item.engagement.comments).toBe(0);
    expect(item.entityTag).toBe('openai/openai-python');
  });

  test('handles missing description', () => {
    const noDesc: GitHubRepo = { ...repoFixture, description: undefined };
    const item = normalizeGitHubRepo(noDesc);
    expect(item.title).toBe('openai/openai-python: ');
  });

  test('produces a valid ResearchItem', () => {
    const item = normalizeGitHubRepo(repoFixture);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });
});

describe('normalizeGitHubPR', () => {
  test('maps all fields correctly', () => {
    const item = normalizeGitHubPR(prFixture);
    expect(item.url).toBe('https://github.com/openai/openai-python/pull/1234');
    expect(item.title).toBe('feat: add streaming support');
    expect(item.publishedAt).toBe('2026-06-09T12:00:00Z');
    expect(item.source).toBe('github');
    expect(item.engagement.upvotes).toBe(42);
    expect(item.engagement.comments).toBe(0);
  });

  test('omits entityTag', () => {
    const item = normalizeGitHubPR(prFixture);
    expect('entityTag' in item).toBe(false);
  });

  test('produces a valid ResearchItem', () => {
    const item = normalizeGitHubPR(prFixture);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });
});
