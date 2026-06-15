import { describe, expect, it } from 'bun:test';
import { normalizeRedditPost } from './normalize';
import type { RedditPost } from './types';

const fixture: RedditPost = {
  id: 'abc123',
  title: 'Why TypeScript strict mode matters',
  url: 'https://example.com/ts-strict',
  permalink: '/r/typescript/comments/abc123/why_typescript_strict_mode_matters/',
  created_utc: 1700000000,
  ups: 423,
  num_comments: 57,
  subreddit: 'typescript',
};

describe('normalizeRedditPost', () => {
  it('builds url from permalink', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.url).toBe(
      'https://www.reddit.com/r/typescript/comments/abc123/why_typescript_strict_mode_matters/'
    );
  });

  it('preserves title', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.title).toBe('Why TypeScript strict mode matters');
  });

  it('converts created_utc to ISO string', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.publishedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('sets source to reddit', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.source).toBe('reddit');
  });

  it('maps ups to engagement upvotes', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.engagement.upvotes).toBe(423);
  });

  it('maps num_comments to engagement comments', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.engagement.comments).toBe(57);
  });

  it('prefixes subreddit with r/ in author', () => {
    const result = normalizeRedditPost(fixture);
    expect(result.author).toBe('r/typescript');
  });

  it('omits topComments when the post has none', () => {
    const result = normalizeRedditPost(fixture);
    expect('topComments' in result).toBe(false);
  });

  it('passes through topComments when present', () => {
    const result = normalizeRedditPost({
      ...fixture,
      topComments: [{ text: 'this is the way', author: 'u/mando', score: 980 }],
    });
    if (!('topComments' in result)) throw new Error('expected topComments to be present');
    expect(result.topComments?.[0]?.text).toBe('this is the way');
    expect(result.topComments?.[0]?.score).toBe(980);
  });
});
