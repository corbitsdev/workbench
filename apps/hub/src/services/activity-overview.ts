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
  type AnalyticsModelRow,
  type AnalyticsSummary,
} from "@workbench/analytics";
import {
  priceUsageRows,
  UNKNOWN_MODEL_LABEL,
  type ModelUsageRow,
  type PriceCatalog,
  type PricedUsage,
} from "@workbench/pricing";
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
  or,
  sql,
  type AnyColumn,
} from "drizzle-orm";

import {
  artifact,
  memberAgentInstance,
  workflowRun,
  workflowRunRecord,
} from "../db/schema";
import {
  buildMetricsSeries,
  sumTokenClasses,
  type ActiveInstanceDay,
  type MetricsBucket,
  type MetricsPoint,
} from "./metrics-series";

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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  /**
   * Dollar cost (CL-2723), priced per model then summed — never a blended
   * cross-model rate. `null` when the caller supplied no price catalog (see
   * `getUsageByPerson`'s `priceCatalog` param); this is the honest "not
   * computed" state, distinct from `hasUnpriced` on a present `cost`, which
   * means "computed, but some of this person's models had no models.dev rate."
   */
  cost: PricedUsage | null;
};

export type ActivityCountRow = { key: string; count: number };

/** Sentinel principal for rollup rows with no member/workflow owner (CL-2746). */
export const UNATTRIBUTED_PERSON_PRINCIPAL_ID = "unattributed";

export const UNATTRIBUTED_PERSON_LABEL = "Unattributed";

function instanceAddressMatchesDeployment(
  address: AnyColumn,
  deploymentId: AnyColumn,
) {
  return or(
    and(
      sql`substring(${address} from '^ins_([^@]+)@') = ${deploymentId}::text`,
      sql`${address} !~ '^ins_[^-]+-[^@]+@'`,
    ),
    sql`substring(${address} from '^ins_([^-]+)-[^@]+@') = ${deploymentId}::text`,
  );
}

function rangeHasDateBounds(range?: AnalyticsDateRange): boolean {
  return range?.startDate !== undefined || range?.endDate !== undefined;
}

export type UsageByWorkflowTypeRow = {
  /** Workflow kind (e.g. `last30days`, `mvt-landing-page`). */
  kind: string;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  /** Dollar cost (CL-2723) — see {@link UsageByPersonRow.cost}. */
  cost: PricedUsage | null;
};

export type WorkflowRunTokenTotalsRow = {
  /** `workflow_run_record.id` — the run this row's tokens are attributed to. */
  runId: string;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

export type WorkflowRunStepTokenTotalsRow = {
  stepId: string;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
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
  /**
   * Bucket granularity of {@link metricsSeries} (CL-2836). `day` unless the
   * caller requested a coarser roll-up.
   */
  metricsBucket: MetricsBucket;
  /**
   * Continuous, gap-filled per-bucket series of agents deployed (new), agents
   * active (did work that bucket), tokens spent, and artifacts created — the
   * source for the Insights daily CSV export. Distinct from `dailySeries`
   * (inference turns/tokens only); this joins deployment and artifact facts on
   * the same bucket spine so all four metrics align per row.
   */
  metricsSeries: MetricsPoint[];
  models: ActivityCountRow[];
  /**
   * Per-model usage with every token class separated (CL-2714). Drives the
   * cost-by-model view: dollar cost is computed FE-side per class from
   * models.dev rates, with tokens shown as the secondary detail. `models`
   * (turn counts) is kept for the legacy distribution bars.
   */
  byModel: AnalyticsModelRow[];
  /**
   * Tenant-wide model usage priced on the hub when a catalog was supplied (CL-2891).
   * `null` when no catalog was warm at overview time — the UI may fall back to a
   * client-side catalog fetch for the same `priceUsageRows` math.
   */
  pricedByModel: PricedUsage | null;
  /**
   * Earliest date real token counts exist (null when none). Token and tool-error
   * metrics are zero for pre-subscriber HISTORY buckets, so the UI caveats any
   * range starting before this date.
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

/** Range-scoped agent activity for Insights engagement KPIs (CL-2891). */
export function resolveAgentActivity(
  byInstance: { turnCount: number }[],
  allTimeInstanceTotal: number,
  range?: AnalyticsDateRange,
): { active: number; idle: number } {
  if (!rangeHasDateBounds(range)) {
    return deriveAgentActivity(byInstance, allTimeInstanceTotal);
  }
  const active = byInstance.filter((row) => row.turnCount > 0).length;
  const idle = byInstance.filter((row) => row.turnCount === 0).length;
  return { active, idle };
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

function toDateStr(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Created-at dates of non-rejected artifacts in range (for the metrics spine). */
export async function fetchArtifactCreatedDates(
  db: DB["db"],
  tenantId: string,
  range: AnalyticsDateRange,
): Promise<string[]> {
  const rows = await db
    .select({ createdAt: artifact.createdAt })
    .from(artifact)
    .where(
      and(
        eq(artifact.tenantId, tenantId),
        ne(artifact.status, "rejected"),
        createdInRange(artifact.createdAt, range),
      ),
    );
  return rows.map((row) => toDateStr(row.createdAt));
}

/** Created-at dates of agent instances in range (new deployments per bucket). */
export async function fetchInstanceCreatedDates(
  db: DB["db"],
  tenantId: string,
  range: AnalyticsDateRange,
): Promise<string[]> {
  const rows = await db
    .select({ createdAt: agentInstance.createdAt })
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.tenantId, tenantId),
        createdInRange(agentInstance.createdAt, range),
      ),
    );
  return rows.map((row) => toDateStr(row.createdAt));
}

/**
 * Per-instance activity days from the analytics rollup — one row per instance
 * per bucket-date on which it recorded at least one turn. This is the honest
 * "did work" signal for `agentsActive`: instance existence (`agent_instance`
 * rows) never expires in this system, so counting live instances would report a
 * monotonic total, not who actually ran on a given day.
 */
export async function fetchActiveInstanceDays(
  db: DB["db"],
  tenantId: string,
  range: AnalyticsDateRange,
): Promise<ActiveInstanceDay[]> {
  const rows = await db
    .select({
      instanceId: analyticsRollupDaily.instanceId,
      date: analyticsRollupDaily.bucketDate,
    })
    .from(analyticsRollupDaily)
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        isNotNull(analyticsRollupDaily.instanceId),
        range.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(analyticsRollupDaily.instanceId, analyticsRollupDaily.bucketDate)
    .having(sql`sum(${analyticsRollupDaily.turnCount}) > 0`);
  return rows.flatMap((row) =>
    row.instanceId === null
      ? []
      : [{ instanceId: row.instanceId, date: row.date }],
  );
}

export async function getUsageByPerson(args: {
  db: DB["db"];
  tenantId: string;
  callerPrincipalId: string | null;
  range?: AnalyticsDateRange;
  /**
   * models.dev rate catalog (CL-2723). Optional — the caller may not have one
   * warm (see `activity.ts`'s best-effort fetch) — in which case `cost` on
   * every row is `null`, never a fabricated `$0`.
   */
  priceCatalog?: PriceCatalog | null;
}): Promise<UsageByPersonRow[]> {
  const { db, tenantId, callerPrincipalId, range } = args;
  const priceCatalog = args.priceCatalog ?? null;

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
  //
  // KNOWN CAVEAT (CL-2711): for a LEGACY deployment with multiple run records by
  // different principals (pre-CL-2582, when one deployment served many serial
  // runs), the `DISTINCT ON (agent_instance.id)` + `ORDER BY … created_at DESC`
  // collapse attributes ALL of that instance's usage to the MOST-RECENT runner —
  // the earlier runners' share is silently folded into the latest. This mirrors
  // the sibling `deployment_id`-not-unique constraint documented on
  // `getUsageByWorkflowType`. The current per-run-deployment model is 1 run : 1
  // deployment, so a live deployment only ever has one runner; this only skews
  // historical analytics buckets that still hold pre-CL-2582 rows.
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
        instanceAddressMatchesDeployment(
          agentInstance.address,
          workflowRunRecord.deploymentId,
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
  // both are. Instances in neither set (e.g. shared/system agents) land in the
  // explicit Unattributed bucket (CL-2746) rather than being dropped or guessed.
  const resolvedMemberPrincipalId = sql<string>`coalesce(${ownerByInstance.memberPrincipalId}, ${workflowOwnerByInstance.memberPrincipalId}, 'unattributed')`;

  // `principalId` here is the owning member's tenant `kind: "user"` principal
  // (the column `ensureMember` writes and the route's `c.get("principal")`
  // reads), NOT the per-instance synthetic principal on raw analytics events —
  // so comparing it to `callerPrincipalId` for `isSelf` is like-for-like.
  const rows = await db
    .select({
      principalId: sql<string>`${resolvedMemberPrincipalId}`,
      name: intxSchema.user.name,
      // Grouped in ALSO by model (CL-2723) so cost can be priced per model,
      // then summed — a person using two models never gets a blended,
      // fabricated rate. This fans out to one row per (person, model); the
      // per-person totals below re-aggregate across that fan-out.
      model: analyticsRollupDaily.model,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
      cacheReadTokens: sumInt(analyticsRollupDaily.cacheReadTokens),
      cacheWriteTokens: sumInt(analyticsRollupDaily.cacheWriteTokens),
      thinkingTokens: sumInt(analyticsRollupDaily.thinkingTokens),
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
        range?.startDate !== undefined
          ? gte(analyticsRollupDaily.bucketDate, range.startDate)
          : undefined,
        range?.endDate !== undefined
          ? lte(analyticsRollupDaily.bucketDate, range.endDate)
          : undefined,
      ),
    )
    .groupBy(
      resolvedMemberPrincipalId,
      intxSchema.user.name,
      analyticsRollupDaily.model,
    );

  const byPrincipal = new Map<
    string,
    { name: string | null; modelRows: ModelUsageRow[] } & Omit<
      UsageByPersonRow,
      "principalId" | "name" | "isSelf" | "cost"
    >
  >();
  for (const row of rows) {
    const existing = byPrincipal.get(row.principalId) ?? {
      name: row.name ?? null,
      turnCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      modelRows: [],
    };
    existing.turnCount += row.turnCount;
    existing.toolCallCount += row.toolCallCount;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    existing.thinkingTokens += row.thinkingTokens;
    // A null model with real tokens is genuine usage that cannot be priced —
    // route it through `priceUsageRows` under UNKNOWN_MODEL_LABEL so it lands
    // in `unpricedModels`/`hasUnpriced`, never as a silent $0 (CL-2723).
    existing.modelRows.push({
      model: row.model ?? UNKNOWN_MODEL_LABEL,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      thinkingTokens: row.thinkingTokens,
    });
    byPrincipal.set(row.principalId, existing);
  }

  return [...byPrincipal.entries()]
    .map(([principalId, agg]) => ({
      principalId,
      name:
        principalId === UNATTRIBUTED_PERSON_PRINCIPAL_ID
          ? UNATTRIBUTED_PERSON_LABEL
          : agg.name,
      isSelf: callerPrincipalId !== null && principalId === callerPrincipalId,
      turnCount: agg.turnCount,
      toolCallCount: agg.toolCallCount,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      thinkingTokens: agg.thinkingTokens,
      cost:
        priceCatalog !== null
          ? priceUsageRows(agg.modelRows, priceCatalog)
          : null,
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
  /** models.dev rate catalog (CL-2723) — see {@link getUsageByPerson}. */
  priceCatalog?: PriceCatalog | null;
}): Promise<UsageByWorkflowTypeRow[]> {
  const { db, tenantId, range } = args;
  const priceCatalog = args.priceCatalog ?? null;

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
      // Grouped in ALSO by model (CL-2723) — see the identical rationale on
      // `getUsageByPerson`.
      model: analyticsRollupDaily.model,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
      cacheReadTokens: sumInt(analyticsRollupDaily.cacheReadTokens),
      cacheWriteTokens: sumInt(analyticsRollupDaily.cacheWriteTokens),
      thinkingTokens: sumInt(analyticsRollupDaily.thinkingTokens),
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
      instanceAddressMatchesDeployment(
        agentInstance.address,
        runByDeployment.deploymentId,
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
    .groupBy(runByDeployment.kind, analyticsRollupDaily.model);

  const byKind = new Map<
    string,
    { modelRows: ModelUsageRow[] } & Omit<
      UsageByWorkflowTypeRow,
      "kind" | "cost"
    >
  >();
  for (const row of rows) {
    const existing = byKind.get(row.kind) ?? {
      turnCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      modelRows: [],
    };
    existing.turnCount += row.turnCount;
    existing.toolCallCount += row.toolCallCount;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    existing.thinkingTokens += row.thinkingTokens;
    // Null-model usage is priced as unpriced under UNKNOWN_MODEL_LABEL rather
    // than dropped — never a silent $0 (CL-2723); see getUsageByPerson.
    existing.modelRows.push({
      model: row.model ?? UNKNOWN_MODEL_LABEL,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      thinkingTokens: row.thinkingTokens,
    });
    byKind.set(row.kind, existing);
  }

  return [...byKind.entries()]
    .map(([kind, agg]) => ({
      kind,
      turnCount: agg.turnCount,
      toolCallCount: agg.toolCallCount,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      thinkingTokens: agg.thinkingTokens,
      cost:
        priceCatalog !== null
          ? priceUsageRows(agg.modelRows, priceCatalog)
          : null,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
}

// CL-2809: per-RUN token attribution, read-side only. Workflow-run inference is
// recorded against a per-deployment agent instance whose `address` embeds the
// deploymentId (`ins_<deploymentId>…`, the same LIKE convention
// `getUsageByWorkflowType` and `getUsageByPerson`'s `workflowOwnerByInstance`
// use), and the per-run-deploy model (CL-2582) is 1 run : 1 deployment — so
// resolving instance -> deploymentId -> workflow_run_record.id recovers the
// per-run identity that raw analytics rows never carried.
//
// KNOWN CAVEAT (mirrors CL-2711 on `getUsageByPerson`): a LEGACY deployment
// (pre-CL-2582) could serve several serial runs. `DISTINCT ON (agent_instance.id)`
// + `ORDER BY workflow_run_record.created_at DESC` collapses those to the
// MOST-RECENT run — the earlier runs on that shared deployment are NOT
// separately attributable and are silently absent from the result (never
// duplicated across rows). New/live per-run deployments only ever have one
// runner, so this only skews historical buckets that still hold pre-CL-2582
// rows.
function runByInstanceJoin(db: DB["db"], tenantId: string) {
  // Both projected columns are an underlying `id` (`agent_instance.id` and
  // `workflow_run_record.id`). Left as plain columns they'd both emit the SQL
  // name `"id"`, so the outer `group by "run_by_instance"."id"` is ambiguous.
  // Keep `instanceId` a plain column (drizzle qualifies it as
  // `"run_by_instance"."id"` in the join, so it stays unambiguous against
  // `analytics_rollup_daily.instance_id`) and SQL-alias only the run id to the
  // unique name `run_id` (no other joined table has that column, so the
  // unqualified references drizzle emits for a `sql`-aliased field are safe).
  return db
    .selectDistinctOn([agentInstance.id], {
      instanceId: agentInstance.id,
      runId: sql<string>`${workflowRunRecord.id}`.as("run_id"),
    })
    .from(agentInstance)
    .innerJoin(
      workflowRunRecord,
      and(
        eq(workflowRunRecord.tenantId, tenantId),
        isNull(workflowRunRecord.deletedAt),
        isNotNull(workflowRunRecord.deploymentId),
        instanceAddressMatchesDeployment(
          agentInstance.address,
          workflowRunRecord.deploymentId,
        ),
      ),
    )
    .where(eq(agentInstance.tenantId, tenantId))
    .orderBy(agentInstance.id, desc(workflowRunRecord.createdAt))
    .as("run_by_instance");
}

export async function getUsageByWorkflowRun(args: {
  db: DB["db"];
  tenantId: string;
  range?: AnalyticsDateRange;
}): Promise<WorkflowRunTokenTotalsRow[]> {
  const { db, tenantId, range } = args;

  const runByInstance = runByInstanceJoin(db, tenantId);

  const rows = await db
    .select({
      runId: runByInstance.runId,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
      cacheReadTokens: sumInt(analyticsRollupDaily.cacheReadTokens),
      cacheWriteTokens: sumInt(analyticsRollupDaily.cacheWriteTokens),
      thinkingTokens: sumInt(analyticsRollupDaily.thinkingTokens),
    })
    .from(analyticsRollupDaily)
    .innerJoin(
      runByInstance,
      eq(runByInstance.instanceId, analyticsRollupDaily.instanceId),
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
    .groupBy(runByInstance.runId);

  return rows.map((row) => ({
    runId: row.runId,
    turnCount: row.turnCount,
    toolCallCount: row.toolCallCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    thinkingTokens: row.thinkingTokens,
  }));
}

/**
 * Single-run token totals for a run detail surface (e.g. the WorkflowTracePage
 * cost facet). Returns `null` when the run has no attributable per-run
 * instance — either it predates the per-run-deploy model, its deployment was
 * never indexed, no inference has landed for it yet, or (the legacy caveat
 * documented on `getUsageByWorkflowRun`) it was an earlier serial run on a
 * shared deployment whose usage collapsed into a later run's row instead.
 * Callers must render this as an honest gap, never as zero usage.
 */
export async function getWorkflowRunTokenTotals(args: {
  db: DB["db"];
  tenantId: string;
  runId: string;
}): Promise<WorkflowRunTokenTotalsRow | null> {
  const rows = await getUsageByWorkflowRun({
    db: args.db,
    tenantId: args.tenantId,
  });
  return rows.find((row) => row.runId === args.runId) ?? null;
}

// CL-2819: per-step token attribution via step agent addresses
// `ins_<deploymentId>-<stepId>@…`. Supervisor-only instances (`ins_<dep>@`) stay
// in the run-level total only; they never appear in this breakdown.
export async function getWorkflowRunStepTokenTotals(args: {
  db: DB["db"];
  tenantId: string;
  runId: string;
}): Promise<WorkflowRunStepTokenTotalsRow[]> {
  const { db, tenantId, runId } = args;
  const runRows = await db
    .select({ deploymentId: workflowRunRecord.deploymentId })
    .from(workflowRunRecord)
    .where(
      and(
        eq(workflowRunRecord.id, runId),
        eq(workflowRunRecord.tenantId, tenantId),
        isNull(workflowRunRecord.deletedAt),
        isNotNull(workflowRunRecord.deploymentId),
      ),
    );
  const deploymentId = runRows[0]?.deploymentId;
  if (deploymentId === undefined || deploymentId === null) return [];

  const stepAddressPrefix = `ins_${deploymentId}-`;
  const stepAddressPattern = new RegExp(
    `^${stepAddressPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^@]+)@`,
  );

  const runByInstance = runByInstanceJoin(db, tenantId);

  const rows = await db
    .select({
      address: agentInstance.address,
      turnCount: sumInt(analyticsRollupDaily.turnCount),
      toolCallCount: sumInt(analyticsRollupDaily.toolCallCount),
      inputTokens: sumInt(analyticsRollupDaily.inputTokens),
      outputTokens: sumInt(analyticsRollupDaily.outputTokens),
      cacheReadTokens: sumInt(analyticsRollupDaily.cacheReadTokens),
      cacheWriteTokens: sumInt(analyticsRollupDaily.cacheWriteTokens),
      thinkingTokens: sumInt(analyticsRollupDaily.thinkingTokens),
    })
    .from(analyticsRollupDaily)
    .innerJoin(
      runByInstance,
      eq(runByInstance.instanceId, analyticsRollupDaily.instanceId),
    )
    .innerJoin(
      agentInstance,
      eq(agentInstance.id, analyticsRollupDaily.instanceId),
    )
    .where(
      and(
        eq(analyticsRollupDaily.tenantId, tenantId),
        eq(agentInstance.tenantId, tenantId),
        eq(runByInstance.runId, runId),
        like(agentInstance.address, `${stepAddressPrefix}%`),
      ),
    )
    .groupBy(agentInstance.address);

  const byStep = new Map<string, WorkflowRunStepTokenTotalsRow>();
  for (const row of rows) {
    const match = stepAddressPattern.exec(row.address);
    const stepId = match?.[1];
    if (stepId === undefined) continue;
    const prev = byStep.get(stepId);
    if (prev === undefined) {
      byStep.set(stepId, {
        stepId,
        turnCount: row.turnCount,
        toolCallCount: row.toolCallCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        thinkingTokens: row.thinkingTokens,
      });
      continue;
    }
    byStep.set(stepId, {
      stepId,
      turnCount: prev.turnCount + row.turnCount,
      toolCallCount: prev.toolCallCount + row.toolCallCount,
      inputTokens: prev.inputTokens + row.inputTokens,
      outputTokens: prev.outputTokens + row.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + row.cacheWriteTokens,
      thinkingTokens: prev.thinkingTokens + row.thinkingTokens,
    });
  }

  return [...byStep.values()].sort((a, b) => a.stepId.localeCompare(b.stepId));
}

export async function getActivityOverview(args: {
  db: DB["db"];
  tenantId: string;
  callerPrincipalId?: string | null;
  range?: AnalyticsDateRange;
  /** Bucket granularity for `metricsSeries` (CL-2836). Defaults to `day`. */
  bucket?: MetricsBucket;
  /** models.dev rate catalog (CL-2723) — see {@link getUsageByPerson}. */
  priceCatalog?: PriceCatalog | null;
}): Promise<ActivityOverview> {
  const { db, tenantId } = args;
  const callerPrincipalId = args.callerPrincipalId ?? null;
  const range = args.range ?? {};
  const bucket = args.bucket ?? "day";
  const priceCatalog = args.priceCatalog ?? null;

  const tenantArtifacts = and(
    eq(artifact.tenantId, tenantId),
    ne(artifact.status, "rejected"),
  );

  const [
    artifactTotalRow,
    artifactInRangeRow,
    artifactByStatus,
    artifactByKind,
    artifactCreatedDates,
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
    fetchArtifactCreatedDates(db, tenantId, range),
  ]);

  const runBase = and(
    eq(workflowRunRecord.tenantId, tenantId),
    isNull(workflowRunRecord.deletedAt),
  );
  const runBreakdownBase = rangeHasDateBounds(range)
    ? and(runBase, createdInRange(workflowRunRecord.createdAt, range))
    : runBase;

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
          // CL-2755: a `provisioning` run is actively executing (its deployment
          // is cold-starting) — count it as an active execution too.
          inArray(workflowRunRecord.status, [
            "provisioning",
            "running",
            "awaiting",
          ]),
        ),
      ),
    db
      .select({ key: workflowRunRecord.status, count: count() })
      .from(workflowRunRecord)
      .where(runBreakdownBase)
      .groupBy(workflowRunRecord.status),
    db
      .select({ key: workflowRunRecord.kind, count: count() })
      .from(workflowRunRecord)
      .where(runBreakdownBase)
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
    instanceCreatedDates,
    activeInstanceDays,
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
    fetchInstanceCreatedDates(db, tenantId, range),
    fetchActiveInstanceDays(db, tenantId, range),
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
    getUsageByPerson({ db, tenantId, callerPrincipalId, range, priceCatalog }),
    getUsageByWorkflowType({ db, tenantId, range, priceCatalog }),
  ]);

  const metricsSeries = buildMetricsSeries({
    bucket,
    range,
    today,
    artifactDates: artifactCreatedDates,
    deployedDates: instanceCreatedDates,
    activeInstanceDays,
    tokenDaily: dailySeries.map((point) => ({
      date: point.date,
      tokens: sumTokenClasses(point),
    })),
  });

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
    agentActivity: resolveAgentActivity(
      byInstance,
      Number(instanceTotalRow[0]?.count ?? 0),
      range,
    ),
    conversations: conversationActivity.conversations,
    messages: conversationActivity.messages,
    dailySeries,
    metricsBucket: bucket,
    metricsSeries,
    models: modelRows.map((row) => ({
      key: row.model,
      count: row.turnCount,
    })),
    byModel: modelRows,
    pricedByModel:
      priceCatalog !== null ? priceUsageRows(modelRows, priceCatalog) : null,
    tokensRecordedFrom,
    byPerson,
    byWorkflowType,
    inference: { summary, previousSummary, byAgent, byInstance },
  };
}
