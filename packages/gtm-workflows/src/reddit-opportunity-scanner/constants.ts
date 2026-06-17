export const DEFAULT_SCAN_CONFIG = {
  timeWindow: '30d',
  matchMode: 'keyword-and-competitor',
  scope: 'posts-and-comments',
  threshold: 70,
  resultCap: 25,
} as const;

export const MAX_SITE_CONTENT_CHARS = 80_000;
export const REDDIT_SEARCH_CONCURRENCY = 4;
export const ANALYZE_MAX_OUTPUT_TOKENS = 8192;
export const SCAN_EXPORT_MAX_OUTPUT_TOKENS = 4096;

export const SCAN_TIME_WINDOW_TO_REDDIT: Record<string, string> = {
  '7d': 'week',
  '30d': 'month',
  '90d': 'year',
};
