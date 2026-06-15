import type { ResearchItem } from '@workbench/last30days-core';
import type { BlueskyPost } from './types';

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function rkeyFromUri(uri: string): string {
  const parts = uri.split('/');
  return parts[parts.length - 1] ?? uri;
}

export function normalizeBlueskyPost(post: BlueskyPost): ResearchItem {
  const text = post.record.text;
  const rkey = rkeyFromUri(post.uri);
  const url = `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;

  return {
    url,
    title: truncate(text, 100),
    publishedAt: post.record.createdAt,
    source: 'bluesky',
    engagement: {
      upvotes: post.likeCount,
      comments: post.replyCount,
      shares: post.repostCount,
    },
  };
}
