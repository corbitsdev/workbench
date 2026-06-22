import { type } from 'arktype';
import { getLogger } from '@intx/log';
import { subscribeKind } from '@intx/hub-sessions';
import type { AgentRepoStore, Principal, RepoId, RepoStore } from '@intx/hub-sessions';
import { createWorkflowRunBlobSubstrate } from '@intx/workflow-host';
import type { HubDb } from '../db';
import { createRunStore, loadRunRecord } from './run-store';

// Projection bridge (CL-2243). Workflows execute on the sidecar supervisor and
// commit their run events to a workflow-run git repo; the sidecar packs those
// commits to the hub, where they land via `AgentRepoStore.receiveWorkflowRunPack`.
// This bridge wraps that receive seam: on every workflow-run pack, it folds the
// run's event log into the `workflow_run_record` row the UI already polls. No
// event-log replay on read, no SSE — the row is materialized once per commit.
//
// The fold is UPDATE-ONLY: rows are seeded at /start with their full tenancy +
// ownership metadata, so a runId with no row (e.g. a run started outside the
// records path) is a harmless no-op. Re-projection on a later pack is idempotent
// (the full log replays to the same state), so the bridge is safe to run on
// every pack.

const log = getLogger(['workflow', 'projection-bridge']);

const HUB_PRINCIPAL: Principal = { kind: 'hub' };
const RUN_EVENT_REF = 'refs/heads/main';

// `subscribeKind` is an infinite live tail (replays the backlog from {seq:0}
// then blocks for the next event forever). A one-shot projection must stop once
// the backlog is drained: backlog events replay from local disk in sub-ms, so an
// idle gap means we've caught up. Matches the proven value the step-output route
// uses for the identical heuristic (workflow-runs.ts collectCompletedSteps) —
// kept in lockstep deliberately; if one moves, move both. A too-short window
// risks aborting mid-backlog under IO load and projecting a truncated log (e.g.
// missing a trailing RunCompleted), and re-projection only fires on a new pack.
const BACKLOG_IDLE_MS = 1000;

// All @intx/workflow on-disk event `type` values the fold reacts to. (On disk
// the state-machine `kind` is written under the field name `type`.)
const PROJECTED_EVENT_TYPES: readonly string[] = [
  'RunStarted',
  'StepStarted',
  'StepCompleted',
  'StepFailed',
  'SignalAwaited',
  'SignalReceived',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
];

// Envelope shape subscribeKind narrows each committed blob through.
const WorkflowEventBlob = type({ type: 'string', seq: 'number', '+': 'ignore' });

// Field-level narrows for the branches that read more than `type`. We assert
// only what we read so an envelope-shape drift surfaces loudly at the boundary.
const WithStepId = type({ stepId: 'string', '+': 'ignore' });
const WithOutputRef = type({ stepId: 'string', output: { ref: 'string' }, '+': 'ignore' });
const WithErrorMessage = type({ error: { message: 'string' }, '+': 'ignore' });

type RunRecordStatus = 'running' | 'awaiting' | 'completed' | 'failed';

export interface RunEventEntry {
  runId: string;
  event: { type: string } & Record<string, unknown>;
}

export interface ProjectedRun {
  status: RunRecordStatus;
  currentStepId: string | null;
  // stepId -> output ref, in completion order; resolved to values before save.
  completedRefs: Array<{ stepId: string; ref: string }>;
  error?: string;
}

// Fold an ordered run-event stream (possibly interleaving several runs on one
// repo ref) into per-run projected state. Events arrive in seq order, so per-run
// ordering is preserved and the last status-affecting event wins.
export function foldRunEvents(entries: readonly RunEventEntry[]): Map<string, ProjectedRun> {
  const runs = new Map<string, ProjectedRun>();
  const ensure = (runId: string): ProjectedRun => {
    let run = runs.get(runId);
    if (run === undefined) {
      run = { status: 'running', currentStepId: null, completedRefs: [] };
      runs.set(runId, run);
    }
    return run;
  };

  for (const { runId, event } of entries) {
    const run = ensure(runId);
    switch (event.type) {
      case 'RunStarted': {
        run.status = 'running';
        break;
      }
      case 'StepStarted': {
        const narrowed = WithStepId(event);
        if (!(narrowed instanceof type.errors)) {
          run.status = 'running';
          run.currentStepId = narrowed.stepId;
        }
        break;
      }
      case 'StepCompleted': {
        const narrowed = WithOutputRef(event);
        if (!(narrowed instanceof type.errors)) {
          run.completedRefs.push({ stepId: narrowed.stepId, ref: narrowed.output.ref });
        }
        break;
      }
      case 'StepFailed': {
        const narrowed = WithErrorMessage(event);
        run.status = 'failed';
        run.error = narrowed instanceof type.errors ? 'step failed' : narrowed.error.message;
        break;
      }
      case 'SignalAwaited': {
        const narrowed = WithStepId(event);
        run.status = 'awaiting';
        if (!(narrowed instanceof type.errors)) run.currentStepId = narrowed.stepId;
        break;
      }
      case 'SignalReceived': {
        // Gate cleared; the next StepStarted re-marks the active step.
        run.status = 'running';
        break;
      }
      case 'RunCompleted': {
        run.status = 'completed';
        run.currentStepId = null;
        break;
      }
      case 'RunFailed': {
        const narrowed = WithErrorMessage(event);
        run.status = 'failed';
        run.currentStepId = null;
        run.error = narrowed instanceof type.errors ? 'run failed' : narrowed.error.message;
        break;
      }
      case 'RunCancelled': {
        run.status = 'failed';
        run.currentStepId = null;
        run.error = 'cancelled';
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
async function drainRunEvents(repoStore: RepoStore, repoId: RepoId): Promise<RunEventEntry[]> {
  const abort = new AbortController();
  const iter = subscribeKind(repoStore, HUB_PRINCIPAL, repoId, RUN_EVENT_REF, WorkflowEventBlob, {
    signal: abort.signal,
    from: { seq: 0 },
    kinds: PROJECTED_EVENT_TYPES,
  });

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
      entries.push({ runId: entry.runId, event: entry.event as RunEventEntry['event'] });
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
  repoId: RepoId
): Promise<void> {
  const entries = await drainRunEvents(repoStore, repoId);
  if (entries.length === 0) return;
  const runs = foldRunEvents(entries);
  const store = createRunStore(db);

  for (const [runId, projected] of runs) {
    const existing = await loadRunRecord(db, runId);
    if (existing === null) continue;

    const outputs: Record<string, unknown> = { ...existing.outputs };
    const unresolved = projected.completedRefs.filter(({ stepId }) => !(stepId in outputs));
    if (unresolved.length > 0) {
      const blobs = createWorkflowRunBlobSubstrate({
        substrate: repoStore,
        repoId,
        principal: HUB_PRINCIPAL,
        runId,
        ref: RUN_EVENT_REF,
      });
      for (const { stepId, ref } of unresolved) {
        try {
          outputs[stepId] = await blobs.resolveRef(ref);
        } catch (err) {
          log.warn('workflow projection: step output resolve failed', {
            runId,
            stepId,
            ref,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }

    await store.save({
      ...existing,
      status: projected.status,
      currentStepId: projected.currentStepId,
      outputs,
      ...(projected.error !== undefined ? { error: projected.error } : {}),
    });
  }
}

// A per-key coalescing scheduler: while a key's task runs, a re-arrival marks it
// dirty and re-runs exactly once on completion. Keeps pack receipt non-blocking
// (fire-and-forget) while guaranteeing no two projections for the same repo race,
// and that the latest log state is always projected.
export function createCoalescingScheduler(run: (key: string) => Promise<void>): {
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
  deps: { db: HubDb }
): AgentRepoStore {
  const scheduler = createCoalescingScheduler(async (id: string) => {
    try {
      await projectWorkflowRunRepo(base.repoStore, deps.db, { kind: 'workflow-run', id });
    } catch (err) {
      log.error('workflow projection failed', {
        repoId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });

  return {
    writeDeployTree: (agentId, content) => base.writeDeployTree(agentId, content),
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
