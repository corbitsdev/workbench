import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { subscribeKind } from "@intx/hub-sessions";
import type {
  AgentRepoStore,
  Principal,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { applyRunProjection, loadRunRecord } from "./run-store";
import { becameTerminal } from "./run-status";
import { WorkflowMeta } from "../lib/workflow-meta";

// Projection bridge (CL-2243 / CL-2669). Workflows execute on the sidecar
// supervisor and commit their run events to a workflow-run git repo; the sidecar
// packs those commits to the hub, where they land via
// `AgentRepoStore.receiveWorkflowRunPack`. This bridge wraps that receive seam:
// on every workflow-run pack, it folds the run's event log into the RUN-LEVEL
// index columns of the `workflow_run_record` row (coarse `status` + run
// wall-clock timing). Per-step state (phase / outputs / errors) is NOT mirrored
// here — it is read on demand from the log (`run-state-from-log.ts`).
//
// The fold is UPDATE-ONLY: rows are seeded at /start with their full tenancy +
// ownership metadata, so a runId with no row (e.g. a run started outside the
// records path) is a harmless no-op. Re-projection on a later pack is idempotent
// (the full log replays to the same run-level state), so the bridge is safe to
// run on every pack.

const log = getLogger(["workflow", "projection-bridge"]);

const HUB_PRINCIPAL: Principal = { kind: "hub" };
const RUN_EVENT_REF = "refs/heads/main";

// `subscribeKind` is an infinite live tail (replays the backlog from {seq:0}
// then blocks for the next event forever). A one-shot projection must stop once
// the backlog is drained: backlog events replay from local disk in sub-ms, so an
// idle gap means we've caught up. Matches the proven value the step-output route
// uses for the identical heuristic (workflow-runs.ts collectCompletedSteps) —
// kept in lockstep deliberately; if one moves, move both. A too-short window
// risks aborting mid-backlog under IO load and projecting a truncated log (e.g.
// missing a trailing RunCompleted), and re-projection only fires on a new pack.
// 200ms is well above the sub-ms disk replay while removing ~800ms of dead wait
// per step versus the original 1s (CL-2244).
const BACKLOG_IDLE_MS = 200;

// All @intx/workflow on-disk event `type` values the fold reacts to. (On disk
// the state-machine `kind` is written under the field name `type`.)
const PROJECTED_EVENT_TYPES: readonly string[] = [
  "RunStarted",
  "StepStarted",
  "StepFailed",
  "SignalAwaited",
  "SignalReceived",
  "RunCompleted",
  "RunFailed",
  "RunCancelled",
];

// Envelope shape subscribeKind narrows each committed blob through.
const WorkflowEventBlob = type({
  type: "string",
  seq: "number",
  "+": "ignore",
});

// Field-level narrows for the branches that read more than `type`. We assert
// only what we read so an envelope-shape drift surfaces loudly at the boundary.
const WithStepId = type({ stepId: "string", "+": "ignore" });
const WithErrorMessage = type({ error: { message: "string" }, "+": "ignore" });
const WithStepFailure = type({
  stepId: "string",
  error: { message: "string" },
  "+": "ignore",
});

// Compose a human-legible run-failure detail. The native runtime emits a generic
// "one or more steps failed" on RunFailed; on its own that is undebuggable (which
// step? why?). We capture each StepFailed's (stepId, message) and, when the run
// fails, surface them — so the error names the failing step(s) and their reason
// instead of the opaque aggregate.
function describeFailure(
  runMessage: string | undefined,
  failedSteps: readonly { stepId: string; message: string }[],
): string {
  if (failedSteps.length > 0) {
    const steps = failedSteps
      .map((s) => `step "${s.stepId}" failed: ${s.message}`)
      .join("; ");
    return runMessage !== undefined && runMessage !== "one or more steps failed"
      ? `${runMessage} (${steps})`
      : steps;
  }
  return runMessage ?? "workflow run failed";
}

type RunRecordStatus = "running" | "awaiting" | "completed" | "failed";

export function isNewWorkflowRunFailure(
  previousStatus: RunRecordStatus,
  nextStatus: RunRecordStatus,
): boolean {
  return previousStatus !== "failed" && nextStatus === "failed";
}

export interface RunFailureContext {
  runId: string;
  kind: string;
  deploymentId: string | null;
  version?: string;
  sha?: string;
}

export interface RunFailureReport {
  message: string;
  // The Error forwarded under the `error` property the Sentry sink captures via
  // captureException — so the event carries a stack (synthesized here at the
  // hub when the on-disk StepFailed event has only a message; the originating
  // per-step throw's full stack is captured separately in the workflow-child,
  // which CL-2503 wired to Sentry). Named after the failing step(s) so the
  // event title is the specific failure, not the opaque aggregate.
  error: Error;
  properties: Record<string, unknown>;
}

// Build the structured failure report forwarded to the error log / Sentry on a
// run's first transition to `failed`. Pure + exported so it is unit-testable:
// the report names the failing step(s), carries an Error with a stack, and
// attaches the per-step failure breakdown as a property.
export function buildRunFailureReport(
  projected: ProjectedRun,
  context: RunFailureContext,
): RunFailureReport {
  const detail = projected.error ?? "workflow run failed";
  const error = new Error(detail);
  error.name = "WorkflowRunFailedError";
  return {
    message: "workflow run failed",
    error,
    properties: {
      runId: context.runId,
      kind: context.kind,
      ...(context.deploymentId !== null
        ? { deploymentId: context.deploymentId }
        : {}),
      ...(context.version !== undefined ? { version: context.version } : {}),
      ...(context.sha !== undefined ? { sha: context.sha } : {}),
      ...(projected.failedSteps.length > 0
        ? { failedSteps: projected.failedSteps }
        : {}),
    },
  };
}

export function logNewWorkflowRunFailureIfNeeded(
  previousStatus: RunRecordStatus,
  projected: ProjectedRun,
  context: RunFailureContext,
): void {
  if (!isNewWorkflowRunFailure(previousStatus, projected.status)) return;
  const report = buildRunFailureReport(projected, context);
  log.error(report.message, { ...report.properties, error: report.error });
}

// Fired once when a run's record transitions non-terminal → terminal, so the
// caller can tear down the run's single-use deployment (per-run deployment,
// CL-2582). NEVER fired for an `awaiting` run — `becameTerminal` excludes it
// (the CL-2575 invariant). Best-effort: the implementation owns its own error
// handling and must not block pack receipt.
export type ReclaimRunDeploymentFn = (args: {
  deploymentId: string;
  tenantId: string;
  runId: string;
}) => void;

export interface RunEventEntry {
  runId: string;
  event: { type: string } & Record<string, unknown>;
}

export interface ProjectedRun {
  status: RunRecordStatus;
  // Run wall-clock timing folded from the log (CL-2669): first RunStarted `at`
  // and the terminal event `at`. Absent until the log reports them.
  startedAt?: string;
  endedAt?: string;
  error?: string;
  // Per-step failures captured from StepFailed events, used to enrich the
  // generic RunFailed message with which step(s) failed and why (logged only —
  // the reason is not persisted; the log is the source of truth).
  failedSteps: { stepId: string; message: string }[];
}

// Read an event's ISO `at` timestamp, if present.
const WithAt = type({ at: "string", "+": "ignore" });
function eventAt(event: RunEventEntry["event"]): string | undefined {
  const narrowed = WithAt(event);
  return narrowed instanceof type.errors ? undefined : narrowed.at;
}

// Fold an ordered run-event stream (possibly interleaving several runs on one
// repo ref) into per-run RUN-LEVEL projected state: coarse status, run timing,
// and (for failure logging) the failing steps. Events arrive in seq order, so
// per-run ordering is preserved and the last status-affecting event wins.
export function foldRunEvents(
  entries: readonly RunEventEntry[],
): Map<string, ProjectedRun> {
  const runs = new Map<string, ProjectedRun>();
  // Last step to start per run — used only to attribute a StepFailed that
  // carries no stepId. Not part of the projected (persisted) state.
  const lastStepId = new Map<string, string>();
  const ensure = (runId: string): ProjectedRun => {
    let run = runs.get(runId);
    if (run === undefined) {
      run = { status: "running", failedSteps: [] };
      runs.set(runId, run);
    }
    return run;
  };

  for (const { runId, event } of entries) {
    const run = ensure(runId);
    switch (event.type) {
      case "RunStarted": {
        run.status = "running";
        const at = eventAt(event);
        if (run.startedAt === undefined && at !== undefined) run.startedAt = at;
        break;
      }
      case "StepStarted": {
        const narrowed = WithStepId(event);
        if (!(narrowed instanceof type.errors)) {
          run.status = "running";
          lastStepId.set(runId, narrowed.stepId);
        }
        break;
      }
      case "StepFailed": {
        const narrowed = WithStepFailure(event);
        run.status = "failed";
        if (narrowed instanceof type.errors) {
          const msgOnly = WithErrorMessage(event);
          const message =
            msgOnly instanceof type.errors
              ? "step failed"
              : msgOnly.error.message;
          run.error = message;
          run.failedSteps.push({
            stepId: lastStepId.get(runId) ?? "?",
            message,
          });
        } else {
          run.error = `step "${narrowed.stepId}" failed: ${narrowed.error.message}`;
          run.failedSteps.push({
            stepId: narrowed.stepId,
            message: narrowed.error.message,
          });
        }
        break;
      }
      case "SignalAwaited": {
        run.status = "awaiting";
        break;
      }
      case "SignalReceived": {
        // Gate cleared; the next StepStarted re-marks the run running.
        run.status = "running";
        break;
      }
      case "RunCompleted": {
        run.status = "completed";
        const at = eventAt(event);
        if (at !== undefined) run.endedAt = at;
        break;
      }
      case "RunFailed": {
        const narrowed = WithErrorMessage(event);
        run.status = "failed";
        const at = eventAt(event);
        if (at !== undefined) run.endedAt = at;
        const runMessage =
          narrowed instanceof type.errors ? undefined : narrowed.error.message;
        run.error = describeFailure(runMessage, run.failedSteps);
        break;
      }
      case "RunCancelled": {
        run.status = "failed";
        const at = eventAt(event);
        if (at !== undefined) run.endedAt = at;
        run.error = "cancelled";
        break;
      }
      default:
        break;
    }
  }
  return runs;
}

// Drain a workflow-run repo's event log once (bounded by the idle guard) into a
// flat ordered entry list for the fold.
async function drainRunEvents(
  repoStore: RepoStore,
  repoId: RepoId,
): Promise<RunEventEntry[]> {
  const abort = new AbortController();
  const iter = subscribeKind(
    repoStore,
    HUB_PRINCIPAL,
    repoId,
    RUN_EVENT_REF,
    WorkflowEventBlob,
    {
      signal: abort.signal,
      from: { seq: 0 },
      kinds: PROJECTED_EVENT_TYPES,
    },
  );

  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => abort.abort(), BACKLOG_IDLE_MS);
  };

  const entries: RunEventEntry[] = [];
  try {
    armIdle();
    for await (const entry of iter) {
      armIdle();
      entries.push({
        runId: entry.runId,
        event: entry.event as RunEventEntry["event"],
      });
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    abort.abort();
  }
  return entries;
}

// Project one workflow-run repo into the run records it owns.
//
// NOT UNIT-TESTED — substrate seam. This drives @intx `subscribeKind` (an
// infinite live tail) and `createWorkflowRunBlobSubstrate` against a real
// on-disk workflow-run repo; faking those at the @intx boundary would mock the
// very thing under test and leaks across bun's shared test process. The
// projection LOGIC lives in the pure, tested `foldRunEvents`; this function is
// the thin glue that feeds it and writes the row, exercised end-to-end by a real
// sidecar run. Keep it small enough to read at a glance.
//
// UPDATE-ONLY: a runId with no seeded row is skipped (rows are seeded at /start).
// Resolves only refs not already materialized — a completed step's output is
// immutable and the fold replays the full log on every pack, so this avoids
// O(steps²) blob reads against a churn-prone git substrate over a run's life.
export async function projectWorkflowRunRepo(
  repoStore: RepoStore,
  db: HubDb,
  repoId: RepoId,
  onTerminalRun?: ReclaimRunDeploymentFn,
): Promise<void> {
  const entries = await drainRunEvents(repoStore, repoId);
  if (entries.length === 0) return;
  const runs = foldRunEvents(entries);

  for (const [runId, projected] of runs) {
    const existing = await loadRunRecord(db, runId);
    if (existing === null) continue;

    await applyRunProjection(db, runId, {
      status: projected.status,
      ...(projected.startedAt !== undefined
        ? { startedAt: projected.startedAt }
        : {}),
      ...(projected.endedAt !== undefined
        ? { endedAt: projected.endedAt }
        : {}),
    });

    // Tear down the run's single-use deployment the moment it reaches a terminal
    // status (per-run deployment, CL-2582). Gated on the first non-terminal →
    // terminal transition so it fires exactly once, and never for `awaiting`
    // (CL-2575). Best-effort: the callback owns its errors and must not block the
    // projection.
    if (
      onTerminalRun !== undefined &&
      becameTerminal(existing.status, projected.status) &&
      existing.deploymentId
    ) {
      onTerminalRun({
        deploymentId: existing.deploymentId,
        tenantId: existing.tenantId,
        runId,
      });
    }

    const deployMeta: { version?: string; sha?: string } = {};
    if (
      isNewWorkflowRunFailure(existing.status, projected.status) &&
      existing.deploymentId
    ) {
      const deployment = await db.query.workflowRun.findFirst({
        where: eq(workflowRun.deploymentId, existing.deploymentId),
        columns: { meta: true },
      });
      // Parsed at the DB read boundary so a malformed/absent meta degrades to
      // "no version in log", never throws inside the projection.
      const parsed = WorkflowMeta(deployment?.meta);
      if (!(parsed instanceof type.errors)) {
        deployMeta.version = parsed.version;
        deployMeta.sha = parsed.sha;
      }
    }

    logNewWorkflowRunFailureIfNeeded(existing.status, projected, {
      runId,
      kind: existing.kind,
      deploymentId: existing.deploymentId ?? null,
      ...deployMeta,
    });
  }
}

// A per-key coalescing scheduler: while a key's task runs, a re-arrival marks it
// dirty and re-runs exactly once on completion. Keeps pack receipt non-blocking
// (fire-and-forget) while guaranteeing no two projections for the same repo race,
// and that the latest log state is always projected.
export function createCoalescingScheduler(
  run: (key: string) => Promise<void>,
): {
  schedule(key: string): void;
  idle(): Promise<void>;
} {
  const inFlight = new Set<string>();
  const dirty = new Set<string>();
  const settled = new Set<Promise<void>>();

  function schedule(key: string): void {
    if (inFlight.has(key)) {
      dirty.add(key);
      return;
    }
    inFlight.add(key);
    // run() owns its own error handling/logging; the scheduler swallows the
    // rejection (`.catch`) so a failed task never becomes an unhandled rejection,
    // never rejects idle(), and never wedges the key — the finally always re-arms.
    const task = run(key)
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(key);
        settled.delete(task);
        if (dirty.delete(key)) schedule(key);
      });
    settled.add(task);
  }

  // Resolve once no task is running or queued — for tests and graceful drain.
  async function idle(): Promise<void> {
    while (settled.size > 0) {
      await Promise.all(settled);
    }
  }

  return { schedule, idle };
}

// Wrap an AgentRepoStore so each received workflow-run pack triggers a
// projection of that repo into its run records. All other methods delegate
// unchanged. Projection failures are logged, never thrown back into pack
// receipt (the event log remains the source of truth and re-projects on the
// next pack).
export function wrapRepoStoreWithProjection(
  base: AgentRepoStore,
  deps: { db: HubDb; reclaimDeployment?: ReclaimRunDeploymentFn },
): AgentRepoStore {
  const scheduler = createCoalescingScheduler(async (id: string) => {
    try {
      await projectWorkflowRunRepo(
        base.repoStore,
        deps.db,
        { kind: "workflow-run", id },
        deps.reclaimDeployment,
      );
    } catch (err) {
      log.error("workflow projection failed", {
        repoId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });

  return {
    writeDeployTree: (agentId, content) =>
      base.writeDeployTree(agentId, content),
    createDeployPack: (agentId) => base.createDeployPack(agentId),
    receiveAgentStatePack: (repoId, pack, ref, commitSha) =>
      base.receiveAgentStatePack(repoId, pack, ref, commitSha),
    async receiveWorkflowRunPack(repoId, pack, ref, commitSha) {
      await base.receiveWorkflowRunPack(repoId, pack, ref, commitSha);
      scheduler.schedule(repoId.id);
    },
    getDeployRef: (agentId) => base.getDeployRef(agentId),
    getSigningPublicKey: () => base.getSigningPublicKey(),
    get repoStore() {
      return base.repoStore;
    },
  };
}
