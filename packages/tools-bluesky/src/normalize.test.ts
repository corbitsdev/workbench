import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { normalizeBlueskyPost } from './normalize';
import samplePosts from '../fixtures/sample-posts.json';
import type { BlueskyPost } from './types';

const basePost: BlueskyPost = {
  uri: 'at://did:plc:abc123/app.bsky.feed.post/3kpost1',
  cid: 'bafyreia1111111111111111111111111111111111111111111111111111',
  author: {
    did: 'did:plc:abc123',
    handle: 'alice.bsky.social',
    displayName: 'Alice',
  },
  record: {
    $type: 'app.bsky.feed.post',
    text: 'AI startups are changing the GTM playbook. Less spray-and-pray, more signal-driven outreach.',
    createdAt: '2025-06-10T14:00:00.000Z',
  },
  likeCount: 312,
  replyCount: 47,
  repostCount: 89,
  indexedAt: '2025-06-10T14:01:00.000Z',
};

describe('normalizeBlueskyPost', () => {
  test('maps likeCount to upvotes', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.engagement.upvotes).toBe(312);
  });

  test('maps replyCount to comments', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.engagement.comments).toBe(47);
  });

  test('maps repostCount to shares', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.engagement.shares).toBe(89);
  });

  test('sets source to bluesky', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.source).toBe('bluesky');
  });

  test('constructs url from author handle and rkey', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.url).toBe('https://bsky.app/profile/alice.bsky.social/post/3kpost1');
  });

  test('sets publishedAt from record.createdAt', () => {
    const item = normalizeBlueskyPost(basePost);
    expect(item.publishedAt).toBe('2025-06-10T14:00:00.000Z');
  });

  test('truncates text longer than 100 chars to title', () => {
    const longText = 'a'.repeat(200);
    const post: BlueskyPost = { ...basePost, record: { ...basePost.record, text: longText } };
    const item = normalizeBlueskyPost(post);
    expect(item.title.length).toBe(100);
  });

  test('preserves text shorter than 100 chars as title', () => {
    const shortText = 'Short post.';
    const post: BlueskyPost = { ...basePost, record: { ...basePost.record, text: shortText } };
    const item = normalizeBlueskyPost(post);
    expect(item.title).toBe('Short post.');
  });

  test('produces a valid ResearchItem', () => {
    const item = normalizeBlueskyPost(basePost);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });

  test('empty input array returns empty output', () => {
    const items = ([] as BlueskyPost[]).map(normalizeBlueskyPost);
    expect(items).toHaveLength(0);
  });

  test('fixture posts within window normalize correctly', () => {
    const recentPosts = samplePosts.posts.filter(
      (p) => new Date(p.record.createdAt).getFullYear() >= 2025
    ) as BlueskyPost[];
    const items = recentPosts.map(normalizeBlueskyPost);
    expect(items).toHaveLength(2);
    for (const item of items) {
      const result = ResearchItem(item);
      expect(result instanceof type.errors).toBe(false);
    }
  });

  test('old fixture post has a publishedAt far in the past', () => {
    const oldPost = samplePosts.posts[2] as BlueskyPost;
    const item = normalizeBlueskyPost(oldPost);
    const publishedYear = new Date(item.publishedAt).getFullYear();
    expect(publishedYear).toBe(2020);
  });
});
