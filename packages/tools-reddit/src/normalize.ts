import type { RedditPost } from './types';

export function normalizeRedditPost(item: RedditPost) {
  return {
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
}
