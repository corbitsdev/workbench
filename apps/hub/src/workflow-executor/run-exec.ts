import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import type {
  RepoStore,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "../routes/workflow-runs";
import { getAwaitingSignalNames } from "./run-awaiting-signals";
import { validateResumePayload } from "./resume-payload-registry";
import {
  insertRunRecord,
  loadRunRecord,
  setRunStatus,
  type RunState,
} from "./run-store";

const log = getLogger(["workflow-exec", "run-exec"]);

// The start/resume business logic shared by the HTTP routes
// (routes/workflow-run-records.ts) and the Myra hub tools
// (tools/workflow-run-tools.ts) — one implementation, two entrypoints
// (CL-2678). Errors come back as { ok: false, status, error } so each
// entrypoint maps them to its own surface (HTTP status vs tool error).

export type RunExecFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 500 | 503;
  error: string;
  // Set on the deploy-window 503 (CL-2707): a machine-readable code and the
  // Retry-After hint the FE uses to auto-retry rather than flash a raw error.
  code?: "deploy_in_progress";
  retryAfterSeconds?: number;
};
export type RunExecResult = { ok: true; state: RunState } | RunExecFailure;

// CL-2707: on every deploy the hub boots ~70s before the sidecar reconnects.
// A user-initiated start/resume that lands in that window otherwise fails
// instantly and rawly (session launch 503 "No sidecar available", resume 500
// "workflow resume signal failed"). When an `isSidecarConnected` probe is
// injected, the sidecar-dependent step first WAITS (bounded) for a connection
// — the same getConnectedSidecars() surface CL-2699 uses for boot autopublish.
// Omitted (e.g. Myra chat tools) → proceed immediately (unchanged behavior).
export type SidecarReadinessDeps = {
  isSidecarConnected?: () => boolean;
  sidecarWaitTimeoutMs?: number;
  sidecarPollIntervalMs?: number;
};

// Bounded server-side hold: kept well under a typical proxy read timeout so the
// request returns cleanly instead of being killed mid-wait. The FE auto-retry
// (CL-2707) covers the rest of the ~70s reconnect window across attempts.
const SIDECAR_WAIT_TIMEOUT_MS = 20_000;
const SIDECAR_POLL_INTERVAL_MS = 2_000;
// Retry-After hint returned with the deploy-window 503. Larger than one poll
// interval so a client retry lands after the sidecar has had a real chance to
// reconnect, not while this same request is still holding.
const DEPLOY_IN_PROGRESS_RETRY_SECONDS = 10;

// Bounded wait for a sidecar connection. Returns immediately (no delay, one
// probe) when a sidecar is already connected — the common case adds no latency.
// On timeout returns false so the caller can emit an honest 503 instead of a
// deep raw failure. A missing probe means "don't gate" (returns true).
async function waitForSidecarReady(
  deps: SidecarReadinessDeps,
): Promise<boolean> {
  const probe = deps.isSidecarConnected;
  if (probe === undefined || probe()) return true;

  const timeoutMs = deps.sidecarWaitTimeoutMs ?? SIDECAR_WAIT_TIMEOUT_MS;
  const intervalMs = deps.sidecarPollIntervalMs ?? SIDECAR_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  log.info("waiting for a sidecar connection before workflow action", {
    timeoutMs,
  });
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (probe()) {
      log.info("sidecar connected; proceeding with workflow action");
      return true;
    }
  }
  return probe();
}

function deployInProgressFailure(): RunExecFailure {
  return {
    ok: false,
    status: 503,
    code: "deploy_in_progress",
    retryAfterSeconds: DEPLOY_IN_PROGRESS_RETRY_SECONDS,
    error:
      "The workbench is finishing an update — this run will resume automatically. Try again in a moment.",
  };
}

function mintRunId(): string {
  return `wfr_${randomBytes(16).toString("hex")}`;
}

// Resolve the most-specific deployment of `kind` visible along the user's
// tenant chain (active workbench shadows inherited globals; ties break on
// recency). Mirrors the native start route's shadowing rule.
export async function resolveDeployment(
  db: HubDb,
  chain: readonly string[],
  kind: string,
): Promise<{
  deploymentId: string;
  tenantId: string;
  principalId: string;
} | null> {
  const candidates = await db.query.workflowRun.findMany({
    where: and(
      eq(workflowRun.kind, kind),
      inArray(workflowRun.tenantId, [...chain]),
      isNotNull(workflowRun.deploymentId),
      isNull(workflowRun.deletedAt),
    ),
    orderBy: desc(workflowRun.createdAt),
  });
  const rank = new Map(chain.map((t, i) => [t, i]));
  let best: (typeof candidates)[number] | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const r = rank.get(candidate.tenantId) ?? Number.POSITIVE_INFINITY;
    if (r < bestRank) {
      bestRank = r;
      best = candidate;
    }
  }
  if (!best?.deploymentId) return null;
  return {
    deploymentId: best.deploymentId,
    tenantId: best.tenantId,
    principalId: best.principalId,
  };
}

// Ownership/tenancy gate for reading or resuming a specific run. The record's
// tenant must be visible along the caller's tenant chain, AND the caller must
// own the run (the run's principal is the caller's principal in that tenant).
// Returns a gate result to deny, or null to allow. A cross-user request is
// denied 403; a record in a tenant outside the caller's chain is 404 (it does
// not exist for them).
export function assertRunOwnership(
  chain: readonly string[],
  context: { principalId: string },
  state: { tenantId: string; principalId: string },
): { status: 403 | 404; error: string } | null {
  if (!chain.includes(state.tenantId)) {
    return { status: 404, error: "run not found" };
  }
  if (state.principalId !== context.principalId) {
    return { status: 403, error: "Forbidden" };
  }
  return null;
}

export type StartWorkflowRunDeps = {
  db: HubDb;
  sessionService: SessionService;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  provisionRunDeployment: ProvisionRunDeploymentFn;
} & SidecarReadinessDeps;

/**
 * Start a run of `kind` owned by `principalId`: resolve the kind's registry
 * deployment along the tenant chain, provision a fresh per-run deployment
 * (CL-2582), seed the run record, and fire the trigger mail whose messageId is
 * the minted runId (the supervisor derives the run id from it).
 */
export async function startWorkflowRun(
  deps: StartWorkflowRunDeps,
  opts: {
    kind: string;
    chain: readonly string[];
    principalId: string;
    input: unknown;
    originConversationId: string | null;
  },
): Promise<RunExecResult> {
  const definition = await resolveDeployment(deps.db, opts.chain, opts.kind);
  if (!definition) {
    return {
      ok: false,
      status: 404,
      error: `no deployed workflow of kind "${opts.kind}"`,
    };
  }

  // Provisioning a per-run deployment needs the sidecar. During the deploy
  // window (hub up, sidecar reconnecting) wait bounded for it rather than
  // failing the provision instantly (CL-2707).
  if (!(await waitForSidecarReady(deps))) {
    return deployInProgressFailure();
  }

  const runId = mintRunId();

  // A freshly-deployed supervisor is routable by construction, so the start
  // path needs no ensureDeploymentRoutable (resume still does — a parked run's
  // deployment can lose its address to a restart).
  let deploymentId: string;
  try {
    ({ deploymentId } = await deps.provisionRunDeployment({
      kind: opts.kind,
      tenantId: definition.tenantId,
      creatorPrincipalId: definition.principalId,
    }));
  } catch (err) {
    log.error("workflow run provision failed", {
      runId,
      kind: opts.kind,
      tenantId: definition.tenantId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return {
      ok: false,
      status: 500,
      error: "failed to provision workflow run",
    };
  }

  const state = await insertRunRecord(deps.db, {
    runId,
    deploymentId,
    kind: opts.kind,
    tenantId: definition.tenantId,
    principalId: opts.principalId,
    input: opts.input,
    originConversationId: opts.originConversationId,
  });

  try {
    await deps.sessionService.sendUserMessage({
      agentAddress: deriveDeploymentAddress({
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
      }),
      from: `hub@${deps.deploymentDomain}`,
      messageId: runId,
      date: new Date(),
      content: JSON.stringify(opts.input),
      sessionId: randomUUID(),
      tenantId: definition.tenantId,
      cryptoProvider: deps.cryptoProvider,
    });
  } catch (err) {
    log.error("workflow run-start failed", {
      runId,
      kind: opts.kind,
      deploymentId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    await setRunStatus(deps.db, runId, "failed");
    return { ok: false, status: 500, error: "failed to start workflow run" };
  }

  return { ok: true, state };
}

export type ResumeWorkflowRunDeps = {
  db: HubDb;
  // Reads the run's event log to determine the live gate the run is parked on
  // (CL-2681). The inner repo store — the hub's own store, sidecar-independent.
  repoStore: RepoStore;
  sidecarRouter: SidecarRouter;
  deploymentDomain: string;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
} & SidecarReadinessDeps;

// A resume against a run that is not currently parked on the signal being
// delivered (CL-2681). Returned as a 409 conflict — NOT a 503 (which means
// "sidecar reconnecting", a different case that must still be honored for a
// legitimately-awaiting run). No signal is fired and no status is flipped.
function staleResumeConflict(openSignals: ReadonlySet<string>): RunExecFailure {
  return {
    ok: false,
    status: 409,
    error:
      openSignals.size === 0
        ? "run is not awaiting a signal"
        : "the run is not awaiting this signal",
  };
}

// Guard the resume against the AUTHORITATIVE live gate read from the run's event
// log (CL-2681): permit it only when an open `awaitSignal` gate whose name
// matches is actually parked. Without this, a resume from a stale client poll
// (run already completed/failed, or already resumed to running) would fire the
// signal and optimistically flip the run back to "running", resurrecting a
// terminal/running run. If the log is unreadable, fall back to the coarse index
// status: only an 'awaiting' row permits the resume (the run IS parked but its
// signal name can't be verified); any other status is an authoritative
// "not awaiting" and is refused.
async function assertResumableGate(
  deps: { repoStore: RepoStore; deploymentDomain: string },
  state: RunState,
  deploymentId: string,
  signalName: string,
): Promise<RunExecFailure | null> {
  let openSignals: Set<string>;
  try {
    openSignals = await getAwaitingSignalNames(
      { repoStore: deps.repoStore },
      {
        deploymentId,
        runId: state.runId,
        deploymentDomain: deps.deploymentDomain,
      },
    );
  } catch (err) {
    log.warn("resume gate-check: run log unreadable; using index status", {
      runId: state.runId,
      status: state.status,
      error: err instanceof Error ? err.message : String(err),
    });
    if (state.status === "awaiting") return null;
    return staleResumeConflict(new Set());
  }
  if (openSignals.has(signalName)) return null;
  return staleResumeConflict(openSignals);
}

/**
 * Deliver a gate signal to a parked run's sidecar supervisor and optimistically
 * mark the run running. Owner-gated: the run's principal must be the caller's.
 */
export async function resumeWorkflowRun(
  deps: ResumeWorkflowRunDeps,
  opts: {
    runId: string;
    chain: readonly string[];
    principalId: string;
    signalName: string;
    payload: unknown;
  },
): Promise<RunExecResult> {
  const state = await loadRunRecord(deps.db, opts.runId);
  if (!state) return { ok: false, status: 404, error: "run not found" };

  const gate = assertRunOwnership(
    opts.chain,
    { principalId: opts.principalId },
    state,
  );
  if (gate) return { ok: false, ...gate };

  // Validate the gate payload at the trust boundary for workflows/signals
  // that register a schema; unregistered ones pass through untouched.
  const payloadCheck = validateResumePayload(
    state.kind,
    opts.signalName,
    opts.payload ?? {},
  );
  if (!payloadCheck.ok) {
    return {
      ok: false,
      status: 400,
      error: `invalid resume payload: ${payloadCheck.error}`,
    };
  }

  if (state.deploymentId === undefined) {
    return { ok: false, status: 400, error: "run has no deployment to signal" };
  }

  // Reject a resume against a run not currently parked on this signal (CL-2681)
  // BEFORE the deploy-window wait, so a stale-poll resume conflicts immediately
  // and never fires a signal at — or resurrects — a terminal/running run.
  const gateConflict = await assertResumableGate(
    deps,
    state,
    state.deploymentId,
    opts.signalName,
  );
  if (gateConflict) return gateConflict;

  // The run owns its single-use deployment (`state.deploymentId`) — a per-run
  // deployment writes NO `workflow_run` registry row, so we must NOT look it
  // up there. Recover only the deploy principal (needed to revive the
  // supervisor's rows if a restart dropped it) from the kind's registry row,
  // exactly as start does; a kind with no active deployment can't be resumed.
  const definition = await resolveDeployment(deps.db, opts.chain, state.kind);
  if (!definition) {
    return { ok: false, status: 404, error: "workflow deployment not found" };
  }

  // Re-establishing/signalling the supervisor needs the sidecar. During the
  // deploy window (hub up, sidecar reconnecting) wait bounded for it rather
  // than throwing a raw "signal failed" 500 instantly (CL-2707).
  if (!(await waitForSidecarReady(deps))) {
    return deployInProgressFailure();
  }

  try {
    await deps.ensureDeploymentRoutable({
      deploymentId: state.deploymentId,
      kind: state.kind,
      tenantId: state.tenantId,
      creatorPrincipalId: definition.principalId,
    });
    deps.sidecarRouter.sendSignalDeliver({
      agentAddress: deriveDeploymentAddress({
        deploymentId: state.deploymentId,
        deploymentDomain: deps.deploymentDomain,
      }),
      runId: state.runId,
      signalName: opts.signalName,
      signalId: randomUUID(),
      payload: opts.payload ?? {},
    });
  } catch (err) {
    log.error("workflow resume signal failed", {
      runId: opts.runId,
      signalName: opts.signalName,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { ok: false, status: 500, error: "failed to deliver signal" };
  }

  // CL-2727: the projection bridge is the SOLE writer of run STATUS progression
  // — we no longer optimistically persist `running` here. The gate is cleared on
  // disk by the delivered signal; the sidecar emits SignalReceived + the next
  // StepStarted, and the projection bridge folds the row from `awaiting` back to
  // `running` on the resulting pack. The response still reports the optimistic
  // `running` so the caller's UI reacts immediately, but the DB row is advanced
  // only by the log-derived projection.
  return { ok: true, state: { ...state, status: "running" } };
}
