import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";
import { agentInstance } from "@intx/db/schema";
import {
  analyticsRollupDaily,
  getAnalyticsDailySeries,
  getAnalyticsModelDistribution,
  getAnalyticsSummary,
  getAnalyticsSummaryByAgent,
  getAnalyticsSummaryByInstance,
  getConversationActivity,
  getTokenDataStartDate,
  type AnalyticsDailyPoint,
  type AnalyticsDateRange,
  type AnalyticsSummary,
} from "@workbench/analytics";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  sql,
  type AnyColumn,
} from "drizzle-orm";

import {
  artifact,
  memberAgentInstance,
  workflowRun,
  workflowRunRecord,
} from "../db/schema";

export type UsageByPersonRow = {
  /** Owning member's user-principal id (from `member_agent_instance`). */
  principalId: string;
  /** Display name from the user behind that principal, null if unresolved. */
  name: string | null;
  /** True when this row is the authenticated caller. */
  isSelf: boolean;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
};

export type ActivityCountRow = { key: string; count: number };

export type UsageByWorkflowTypeRow = {
  /** Workflow kind (e.g. `last30days`, `mvt-landing-page`). */
  kind: string;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
};

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
  /**
   * Earliest date real token counts exist (null when none). Token and tool-error
   * metrics are zero for pre-subscriber HISTORY buckets, so the UI caveats any
   * range starting before this date. See `backfill-analytics-rollups.ts`.
   */
  tokensRecordedFrom: string | null;
  /**
   * Usage attributed to the person who owns each agent instance, via the
   * hub-owned `member_agent_instance` link (instance → owning member). The
   * analytics principal on raw events is the per-instance synthetic principal,
   * NOT the user, so attribution goes through this link rather than a naive
   * principal==user assumption. Per-run workflow instances carry no such link
   * (CL-2705), so they are additionally resolved through
   * `workflow_run_record.principalId` — the human who started the run — keyed on
   * the `ins_<deploymentId>` address convention. Instances with neither a member
   * link nor a workflow run record (e.g. shared/system agents) are excluded —
   * their usage cannot be attributed to one person.
   */
  byPerson: UsageByPersonRow[];
  /**
   * Token/turn usage attributed to each workflow kind. Workflow-run inference
   * runs under per-deployment agent instances whose `address` embeds the
   * deployment id (`ins_<deploymentId>…`); joining the rollup through that
   * address to `workflow_run.kind` aggregates usage by workflow type. Non-
   * workflow agents (Myra, member instances) have no matching `workflow_run`
   * row and are excluded.
   */
  byWorkflowType: UsageByWorkflowTypeRow[];
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

function sumInt(column: AnyColumn) {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

export async function getUsageByPerson(args: {
  db: DB["db"];
  tenantId: string;
  callerPrincipalId: string | null;
  range?: AnalyticsDateRange;
}): Promise<UsageByPersonRow[]> {
  const { db, tenantId, callerPrincipalId, range } = args;

  // `member_agent_instance` has no DB-level uniqueness on `instanceId`, so a
  // reassigned or re-provisioned instance can have more than one link row.
  // Joining the rollup directly to it would fan out and multiply every
  // turn/tool/token count. Collapse to one owning member per instance (most
  // recent link), scoped to this tenant so an `instanceId` that also exists
  // under another tenant cannot bleed attribution across the boundary.
  const ownerByInstance = db
    .selectDistinctOn([memberAgentInstance.instanceId], {
      instanceId: memberAgentInstance.instanceId,
      memberPrincipalId: memberAgentInstance.memberPrincipalId,
    })
    .from(memberAgentInstance)
    .where(eq(memberAgentInstance.tenantId, tenantId))
    .orderBy(
      memberAgentInstance.instanceId,
      desc(memberAgentInstance.createdAt),
    )
    .as("owner_by_instance");

  // Per-run workflow instances (CL-2582/CL-2705) carry the workflow
  // DEFINITION's synthetic principal and never get a `member_agent_instance`
  // mapping — the human who started the run exists only on
  // `workflow_run_record.principalId`. Resolve those instances THROUGH the run
  // record: a workflow instance's `address` is `ins_<deploymentId>…` (the same
  // LIKE convention `getUsageByWorkflowType` uses) and
  // `workflow_run_record.deploymentId` names the same per-run deployment, so the
  // record's `principalId` — the tenant `kind:"user"` member principal, exactly
  // the type `member_agent_instance` stores — is the owning member. Collapse to
  // one owner per instance (most recent run record) so the LIKE join can't fan
  // out and multiply counts. We resolve through the record rather than minting a
  // mapping per ephemeral instance because those instances (supervisor + every
  // deployed step) are torn down per run, so a mapping row each would accumulate
  // junk the deployment reclaim never sweeps; resolving here keeps attribution
  // stateless and touches nothing on the workflow-stability-critical run path.
  const workflowOwnerByInstance = db
    .selectDistinctOn([agentInstance.id], {
      instanceId: agentInstance.id,
      memberPrincipalId: workflowRunRecord.principalId,
    })
    .from(agentInstance)
    .innerJoin(
      workflowRunRecord,
      and(
        eq(workflowRunRecord.tenantId, tenantId),
        isNull(workflowRunRecord.deletedAt),
        isNotNull(workflowRunRecord.deploymentId),
        like(
          agentInstance.address,
          sql`'ins_' || ${workflowRunRecord.deploymentId} || '%'`,
        ),
      ),
    )
    .where(eq(agentInstance.tenantId, tenantId))
    .orderBy(agentInstance.id, desc(workflowRunRecord.createdAt))
    .as("workflow_owner_by_instance");

  // One owning member per instance, preferring the explicit
  // `member_agent_instance` mapping and falling back to the workflow run
  // record's principal. The two instance sets are disjoint (a workflow per-run
  // instance has no mapping row and vice versa), so left-joining both and
  // `coalesce`-ing picks whichever is present — mapping first when, defensively,
  // both are. Instances in neither set (e.g. shared/system agents) coalesce to
  // NULL and are dropped by the `IS NOT NULL` filter below, staying unattributed
  // rather than being force-assigned.
  const resolvedMemberPrincipalId = sql<string>`coalesce(${ownerByInstance.memberPrincipalId}, ${workflowOwnerByInstance.memberPrincipalId})`;

  // `principalId` here is the owning member's tenant `kind: "user"` principal
  // (the column `ensureMember` writes and the route's `c.get("principal")`
  // reads), NOT the per-instance synthetic principal on raw analytics events —
  // so comparing it to `callerPrincipalId` for `isSelf` is like-for-like.
  const rows = await db
    .select({
      principalId: sql<string>`${resolvedMemberPrincipalId}`,
      name: intxSchema.user.name,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
    })
    .from(analyticsRollupDaily)
    .leftJoin(
      ownerByInstance,
      eq(ownerByInstance.instanceId, analyticsRollupDaily.instanceId),
    )
    .leftJoin(
      workflowOwnerByInstance,
      eq(workflowOwnerByInstance.instanceId, analyticsRollupDaily.instanceId),
    )
    .leftJoin(
      intxSchema.principal,
      eq(intxSchema.principal.id, resolvedMemberPrincipalId),
    )
    .leftJoin(
      intxSchema.user,
      eq(intxSchema.user.id, intxSchema.principal.refId),
    )
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        isNotNull(resolvedMemberPrincipalId),
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(resolvedMemberPrincipalId, intxSchema.user.name);

  return rows
    .map((row) => ({
      principalId: row.principalId,
      name: row.name ?? null,
      isSelf:
        callerPrincipalId !== null && row.principalId === callerPrincipalId,
      turnCount: row.turnCount,
      toolCallCount: row.toolCallCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
}

export async function getUsageByWorkflowType(args: {
  db: DB["db"];
  tenantId: string;
  range?: AnalyticsDateRange;
}): Promise<UsageByWorkflowTypeRow[]> {
  const { db, tenantId, range } = args;

  // Workflow-run inference is recorded against per-deployment agent instances
  // whose `address` is `ins_<deploymentId>@…` (or `ins_<deploymentId>-<stepId>@…`
  // for step agents). The rollup only stores the resolved `instanceId`, so we
  // rejoin `agentInstance` to recover the address, then match its `ins_<id>`
  // prefix to a deployment's `kind` (the same LIKE convention the deploy route
  // uses). `deployment_id` has no DB-level uniqueness — the pre-CL-2582 model
  // ran many serial runs per deployment, so historical rows can share one — and
  // a naive join to `workflow_run` would fan out, multiplying each instance's
  // tokens by the run count. Collapse to one (deploymentId, kind) per deployment
  // first so the join is 1:1 per instance. Exclude soft-deleted runs to match
  // the ledger's other `workflow_run` reads, and add `kind` as a `DISTINCT ON`
  // tiebreaker so the picked row is deterministic (kind is constant per
  // deployment today, so the tiebreaker only guards against future drift).
  const runByDeployment = db
    .selectDistinctOn([workflowRun.deploymentId], {
      deploymentId: workflowRun.deploymentId,
      kind: workflowRun.kind,
    })
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.tenantId, tenantId),
        isNull(workflowRun.deletedAt),
        isNotNull(workflowRun.deploymentId),
      ),
    )
    .orderBy(workflowRun.deploymentId, workflowRun.kind)
    .as("run_by_deployment");

  const rows = await db
    .select({
      kind: runByDeployment.kind,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
    })
    .from(analyticsRollupDaily)
    .innerJoin(
      agentInstance,
      and(
        eq(agentInstance.id, analyticsRollupDaily.instanceId),
        eq(agentInstance.tenantId, analyticsRollupDaily.tenantId),
      ),
    )
    .innerJoin(
      runByDeployment,
      like(
        agentInstance.address,
        sql`'ins_' || ${runByDeployment.deploymentId} || '%'`,
      ),
    )
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(runByDeployment.kind);

  return rows
    .map((row) => ({
      kind: row.kind,
      turnCount: row.turnCount,
      toolCallCount: row.toolCallCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
}

export async function getActivityOverview(args: {
  db: DB["db"];
  tenantId: string;
  callerPrincipalId?: string | null;
  range?: AnalyticsDateRange;
}): Promise<ActivityOverview> {
  const { db, tenantId } = args;
  const callerPrincipalId = args.callerPrincipalId ?? null;
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
    tokensRecordedFrom,
    byPerson,
    byWorkflowType,
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
    getTokenDataStartDate({ db, tenantId }),
    getUsageByPerson({ db, tenantId, callerPrincipalId, range }),
    getUsageByWorkflowType({ db, tenantId, range }),
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
    tokensRecordedFrom,
    byPerson,
    byWorkflowType,
    inference: { summary, previousSummary, byAgent, byInstance },
  };
}
