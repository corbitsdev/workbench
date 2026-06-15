import type { RedditPost } from './types';

export function normalizeRedditPost(item: RedditPost) {
  const base = {
    url: `https://www.reddit.com${item.permalink}`,
    title: item.title,
    publishedAt: new Date(item.created_utc * 1000).toISOString(),
    source: 'reddit' as const,
    engagement: {
      upvotes: item.ups,
      comments: item.num_comments,
    },
    author: `r/${item.subreddit}`,
  };
  if (item.topComments !== undefined && item.topComments.length > 0) {
    return { ...base, topComments: item.topComments };
  }
  return base;
}
