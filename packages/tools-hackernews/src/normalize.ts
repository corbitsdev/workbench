import type { HNPost } from "./types";

export function normalizeHNPost(item: HNPost) {
  return {
    url: item.url ?? `https://news.ycombinator.com/item?id=${item.objectID}`,
    title: item.title,
    publishedAt: new Date(item.created_at_i * 1000).toISOString(),
    source: "hn",
    engagement: {
      upvotes: item.points ?? 0,
      comments: item.num_comments ?? 0,
    },
  };
}
