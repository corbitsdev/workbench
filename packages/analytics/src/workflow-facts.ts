import { randomBytes } from "node:crypto";

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { type } from "arktype";

import type { DB } from "@intx/db";

import { workflowRunFact, workflowStepFact } from "./schema";

// CL-2670 workflow analytics FACTS — the query boundary. A terminal run's log is
// projected into these flat, rebuildable facts by the hub (which owns the log
// read); this package owns the store shape, the idempotent upsert, and the
// aggregate insights queries.

export const WorkflowFactOutcomeSchema = type(
  "'completed'|'failed'|'cancelled'",
);
export type WorkflowFactOutcome = typeof WorkflowFactOutcomeSchema.infer;

export const WorkflowStepFactKindSchema = type(
  "'human'|'agent'|'deterministic'|'inline'|'other'",
);
export type WorkflowStepFactKind = typeof WorkflowStepFactKindSchema.infer;

// Run-level fact input (ISO timestamps at the boundary; stored as timestamptz).
export const WorkflowRunFactInputSchema = type({
  runId: "string",
  tenantId: "string",
  kind: "string",
  outcome: WorkflowFactOutcomeSchema,
  "startedAt?": "string",
  "endedAt?": "string",
  "durationMs?": "number",
});
export type WorkflowRunFactInput = typeof WorkflowRunFactInputSchema.infer;

export const WorkflowStepFactInputSchema = type({
  runId: "string",
  stepId: "string",
  attempt: "number",
  tenantId: "string",
  kind: "string",
  stepKind: WorkflowStepFactKindSchema,
  outcome: WorkflowFactOutcomeSchema,
  "startedAt?": "string",
  "endedAt?": "string",
  "durationMs?": "number",
  "gateWaitMs?": "number",
});
export type WorkflowStepFactInput = typeof WorkflowStepFactInputSchema.infer;

export const WorkflowRunFactsSchema = type({
  run: WorkflowRunFactInputSchema,
  steps: WorkflowStepFactInputSchema.array(),
});
export type WorkflowRunFacts = typeof WorkflowRunFactsSchema.infer;

type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

function toDate(iso: string | undefined): Date | null {
  return iso === undefined ? null : new Date(iso);
}

function stepFactId(): string {
  return `wsf_${randomBytes(16).toString("hex")}`;
}

// Idempotent by runId: re-projecting a run REPLACES its facts. Deletes the run's
// prior facts, then re-inserts, in one transaction — so a re-project can never
// leave duplicate or stale rows even if the attempt set changed between runs.
export async function upsertWorkflowRunFacts(
  db: DB["db"],
  facts: WorkflowRunFacts,
): Promise<void> {
  await db.transaction(async (tx) => {
    await replaceRunFacts(tx, facts);
  });
}

async function replaceRunFacts(tx: Tx, facts: WorkflowRunFacts): Promise<void> {
  const { run, steps } = facts;
  await tx
    .delete(workflowStepFact)
    .where(eq(workflowStepFact.runId, run.runId));
  await tx.delete(workflowRunFact).where(eq(workflowRunFact.runId, run.runId));

  await tx.insert(workflowRunFact).values({
    runId: run.runId,
    tenantId: run.tenantId,
    kind: run.kind,
    outcome: run.outcome,
    startedAt: toDate(run.startedAt),
    endedAt: toDate(run.endedAt),
    durationMs: run.durationMs ?? null,
  });

  if (steps.length === 0) return;
  await tx.insert(workflowStepFact).values(
    steps.map((s) => ({
      id: stepFactId(),
      runId: s.runId,
      stepId: s.stepId,
      attempt: s.attempt,
      tenantId: s.tenantId,
      kind: s.kind,
      stepKind: s.stepKind,
      outcome: s.outcome,
      startedAt: toDate(s.startedAt),
      endedAt: toDate(s.endedAt),
      durationMs: s.durationMs ?? null,
      gateWaitMs: s.gateWaitMs ?? null,
    })),
  );
}

// ─── Aggregate insights queries ────────────────────────────────────────

export type WorkflowFactDateRange = {
  startDate?: string;
  endDate?: string;
};

export type WorkflowAnalyticsFilter = {
  tenantId: string;
  range?: WorkflowFactDateRange;
};

export const WorkflowKindAggregateSchema = type({
  kind: "string",
  runCount: "number",
  successCount: "number",
  successRate: "number",
  avgDurationMs: "number | null",
  medianDurationMs: "number | null",
});
export type WorkflowKindAggregate = typeof WorkflowKindAggregateSchema.infer;

export const WorkflowStepKindAggregateSchema = type({
  kind: "string",
  stepKind: WorkflowStepFactKindSchema,
  stepCount: "number",
  successCount: "number",
  successRate: "number",
  avgDurationMs: "number | null",
  medianDurationMs: "number | null",
  avgGateWaitMs: "number | null",
  medianGateWaitMs: "number | null",
});
export type WorkflowStepKindAggregate =
  typeof WorkflowStepKindAggregateSchema.infer;

export const WorkflowAnalyticsSchema = type({
  tenantId: "string",
  byKind: WorkflowKindAggregateSchema.array(),
  byStepKind: WorkflowStepKindAggregateSchema.array(),
});
export type WorkflowAnalytics = typeof WorkflowAnalyticsSchema.infer;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isNaN(n) ? null : n;
}

// Date-range analytics filter on the RUN's real time (`startedAt`), NEVER the
// `createdAt` bookkeeping column: `reprojectWorkflowFacts`/backfill re-insert
// rows with `defaultNow()`, so after any reproject every fact's `createdAt`
// collapses to the reproject time and a `createdAt`-based range query would
// return all-or-nothing for historical windows (CL-2670 review).
function rangeConditions(
  column: Parameters<typeof gte>[0],
  range: WorkflowFactDateRange | undefined,
) {
  return [
    range?.startDate !== undefined
      ? gte(column, new Date(range.startDate))
      : undefined,
    range?.endDate !== undefined
      ? lte(column, new Date(range.endDate))
      : undefined,
  ];
}

export async function getWorkflowAnalytics(
  args: { db: DB["db"] } & WorkflowAnalyticsFilter,
): Promise<WorkflowAnalytics> {
  const { db, tenantId, range } = args;

  const runRows = await db
    .select({
      kind: workflowRunFact.kind,
      runCount: sql<number>`count(*)`.mapWith(Number),
      successCount:
        sql<number>`count(*) filter (where ${workflowRunFact.outcome} = 'completed')`.mapWith(
          Number,
        ),
      avgDurationMs: sql<number | null>`avg(${workflowRunFact.durationMs})`,
      medianDurationMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${workflowRunFact.durationMs})`,
    })
    .from(workflowRunFact)
    .where(
      and(
        eq(workflowRunFact.tenantId, tenantId),
        ...rangeConditions(workflowRunFact.startedAt, range),
      ),
    )
    .groupBy(workflowRunFact.kind)
    .orderBy(workflowRunFact.kind);

  const stepRows = await db
    .select({
      kind: workflowStepFact.kind,
      stepKind: workflowStepFact.stepKind,
      stepCount: sql<number>`count(*)`.mapWith(Number),
      successCount:
        sql<number>`count(*) filter (where ${workflowStepFact.outcome} = 'completed')`.mapWith(
          Number,
        ),
      avgDurationMs: sql<number | null>`avg(${workflowStepFact.durationMs})`,
      medianDurationMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${workflowStepFact.durationMs})`,
      avgGateWaitMs: sql<number | null>`avg(${workflowStepFact.gateWaitMs})`,
      medianGateWaitMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${workflowStepFact.gateWaitMs})`,
    })
    .from(workflowStepFact)
    .where(
      and(
        eq(workflowStepFact.tenantId, tenantId),
        ...rangeConditions(workflowStepFact.startedAt, range),
      ),
    )
    .groupBy(workflowStepFact.kind, workflowStepFact.stepKind)
    .orderBy(workflowStepFact.kind, workflowStepFact.stepKind);

  return {
    tenantId,
    byKind: runRows.map((r) => ({
      kind: r.kind,
      runCount: r.runCount,
      successCount: r.successCount,
      successRate: r.runCount > 0 ? r.successCount / r.runCount : 0,
      avgDurationMs: num(r.avgDurationMs),
      medianDurationMs: num(r.medianDurationMs),
    })),
    byStepKind: stepRows.map((r) => ({
      kind: r.kind,
      stepKind: r.stepKind,
      stepCount: r.stepCount,
      successCount: r.successCount,
      successRate: r.stepCount > 0 ? r.successCount / r.stepCount : 0,
      avgDurationMs: num(r.avgDurationMs),
      medianDurationMs: num(r.medianDurationMs),
      avgGateWaitMs: num(r.avgGateWaitMs),
      medianGateWaitMs: num(r.medianGateWaitMs),
    })),
  };
}

export const WorkflowRunBreakdownStepSchema = type({
  stepId: "string",
  attempt: "number",
  stepKind: WorkflowStepFactKindSchema,
  outcome: WorkflowFactOutcomeSchema,
  durationMs: "number | null",
  gateWaitMs: "number | null",
});
export type WorkflowRunBreakdownStep =
  typeof WorkflowRunBreakdownStepSchema.infer;

export const WorkflowRunBreakdownSchema = type({
  runId: "string",
  kind: "string",
  outcome: WorkflowFactOutcomeSchema,
  durationMs: "number | null",
  steps: WorkflowRunBreakdownStepSchema.array(),
});
export type WorkflowRunBreakdown = typeof WorkflowRunBreakdownSchema.infer;

// Per-run solo breakdown: the run fact + its step facts. Tenant-scoped so a
// caller can only read a run in its own tenant. Null when the run has no facts.
export async function getWorkflowRunBreakdown(args: {
  db: DB["db"];
  tenantId: string;
  runId: string;
}): Promise<WorkflowRunBreakdown | null> {
  const { db, tenantId, runId } = args;
  const runRows = await db
    .select({
      runId: workflowRunFact.runId,
      kind: workflowRunFact.kind,
      outcome: workflowRunFact.outcome,
      durationMs: workflowRunFact.durationMs,
    })
    .from(workflowRunFact)
    .where(
      and(
        eq(workflowRunFact.runId, runId),
        eq(workflowRunFact.tenantId, tenantId),
      ),
    );
  const run = runRows[0];
  if (run === undefined) return null;

  const stepRows = await db
    .select({
      stepId: workflowStepFact.stepId,
      attempt: workflowStepFact.attempt,
      stepKind: workflowStepFact.stepKind,
      outcome: workflowStepFact.outcome,
      durationMs: workflowStepFact.durationMs,
      gateWaitMs: workflowStepFact.gateWaitMs,
    })
    .from(workflowStepFact)
    .where(eq(workflowStepFact.runId, runId))
    .orderBy(workflowStepFact.startedAt, workflowStepFact.stepId);

  return {
    runId: run.runId,
    kind: run.kind,
    outcome: run.outcome,
    durationMs: num(run.durationMs),
    steps: stepRows.map((s) => ({
      stepId: s.stepId,
      attempt: s.attempt,
      stepKind: s.stepKind,
      outcome: s.outcome,
      durationMs: num(s.durationMs),
      gateWaitMs: num(s.gateWaitMs),
    })),
  };
}
