import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { AgentRepoStore, RepoId } from "@intx/hub-sessions";
import {
  upsertWorkflowRunFacts,
  workflowRunFact,
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
import { isTerminalRunStatus, type RunStatus } from "./run-status";

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
  // Drop a NaN (unparseable timestamp) or negative (clock skew) duration rather
  // than persisting it into the bigint column and skewing aggregates (CL-2670
  // review). Mirrors the gateWaitMs guard in run-state-from-log.ts.
  return Number.isNaN(d) || d < 0 ? undefined : d;
}

// Which step phases are terminal (a stable fact). A step still in-flight or
// parked at a gate when the run ended has no stable duration — skip it.
const TERMINAL_STEP_PHASES: ReadonlySet<LogStepState["phase"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// Pure: derive the run + step facts from a run's log-derived RunState.
//
// Step-duration semantics (CL-2670): a step fact's `durationMs` is the total
// wall-clock time from the FIRST `StepStarted` to the step's terminal event, so
// it includes any retry backoff between attempts. `attempt` is the FINAL attempt
// count — retries never re-emit `StepStarted`, so the fold yields exactly one
// fact per (runId, stepId). `gateWaitMs` (awaitSignal gates only) is the wait
// from `SignalAwaited` to the correlated `SignalReceived`.
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

interface RunCoordinateRow {
  runId: string;
  kind: string;
  tenantId: string;
  deploymentId: string | null;
  status: RunStatus;
}

// Project a set of already-selected terminal run rows from their logs. Shared by
// the full reproject and the boot backfill. Best-effort per run: a run whose log
// is unreadable is skipped and logged, never fails the whole pass.
async function projectRunRows(
  deps: { db: HubDb; repoStore: AgentRepoStore; deploymentDomain: string },
  rows: RunCoordinateRow[],
  label: string,
): Promise<{ projected: number; skipped: number }> {
  let projected = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isTerminalRunStatus(row.status) || row.deploymentId === null) {
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
      const payload = {
        runId: row.runId,
        error: err instanceof Error ? err.message : String(err),
      };
      if (label === "backfill") {
        log.error(`${label}: failed to project run facts`, payload);
      } else {
        log.warn(`${label}: failed to project run facts`, payload);
      }
    }
  }
  return { projected, skipped };
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

  return projectRunRows(deps, rows, "reproject");
}

// Boot backfill: project any TERMINAL run in the thin index that is MISSING a run
// fact (CL-2670 review). The live projector only fires on a non-terminal →
// terminal pack transition, so a throw there — or a run that reached terminal
// while the projector was absent — permanently loses that run's facts. This
// idempotent sweep recovers them: it selects only terminal runs whose runId is
// absent from `workflow_run_fact` (already-projected runs are skipped; the upsert
// is replace-by-runId, so a stray double-project is harmless anyway). Run on hub
// boot near the reconciler bootstrap.
export async function backfillMissingWorkflowFacts(
  deps: { db: HubDb; repoStore: AgentRepoStore; deploymentDomain: string },
  args: { tenantId?: string } = {},
): Promise<{ projected: number; skipped: number }> {
  const existing = await deps.db
    .select({ runId: workflowRunFact.runId })
    .from(workflowRunFact);
  const haveFactRunIds = existing.map((r) => r.runId);

  const conditions = [
    inArray(workflowRunRecord.status, ["completed", "failed"]),
    ...(args.tenantId !== undefined
      ? [eq(workflowRunRecord.tenantId, args.tenantId)]
      : []),
    ...(haveFactRunIds.length > 0
      ? [notInArray(workflowRunRecord.id, haveFactRunIds)]
      : []),
  ];

  const rows = await deps.db
    .select({
      runId: workflowRunRecord.id,
      kind: workflowRunRecord.kind,
      tenantId: workflowRunRecord.tenantId,
      deploymentId: workflowRunRecord.deploymentId,
      status: workflowRunRecord.status,
    })
    .from(workflowRunRecord)
    .where(and(...conditions));

  return projectRunRows(deps, rows, "backfill");
}
