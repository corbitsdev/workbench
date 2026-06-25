import type { DB } from "@intx/db";
import { agentInstance } from "@intx/db/schema";
import {
  getAnalyticsSummary,
  getAnalyticsSummaryByAgent,
  getAnalyticsSummaryByInstance,
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
  inference: {
    summary: AnalyticsSummary;
    byAgent: Awaited<ReturnType<typeof getAnalyticsSummaryByAgent>>;
    byInstance: Awaited<ReturnType<typeof getAnalyticsSummaryByInstance>>;
  };
};

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
  const [summary, byAgent, byInstance] = await Promise.all([
    getAnalyticsSummary(inferenceFilter),
    getAnalyticsSummaryByAgent(inferenceFilter),
    getAnalyticsSummaryByInstance(inferenceFilter),
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
    inference: { summary, byAgent, byInstance },
  };
}
