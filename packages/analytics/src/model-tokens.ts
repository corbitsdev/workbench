// Client-safe module: imported by apps/web via the
// "@workbench/analytics/model-tokens" subpath. It must stay free of imports —
// anything reachable from here is shipped to the browser.

export type AnalyticsModelTokenFields = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
};

/** Sum of all token classes on a per-model rollup row. */
export function sumAnalyticsModelTokens(
  row: AnalyticsModelTokenFields,
): number {
  return (
    (row.inputTokens ?? 0) +
    (row.outputTokens ?? 0) +
    (row.cacheReadTokens ?? 0) +
    (row.cacheWriteTokens ?? 0) +
    (row.thinkingTokens ?? 0)
  );
}

/** Bar / legacy `models.count` value when turns and tokens are mixed in one chart. */
export function analyticsModelDisplayCount(
  row: { turnCount: number } & AnalyticsModelTokenFields,
): number {
  return row.turnCount > 0 ? row.turnCount : sumAnalyticsModelTokens(row);
}
