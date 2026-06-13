import type { XSearchResult } from './types';

export function normalizeXResult(item: XSearchResult, query: string) {
  const url =
    item.url !== undefined && item.url.length > 0
      ? item.url
      : `https://x.com/search?q=${encodeURIComponent(query)}`;

  return {
    url,
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt ?? new Date().toISOString(),
    source: 'x' as const,
    engagement: {
      upvotes: 0,
      comments: 0,
    },
    provenance: 'degraded' as const,
    author: 'x-grok',
  };
}
