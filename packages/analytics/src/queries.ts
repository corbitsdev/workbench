import { and, eq, gte, lte, sql, type AnyColumn } from "drizzle-orm";

import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";

import { analyticsRollupDaily } from "./schema";

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

export type AnalyticsInstanceRow = {
  instanceId: string;
  agentId: string;
  agentName: string | null;
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

export type AnalyticsAgentRow = {
  agentId: string;
  agentName: string | null;
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

export type AnalyticsDailyPoint = {
  date: string;
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

export type AnalyticsModelRow = {
  model: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
};

export async function getAnalyticsSummary(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
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
        agentId !== undefined
          ? eq(analyticsRollupDaily.agentId, agentId)
          : undefined,
        instanceId !== undefined
          ? eq(analyticsRollupDaily.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
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

export async function getAnalyticsSummaryByAgent(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
): Promise<AnalyticsAgentRow[]> {
  const { db, tenantId, agentId, instanceId, range } = args;
  const rows = await db
    .select({
      agentId: analyticsRollupDaily.agentId,
      agentName: intxSchema.agent.name,
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
    .leftJoin(
      intxSchema.agent,
      eq(analyticsRollupDaily.agentId, intxSchema.agent.id),
    )
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        agentId !== undefined
          ? eq(analyticsRollupDaily.agentId, agentId)
          : undefined,
        instanceId !== undefined
          ? eq(analyticsRollupDaily.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(analyticsRollupDaily.agentId, intxSchema.agent.name);

  return rows
    .filter(
      (row): row is typeof row & { agentId: string } => row.agentId !== null,
    )
    .map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      turnCount: row.turnCount,
      failedTurnCount: row.failedTurnCount,
      toolCallCount: row.toolCallCount,
      toolErrorCount: row.toolErrorCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      thinkingTokens: row.thinkingTokens,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
}

export async function getAnalyticsSummaryByInstance(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
): Promise<AnalyticsInstanceRow[]> {
  const { db, tenantId, agentId, instanceId, range } = args;
  const rows = await db
    .select({
      instanceId: analyticsRollupDaily.instanceId,
      agentId: analyticsRollupDaily.agentId,
      agentName: intxSchema.agent.name,
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
    .leftJoin(
      intxSchema.agent,
      eq(analyticsRollupDaily.agentId, intxSchema.agent.id),
    )
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        agentId !== undefined
          ? eq(analyticsRollupDaily.agentId, agentId)
          : undefined,
        instanceId !== undefined
          ? eq(analyticsRollupDaily.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(
      analyticsRollupDaily.instanceId,
      analyticsRollupDaily.agentId,
      intxSchema.agent.name,
    );

  return rows
    .filter(
      (row): row is typeof row & { instanceId: string; agentId: string } =>
        row.instanceId !== null && row.agentId !== null,
    )
    .map((row) => ({
      instanceId: row.instanceId,
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      turnCount: row.turnCount,
      failedTurnCount: row.failedTurnCount,
      toolCallCount: row.toolCallCount,
      toolErrorCount: row.toolErrorCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      thinkingTokens: row.thinkingTokens,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
}

export async function getAnalyticsDailySeries(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
): Promise<AnalyticsDailyPoint[]> {
  const { db, tenantId, agentId, instanceId, range } = args;
  const rows = await db
    .select({
      date: analyticsRollupDaily.bucketDate,
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
        agentId !== undefined
          ? eq(analyticsRollupDaily.agentId, agentId)
          : undefined,
        instanceId !== undefined
          ? eq(analyticsRollupDaily.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(analyticsRollupDaily.bucketDate)
    .orderBy(analyticsRollupDaily.bucketDate);

  return rows.map((row) => ({
    date: row.date,
    turnCount: row.turnCount,
    failedTurnCount: row.failedTurnCount,
    toolCallCount: row.toolCallCount,
    toolErrorCount: row.toolErrorCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    thinkingTokens: row.thinkingTokens,
  }));
}

/**
 * Earliest bucket date for which real token counts exist for this tenant, or
 * null when no bucket has any tokens. HISTORY buckets (reconstructed by the
 * backfill from `inference_turn`) carry zero tokens — they were never persisted
 * — so a token/cost metric is only truthful from this date forward. The
 * Insights UI uses it to caveat any range that starts earlier.
 */
export async function getTokenDataStartDate(args: {
  db: DB["db"];
  tenantId: string;
}): Promise<string | null> {
  const { db, tenantId } = args;
  const rows = await db
    .select({
      date: sql<string | null>`min(${analyticsRollupDaily.bucketDate})`,
    })
    .from(analyticsRollupDaily)
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        sql`(${analyticsRollupDaily.inputTokens} + ${analyticsRollupDaily.outputTokens} + ${analyticsRollupDaily.cacheReadTokens} + ${analyticsRollupDaily.cacheWriteTokens} + ${analyticsRollupDaily.thinkingTokens}) > 0`,
      ),
    );
  const date = rows[0]?.date;
  return date === undefined || date === null ? null : date;
}

export async function getAnalyticsModelDistribution(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
): Promise<AnalyticsModelRow[]> {
  const { db, tenantId, agentId, instanceId, range } = args;
  const rows = await db
    .select({
      model: analyticsRollupDaily.model,
      turnCount: sumInteger(analyticsRollupDaily.turnCount),
      inputTokens: sumInteger(analyticsRollupDaily.inputTokens),
      outputTokens: sumInteger(analyticsRollupDaily.outputTokens),
    })
    .from(analyticsRollupDaily)
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        agentId !== undefined
          ? eq(analyticsRollupDaily.agentId, agentId)
          : undefined,
        instanceId !== undefined
          ? eq(analyticsRollupDaily.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(analyticsRollupDaily.model);

  return rows
    .filter((row): row is typeof row & { model: string } => row.model !== null)
    .map((row) => ({
      model: row.model,
      turnCount: row.turnCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    }))
    .sort((a, b) => b.turnCount - a.turnCount)
    .slice(0, 50);
}

function sumInteger(column: AnyColumn) {
  // Token sums use bigint columns but are returned as JS number. At current
  // tenant scale this is safe. If per-tenant cumulative tokens approach 2^53,
  // switch the return type to bigint and update the route serialization.
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}
