import type { DB } from "@intx/db";
import { agentInstance } from "@intx/db/schema";
import {
  getAnalyticsDailySeries,
  getAnalyticsModelDistribution,
  getAnalyticsSummary,
  getAnalyticsSummaryByAgent,
  getAnalyticsSummaryByInstance,
  getConversationActivity,
  type AnalyticsDailyPoint,
  type AnalyticsDateRange,
  type AnalyticsSummary,
} from "@workbench/analytics";
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type AnyColumn,
} from "drizzle-orm";

import { artifact, workflowRun, workflowRunRecord } from "../db/schema";

export type ActivityCountRow = { key: string; count: number };

export type ActivityOverview = {
  tenantId: string;
  range: AnalyticsDateRange;
  artifacts: {
    total: number;
    createdInRange: number;
    byStatus: ActivityCountRow[];
    byKind: ActivityCountRow[];
  };
  workflowRuns: {
    executionRecords: number;
    executionsStartedInRange: number;
    activeExecutions: number;
    byStatus: ActivityCountRow[];
    byKind: ActivityCountRow[];
    deploymentsIndexed: number;
  };
  agentInstances: {
    active: number;
    startedInRange: number;
    endedInRange: number;
    total: number;
  };
  agentActivity: {
    active: number;
    idle: number;
  };
  conversations: {
    total: number;
    createdInRange: number;
  };
  messages: {
    total: number;
    createdInRange: number;
  };
  dailySeries: AnalyticsDailyPoint[];
  models: ActivityCountRow[];
  inference: {
    summary: AnalyticsSummary;
    previousSummary: AnalyticsSummary | null;
    byAgent: Awaited<ReturnType<typeof getAnalyticsSummaryByAgent>>;
    byInstance: Awaited<ReturnType<typeof getAnalyticsSummaryByInstance>>;
  };
};

export function computePreviousRange(
  range: AnalyticsDateRange,
  today: string,
): AnalyticsDateRange | null {
  if (range.startDate === undefined) return null;
  const msPerDay = 86_400_000;
  const endRef = range.endDate ?? today;
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${endRef}T00:00:00.000Z`);
  const lengthDays =
    Math.round((end.getTime() - start.getTime()) / msPerDay) + 1;
  if (lengthDays <= 0) return null;
  const prevEnd = new Date(start.getTime() - msPerDay);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * msPerDay);
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
  };
}

export function deriveAgentActivity(
  byInstance: { turnCount: number }[],
  totalInstances: number,
): { active: number; idle: number } {
  const active = byInstance.filter((row) => row.turnCount > 0).length;
  return { active, idle: Math.max(0, totalInstances - active) };
}

function createdInRange(
  createdAtColumn: AnyColumn,
  range?: AnalyticsDateRange,
) {
  if (range?.startDate === undefined && range?.endDate === undefined) {
    return undefined;
  }
  const start = range?.startDate
    ? new Date(`${range.startDate}T00:00:00.000Z`)
    : undefined;
  const end = range?.endDate
    ? new Date(`${range.endDate}T23:59:59.999Z`)
    : undefined;
  return and(
    start !== undefined ? gte(createdAtColumn, start) : undefined,
    end !== undefined ? lte(createdAtColumn, end) : undefined,
  );
}

function rangeEndedFilters(range?: AnalyticsDateRange) {
  if (range?.startDate === undefined && range?.endDate === undefined) {
    return undefined;
  }
  const start = range?.startDate
    ? new Date(`${range.startDate}T00:00:00.000Z`)
    : undefined;
  const end = range?.endDate
    ? new Date(`${range.endDate}T23:59:59.999Z`)
    : undefined;
  return and(
    isNotNull(agentInstance.endedAt),
    start !== undefined ? gte(agentInstance.endedAt, start) : undefined,
    end !== undefined ? lte(agentInstance.endedAt, end) : undefined,
  );
}

export async function getActivityOverview(args: {
  db: DB["db"];
  tenantId: string;
  range?: AnalyticsDateRange;
}): Promise<ActivityOverview> {
  const { db, tenantId } = args;
  const range = args.range ?? {};

  const tenantArtifacts = and(
    eq(artifact.tenantId, tenantId),
    ne(artifact.status, "rejected"),
  );

  const [
    artifactTotalRow,
    artifactInRangeRow,
    artifactByStatus,
    artifactByKind,
  ] = await Promise.all([
    db.select({ count: count() }).from(artifact).where(tenantArtifacts),
    db
      .select({ count: count() })
      .from(artifact)
      .where(and(tenantArtifacts, createdInRange(artifact.createdAt, range))),
    db
      .select({ key: artifact.status, count: count() })
      .from(artifact)
      .where(tenantArtifacts)
      .groupBy(artifact.status),
    db
      .select({ key: artifact.kind, count: count() })
      .from(artifact)
      .where(tenantArtifacts)
      .groupBy(artifact.kind)
      .orderBy(sql`count(*) desc`)
      .limit(25),
  ]);

  const runBase = and(
    eq(workflowRunRecord.tenantId, tenantId),
    isNull(workflowRunRecord.deletedAt),
  );

  const [
    runTotalRow,
    runInRangeRow,
    runActiveRow,
    runByStatus,
    runByKind,
    deploymentRow,
  ] = await Promise.all([
    db.select({ count: count() }).from(workflowRunRecord).where(runBase),
    db
      .select({ count: count() })
      .from(workflowRunRecord)
      .where(and(runBase, createdInRange(workflowRunRecord.createdAt, range))),
    db
      .select({ count: count() })
      .from(workflowRunRecord)
      .where(
        and(
          runBase,
          inArray(workflowRunRecord.status, ["running", "awaiting"]),
        ),
      ),
    db
      .select({ key: workflowRunRecord.status, count: count() })
      .from(workflowRunRecord)
      .where(runBase)
      .groupBy(workflowRunRecord.status),
    db
      .select({ key: workflowRunRecord.kind, count: count() })
      .from(workflowRunRecord)
      .where(runBase)
      .groupBy(workflowRunRecord.kind)
      .orderBy(sql`count(*) desc`)
      .limit(25),
    db
      .select({ count: count() })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.tenantId, tenantId),
          isNull(workflowRun.deletedAt),
          isNotNull(workflowRun.deploymentId),
        ),
      ),
  ]);

  const instanceTenant = eq(agentInstance.tenantId, tenantId);

  const [
    instanceActiveRow,
    instanceStartedRow,
    instanceEndedRow,
    instanceTotalRow,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(agentInstance)
      .where(and(instanceTenant, isNull(agentInstance.endedAt))),
    db
      .select({ count: count() })
      .from(agentInstance)
      .where(
        and(instanceTenant, createdInRange(agentInstance.createdAt, range)),
      ),
    db
      .select({ count: count() })
      .from(agentInstance)
      .where(and(instanceTenant, rangeEndedFilters(range))),
    db.select({ count: count() }).from(agentInstance).where(instanceTenant),
  ]);

  const inferenceFilter = { db, tenantId, range };
  const today = new Date().toISOString().slice(0, 10);
  const previousRange = computePreviousRange(range, today);
  const [
    summary,
    byAgent,
    byInstance,
    dailySeries,
    modelRows,
    conversationActivity,
    previousSummary,
  ] = await Promise.all([
    getAnalyticsSummary(inferenceFilter),
    getAnalyticsSummaryByAgent(inferenceFilter),
    getAnalyticsSummaryByInstance(inferenceFilter),
    getAnalyticsDailySeries(inferenceFilter),
    getAnalyticsModelDistribution(inferenceFilter),
    getConversationActivity({ db, tenantId, range }),
    previousRange !== null
      ? getAnalyticsSummary({ db, tenantId, range: previousRange })
      : Promise.resolve(null),
  ]);

  return {
    tenantId,
    range,
    artifacts: {
      total: Number(artifactTotalRow[0]?.count ?? 0),
      createdInRange: Number(artifactInRangeRow[0]?.count ?? 0),
      byStatus: artifactByStatus.map((r) => ({
        key: r.key,
        count: Number(r.count),
      })),
      byKind: artifactByKind.map((r) => ({
        key: r.key,
        count: Number(r.count),
      })),
    },
    workflowRuns: {
      executionRecords: Number(runTotalRow[0]?.count ?? 0),
      executionsStartedInRange: Number(runInRangeRow[0]?.count ?? 0),
      activeExecutions: Number(runActiveRow[0]?.count ?? 0),
      byStatus: runByStatus.map((r) => ({
        key: r.key,
        count: Number(r.count),
      })),
      byKind: runByKind.map((r) => ({ key: r.key, count: Number(r.count) })),
      deploymentsIndexed: Number(deploymentRow[0]?.count ?? 0),
    },
    agentInstances: {
      active: Number(instanceActiveRow[0]?.count ?? 0),
      startedInRange: Number(instanceStartedRow[0]?.count ?? 0),
      endedInRange: Number(instanceEndedRow[0]?.count ?? 0),
      total: Number(instanceTotalRow[0]?.count ?? 0),
    },
    agentActivity: deriveAgentActivity(
      byInstance,
      Number(instanceTotalRow[0]?.count ?? 0),
    ),
    conversations: conversationActivity.conversations,
    messages: conversationActivity.messages,
    dailySeries,
    models: modelRows.map((row) => ({
      key: row.model,
      count: row.turnCount,
    })),
    inference: { summary, previousSummary, byAgent, byInstance },
  };
}
