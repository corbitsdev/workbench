import { and, eq, gte, inArray, lte, sql, type AnyColumn } from "drizzle-orm";

import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";

import { analyticsEvent, analyticsRollupDaily } from "./schema";

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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

type AnalyticsModelTokenFields = Partial<
  Pick<
    AnalyticsModelRow,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "thinkingTokens"
  >
>;

/** Sum of all token classes on a per-model rollup row. */
export function sumAnalyticsModelTokens(row: AnalyticsModelTokenFields): number {
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
  row: Pick<AnalyticsModelRow, "turnCount"> & AnalyticsModelTokenFields,
): number {
  return row.turnCount > 0 ? row.turnCount : sumAnalyticsModelTokens(row);
}

function modelRowHasUsage(row: {
  model: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
}): row is typeof row & { model: string } {
  if (row.model === null || row.model.trim() === "") return false;
  return row.turnCount > 0 || sumAnalyticsModelTokens(row) > 0;
}

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
    .groupBy(analyticsRollupDaily.model);

  return rows
    .filter(modelRowHasUsage)
    .map((row) => ({
      model: row.model,
      turnCount: row.turnCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      thinkingTokens: row.thinkingTokens,
    }))
    .sort((a, b) => {
      const tokenDelta =
        sumAnalyticsModelTokens(b) - sumAnalyticsModelTokens(a);
      if (tokenDelta !== 0) return tokenDelta;
      return b.turnCount - a.turnCount;
    })
    .slice(0, 50);
}

export type CacheBaselineRow = {
  agentId: string;
  agentName: string | null;
  inferenceCalls: number;
  cacheMissCalls: number;
  cacheHitCalls: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Fraction of completed inference calls that read nothing from cache. */
  cacheMissRate: number;
  /**
   * Fraction of prompt-side tokens served from cache
   * (cacheRead / (cacheRead + input)) — how much of the prompt prefix (system
   * prompt + tool schemas) prompt caching is absorbing. Near 1 means Myra's
   * ~50-schema tool prefix is being reused rather than re-billed as input.
   */
  cacheAbsorptionRatio: number;
};

/**
 * Prompt-caching baseline over the raw per-call `inference_done` facts (the
 * rollup drops the per-call cache split). Reports, per agent, how often a
 * completed inference call cold-starts (reads nothing from cache) and how much
 * of the prompt prefix caching absorbs — the two questions the Myra tool-prefix
 * baseline needs. `inference_done` carries the terminal usage block for a call,
 * so counting it avoids double-counting the interim `inference_usage` fact.
 *
 * Two reader caveats: `cacheMissRate` counts every session's first call as a
 * miss (a cold-start `cacheRead` of 0 is unavoidable), so a tenant with many
 * short sessions shows an inflated rate that reflects session shape, not a
 * caching failure. `agentName` is null for an orphaned/renamed agent (the row
 * is kept, not dropped). See the schema note in schema.ts on the raw-fact
 * index this reader will eventually want.
 */
export async function getCacheBaseline(
  args: { db: DB["db"] } & AnalyticsSummaryFilter,
): Promise<CacheBaselineRow[]> {
  const { db, tenantId, agentId, instanceId, range } = args;
  const rows = await db
    .select({
      agentId: analyticsEvent.agentId,
      agentName: intxSchema.agent.name,
      inferenceCalls: sql<number>`count(*)`.mapWith(Number),
      cacheMissCalls:
        sql<number>`sum(case when ${analyticsEvent.cacheReadTokens} = 0 then 1 else 0 end)`.mapWith(
          Number,
        ),
      sessionCount:
        sql<number>`count(distinct ${analyticsEvent.sessionId})`.mapWith(
          Number,
        ),
      inputTokens: sumInteger(analyticsEvent.inputTokens),
      outputTokens: sumInteger(analyticsEvent.outputTokens),
      cacheReadTokens: sumInteger(analyticsEvent.cacheReadTokens),
      cacheWriteTokens: sumInteger(analyticsEvent.cacheWriteTokens),
    })
    .from(analyticsEvent)
    .leftJoin(intxSchema.agent, eq(analyticsEvent.agentId, intxSchema.agent.id))
    .where(
      and(
        eq(analyticsEvent.tenantId, tenantId),
        eq(analyticsEvent.eventType, "inference_done"),
        agentId !== undefined ? eq(analyticsEvent.agentId, agentId) : undefined,
        instanceId !== undefined
          ? eq(analyticsEvent.instanceId, instanceId)
          : undefined,
        range?.startDate !== undefined
          ? gte(
              analyticsEvent.occurredAt,
              new Date(`${range.startDate}T00:00:00.000Z`),
            )
          : undefined,
        range?.endDate !== undefined
          ? lte(
              analyticsEvent.occurredAt,
              new Date(`${range.endDate}T23:59:59.999Z`),
            )
          : undefined,
      ),
    )
    .groupBy(analyticsEvent.agentId, intxSchema.agent.name);

  return rows
    .filter(
      (row): row is typeof row & { agentId: string } =>
        row.agentId !== null && row.inferenceCalls > 0,
    )
    .map((row) => {
      const promptTokens = row.cacheReadTokens + row.inputTokens;
      return {
        agentId: row.agentId,
        agentName: row.agentName ?? null,
        inferenceCalls: row.inferenceCalls,
        cacheMissCalls: row.cacheMissCalls,
        cacheHitCalls: row.inferenceCalls - row.cacheMissCalls,
        sessionCount: row.sessionCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        cacheMissRate: row.cacheMissCalls / row.inferenceCalls,
        cacheAbsorptionRatio:
          promptTokens === 0 ? 0 : row.cacheReadTokens / promptTokens,
      };
    })
    .sort((a, b) => b.inferenceCalls - a.inferenceCalls);
}

export type PrincipalToolRow = {
  name: string;
  calls: number;
  errors: number;
};

export type PrincipalCostSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  inferenceCalls: number;
  toolCalls: number;
};

// Per-tool call breakdown for a principal set, read from the DURABLE
// analytics_event fact table. Attribution is by principal_id (the instance's
// synthetic principal), matching the timeline's own attribution — NOT by the
// loaded timeline window, which is why the old facet under-counted.
//
// The tool NAME is not yet stored on the analytics_event row; until it is, the
// name is recovered from turn_part. The collector writes TWO `tool` parts per
// call under the same callId: a `kind:'call'` part that carries `name`, and a
// `kind:'result'` part that does NOT. The LATERAL subquery filters to the part
// that actually has a name (`metadata ->> 'name' is not null`) so it never
// returns the nameless result row, and the LIMIT 1 keeps the join to one name
// per event row (no fan-out / double-count). turn_part cascade-deletes with a
// torn-down instance, so a reaped call has no part and falls back to its callId.
export async function getPrincipalToolBreakdown(args: {
  db: DB["db"];
  tenantId: string;
  principalIds: readonly string[];
}): Promise<PrincipalToolRow[]> {
  const { db, tenantId, principalIds } = args;
  if (principalIds.length === 0) return [];
  const ids = sql.join(
    principalIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const query = sql`
    select
      coalesce(tp.name, ae.tool_call_id, 'Unknown tool') as name,
      count(*)::int as calls,
      sum(case when ae.status = 'error' then 1 else 0 end)::int as errors
    from analytics_event ae
    left join lateral (
      select p.metadata ->> 'name' as name
      from turn_part p
      where p.type = 'tool'
        and p.session_id = ae.session_id
        and p.metadata ->> 'callId' = ae.tool_call_id
        and p.metadata ->> 'name' is not null
      limit 1
    ) tp on true
    where ae.tenant_id = ${tenantId}
      and ae.event_type = 'tool_call'
      and ae.principal_id in (${ids})
    group by 1
    order by calls desc, name asc
  `;
  const result: unknown = await db.execute(query);
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({
    name: String(row["name"] ?? "").trim() || "Unknown tool",
    calls: Number(row["calls"] ?? 0),
    errors: Number(row["errors"] ?? 0),
  }));
}

// Tenant-wide per-tool call breakdown (CL-3667), read from the DURABLE
// analytics_event fact table. Identical shape and name-recovery machinery to
// `getPrincipalToolBreakdown` — the LATERAL turn_part join that recovers the
// tool name from the `kind:'call'` part and never the nameless result row — but
// scoped to the whole tenant instead of one principal set. This is the
// tenant-level companion to the per-principal facet: it answers "which tools is
// the whole workbench calling, and how often do they error," without the caller
// having to fan the per-principal query across every member.
export async function getTenantToolBreakdown(args: {
  db: DB["db"];
  tenantId: string;
}): Promise<PrincipalToolRow[]> {
  const { db, tenantId } = args;
  const query = sql`
    select
      coalesce(tp.name, ae.tool_call_id, 'Unknown tool') as name,
      count(*)::int as calls,
      sum(case when ae.status = 'error' then 1 else 0 end)::int as errors
    from analytics_event ae
    left join lateral (
      select p.metadata ->> 'name' as name
      from turn_part p
      where p.type = 'tool'
        and p.session_id = ae.session_id
        and p.metadata ->> 'callId' = ae.tool_call_id
        and p.metadata ->> 'name' is not null
      limit 1
    ) tp on true
    where ae.tenant_id = ${tenantId}
      and ae.event_type = 'tool_call'
    group by 1
    order by calls desc, name asc
  `;
  const result: unknown = await db.execute(query);
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({
    name: String(row["name"] ?? "").trim() || "Unknown tool",
    calls: Number(row["calls"] ?? 0),
    errors: Number(row["errors"] ?? 0),
  }));
}

// Token/cost totals for a principal set from the DURABLE raw facts.
// Tokens live only on `inference_done` rows; `tool_call` rows carry zero tokens,
// so cost is summed over inference_done and the tool count is a separate tally.
// Attribution is by principal_id (matches the timeline), NOT the daily rollup —
// the raw facts carry the per-principal grain the rollup drops.
export async function getPrincipalCostSummary(args: {
  db: DB["db"];
  tenantId: string;
  principalIds: readonly string[];
}): Promise<PrincipalCostSummary> {
  const { db, tenantId, principalIds } = args;
  const empty: PrincipalCostSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    inferenceCalls: 0,
    toolCalls: 0,
  };
  if (principalIds.length === 0) return empty;
  const ids = [...principalIds];

  const costRows = await db
    .select({
      inputTokens: sumInteger(analyticsEvent.inputTokens),
      outputTokens: sumInteger(analyticsEvent.outputTokens),
      cacheReadTokens: sumInteger(analyticsEvent.cacheReadTokens),
      cacheWriteTokens: sumInteger(analyticsEvent.cacheWriteTokens),
      thinkingTokens: sumInteger(analyticsEvent.thinkingTokens),
      inferenceCalls: sql<number>`count(*)`.mapWith(Number),
    })
    .from(analyticsEvent)
    .where(
      and(
        eq(analyticsEvent.tenantId, tenantId),
        eq(analyticsEvent.eventType, "inference_done"),
        inArray(analyticsEvent.principalId, ids),
      ),
    );

  const toolRows = await db
    .select({ toolCalls: sql<number>`count(*)`.mapWith(Number) })
    .from(analyticsEvent)
    .where(
      and(
        eq(analyticsEvent.tenantId, tenantId),
        eq(analyticsEvent.eventType, "tool_call"),
        inArray(analyticsEvent.principalId, ids),
      ),
    );

  const c = costRows[0];
  return {
    inputTokens: c?.inputTokens ?? 0,
    outputTokens: c?.outputTokens ?? 0,
    cacheReadTokens: c?.cacheReadTokens ?? 0,
    cacheWriteTokens: c?.cacheWriteTokens ?? 0,
    thinkingTokens: c?.thinkingTokens ?? 0,
    inferenceCalls: c?.inferenceCalls ?? 0,
    toolCalls: toolRows[0]?.toolCalls ?? 0,
  };
}

function sumInteger(column: AnyColumn) {
  // Token sums use bigint columns but are returned as JS number. At current
  // tenant scale this is safe. If per-tenant cumulative tokens approach 2^53,
  // switch the return type to bigint and update the route serialization.
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}
