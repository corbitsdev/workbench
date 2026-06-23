import { and, eq, gte, lte, sql, type AnyColumn } from 'drizzle-orm';

import type { DB } from '@intx/db';

import { analyticsRollupDaily } from './schema';

export type AnalyticsDateRange = {
  startDate?: string;
  endDate?: string;
};

export type AnalyticsSummary = {
  tenantId: string;
  turnCount: number;
  failedTurnCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

export async function getAnalyticsSummary(args: {
  db: DB['db'];
  tenantId: string;
  range?: AnalyticsDateRange;
}): Promise<AnalyticsSummary> {
  const { db, tenantId, range } = args;
  const rows = await db
    .select({
      turnCount: sumInteger(analyticsRollupDaily.turnCount),
      failedTurnCount: sumInteger(analyticsRollupDaily.failedTurnCount),
      toolCallCount: sumInteger(analyticsRollupDaily.toolCallCount),
      toolErrorCount: sumInteger(analyticsRollupDaily.toolErrorCount),
      inputTokens: sumInteger(analyticsRollupDaily.inputTokens),
      outputTokens: sumInteger(analyticsRollupDaily.outputTokens),
      cacheReadTokens: sumInteger(analyticsRollupDaily.cacheReadTokens),
      cacheWriteTokens: sumInteger(analyticsRollupDaily.cacheWriteTokens),
      thinkingTokens: sumInteger(analyticsRollupDaily.thinkingTokens),
    })
    .from(analyticsRollupDaily)
    .where(rollupWhere(tenantId, range));

  const row = rows[0];
  return {
    tenantId,
    turnCount: row?.turnCount ?? 0,
    failedTurnCount: row?.failedTurnCount ?? 0,
    toolCallCount: row?.toolCallCount ?? 0,
    toolErrorCount: row?.toolErrorCount ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    cacheReadTokens: row?.cacheReadTokens ?? 0,
    cacheWriteTokens: row?.cacheWriteTokens ?? 0,
    thinkingTokens: row?.thinkingTokens ?? 0,
  };
}

function rollupWhere(tenantId: string, range: AnalyticsDateRange | undefined) {
  return and(
    eq(analyticsRollupDaily.tenantId, tenantId),
    range?.startDate === undefined
      ? undefined
      : gte(analyticsRollupDaily.bucketDate, range.startDate),
    range?.endDate === undefined ? undefined : lte(analyticsRollupDaily.bucketDate, range.endDate)
  );
}

function sumInteger(column: AnyColumn) {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}
