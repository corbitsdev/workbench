import { and, eq, gte, lte, sql, type AnyColumn } from 'drizzle-orm';

import type { DB } from '@intx/db';

import { analyticsRollupDaily } from './schema';

export type AnalyticsDateRange = {
  startDate?: string;
  endDate?: string;
};

export type AnalyticsSummaryFilter = {
  tenantId: string;
  agentId?: string;
  instanceId?: string;
  range?: AnalyticsDateRange;
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

export async function getAnalyticsSummary(
  args: { db: DB['db'] } & AnalyticsSummaryFilter
): Promise<AnalyticsSummary> {
  const { db, tenantId, agentId, instanceId, range } = args;
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
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        agentId !== undefined ? eq(analyticsRollupDaily.agentId, agentId) : undefined,
        instanceId !== undefined ? eq(analyticsRollupDaily.instanceId, instanceId) : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined
      )
    );

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

function sumInteger(column: AnyColumn) {
  // Token sums use bigint columns but are returned as JS number. At current
  // tenant scale this is safe. If per-tenant cumulative tokens approach 2^53,
  // switch the return type to bigint and update the route serialization.
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}
