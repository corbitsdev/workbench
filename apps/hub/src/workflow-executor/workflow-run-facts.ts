import { and, eq, inArray } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { AgentRepoStore, RepoId } from "@intx/hub-sessions";
import {
  upsertWorkflowRunFacts,
  type WorkflowFactOutcome,
  type WorkflowRunFactInput,
  type WorkflowRunFacts,
  type WorkflowStepFactInput,
  type WorkflowStepFactKind,
} from "@workbench/analytics";

import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";
import {
  getWorkflowRunStateForRepo,
  type LogRunState,
  type LogStepState,
  type StepKind,
} from "./run-state-from-log";
import { deriveWorkflowRunRepoId } from "../routes/workflow-runs";
import { isTerminalRunStatus } from "./run-status";

// CL-2670 workflow analytics FACT projector. Given a TERMINAL run's log-derived
// RunState, derive the flat run + step facts (duration / step-type / outcome /
// gate-wait) and upsert them as a pure derived cache. Only terminal runs are
// projected — an in-flight run's durations aren't stable facts.

const log = getLogger(["workflow", "analytics-facts"]);

const STEP_KIND_MAP: Record<StepKind, WorkflowStepFactKind> = {
  human: "human",
  agent: "agent",
  deterministic: "deterministic",
  inline: "inline",
  other: "other",
  unknown: "other",
};

// Map a folded phase to a fact outcome. A run/step that reached `cancelled` keeps
// that distinction (the thin run index folds it into `failed`; the facts do not).
// Anything not `completed`/`cancelled` is recorded as `failed`.
function phaseOutcome(
  phase: LogRunState["phase"] | LogStepState["phase"],
): WorkflowFactOutcome {
  if (phase === "completed") return "completed";
  if (phase === "cancelled") return "cancelled";
  return "failed";
}

function durationMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const d = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isNaN(d) ? undefined : d;
}

// Which step phases are terminal (a stable fact). A step still in-flight or
// parked at a gate when the run ended has no stable duration — skip it.
const TERMINAL_STEP_PHASES: ReadonlySet<LogStepState["phase"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// Pure: derive the run + step facts from a run's log-derived RunState.
export function deriveRunFacts(
  state: LogRunState,
  args: { tenantId: string; kind: string },
): WorkflowRunFacts {
  const run: WorkflowRunFactInput = {
    runId: state.runId,
    tenantId: args.tenantId,
    kind: args.kind,
    outcome: phaseOutcome(state.phase),
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
  };
  const runDuration = durationMs(state.startedAt, state.endedAt);
  if (runDuration !== undefined) run.durationMs = runDuration;

  const steps: WorkflowStepFactInput[] = [];
  for (const step of state.steps) {
    if (!TERMINAL_STEP_PHASES.has(step.phase)) continue;
    const fact: WorkflowStepFactInput = {
      runId: state.runId,
      stepId: step.stepId,
      attempt: step.currentAttempt,
      tenantId: args.tenantId,
      kind: args.kind,
      stepKind: STEP_KIND_MAP[step.stepType],
      outcome: phaseOutcome(step.phase),
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
      ...(step.gateWaitMs !== undefined ? { gateWaitMs: step.gateWaitMs } : {}),
    };
    const stepDuration = durationMs(step.startedAt, step.endedAt);
    if (stepDuration !== undefined) fact.durationMs = stepDuration;
    steps.push(fact);
  }
  return { run, steps };
}

// Read a run's log through the shared native fold (getWorkflowRunStateForRepo),
// derive its facts, and upsert them. Idempotent by runId (the upsert replaces the
// run's facts), so re-projecting a run never dupes.
export async function projectWorkflowRunFacts(
  deps: { db: HubDb; repoStore: AgentRepoStore },
  args: { repoId: RepoId; runId: string; kind: string; tenantId: string },
): Promise<void> {
  const state = await getWorkflowRunStateForRepo(
    { repoStore: deps.repoStore },
    { repoId: args.repoId, runId: args.runId, kind: args.kind },
  );
  const facts = deriveRunFacts(state, {
    tenantId: args.tenantId,
    kind: args.kind,
  });
  await upsertWorkflowRunFacts(deps.db, facts);
}

// Reproject command: rebuild the facts for every TERMINAL run of a tenant (or all
// tenants) by re-deriving from each run's log — proving the fact store is a pure
// derived cache. Iterates the thin run index for the run coordinates, derives the
// workflow-run RepoId the same way the read path does, and re-projects.
export async function reprojectWorkflowFacts(
  deps: { db: HubDb; repoStore: AgentRepoStore; deploymentDomain: string },
  args: { tenantId?: string } = {},
): Promise<{ projected: number; skipped: number }> {
  const rows = await deps.db
    .select({
      runId: workflowRunRecord.id,
      kind: workflowRunRecord.kind,
      tenantId: workflowRunRecord.tenantId,
      deploymentId: workflowRunRecord.deploymentId,
      status: workflowRunRecord.status,
    })
    .from(workflowRunRecord)
    .where(
      args.tenantId !== undefined
        ? and(
            eq(workflowRunRecord.tenantId, args.tenantId),
            inArray(workflowRunRecord.status, ["completed", "failed"]),
          )
        : inArray(workflowRunRecord.status, ["completed", "failed"]),
    );

  let projected = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isTerminalRunStatus(row.status)) {
      skipped += 1;
      continue;
    }
    if (row.deploymentId === null) {
      skipped += 1;
      continue;
    }
    const repoId: RepoId = {
      kind: "workflow-run",
      id: deriveWorkflowRunRepoId({
        deploymentId: row.deploymentId,
        deploymentDomain: deps.deploymentDomain,
      }),
    };
    try {
      await projectWorkflowRunFacts(deps, {
        repoId,
        runId: row.runId,
        kind: row.kind,
        tenantId: row.tenantId,
      });
      projected += 1;
    } catch (err) {
      skipped += 1;
      log.warn("reproject: failed to project run facts", {
        runId: row.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { projected, skipped };
}
