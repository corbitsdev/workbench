import { describe, expect, test } from 'bun:test';
import { entityExtract } from './entity-extract';

describe('entityExtract', () => {
  test('extracts subreddit from r/ prefix', () => {
    const result = entityExtract('trends in r/programming');
    expect(result.subreddits).toContain('programming');
  });

  test('extracts twitter/x handle from @ prefix', () => {
    const result = entityExtract('what is @elonmusk saying about AI');
    expect(result.handles).toContain('elonmusk');
  });

  test('extracts GitHub repo in owner/repo format', () => {
    const result = entityExtract('updates to vercel/next.js this month');
    expect(result.repos).toContain('vercel/next.js');
  });

  test('extracts hashtag from # prefix', () => {
    const result = entityExtract('discussion about #rustlang');
    expect(result.hashtags).toContain('rustlang');
  });

  test('extracts bare keywords when no special prefix', () => {
    const result = entityExtract('typescript performance improvements');
    expect(result.keywords.length).toBeGreaterThan(0);
  });

  test('is deterministic: same input produces same output', () => {
    const topic = 'r/MachineLearning @openai updates on #LLM trends';
    const a = entityExtract(topic);
    const b = entityExtract(topic);
    expect(a).toEqual(b);
  });

  test('empty string produces empty entity set', () => {
    const result = entityExtract('');
    expect(result.subreddits).toHaveLength(0);
    expect(result.handles).toHaveLength(0);
    expect(result.repos).toHaveLength(0);
    expect(result.hashtags).toHaveLength(0);
  });

  test('multiple entities of same type are all extracted', () => {
    const result = entityExtract('r/rust and r/programming discussions');
    expect(result.subreddits).toContain('rust');
    expect(result.subreddits).toContain('programming');
  });
});
