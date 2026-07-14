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
import { isWorkflowRunDeniedForTenant } from "../lib/workflow-run-gate";
import { markGateMailboxItemRead } from "../lib/principal-mailbox";
import { workflowRun } from "../db/schema";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "../routes/workflow-runs";
import type { ReclaimDeploymentFn } from "../services/workflow-deploy";
import { getAwaitingSignalNames } from "./run-awaiting-signals";
import { validateResumePayload } from "./resume-payload-registry";
import {
  failRunIfStillProvisioning,
  insertRunRecord,
  loadRunRecord,
  setPendingSignal,
  setRunDeployment,
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
export type RunExecSuccess = {
  ok: true;
  state: RunState;
  // CL-2755: async-start only. The detached provision-and-trigger task the route
  // does NOT await (it responds immediately with the `provisioning` state). Its
  // errors are self-handled — it flips the run to `failed` and never rejects — so
  // this promise is exposed purely so tests can await the tail deterministically.
  backgroundTask?: Promise<void>;
};
export type RunExecResult = RunExecSuccess | RunExecFailure;

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

// CL-2755: hard ceiling on the async provision-and-trigger tail. A cold per-run
// deploy is seconds; this is the "never stuck provisioning forever" backstop —
// past it the tail gives up and flips the run to `failed` (loud, terminal)
// rather than leaving it wedged in `provisioning`. The boot orphan sweep is the
// other backstop for a hub crash mid-provision.
const PROVISION_HARD_DEADLINE_MS = 3 * 60 * 1000;

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

// Resolve a gate's "needs you" mailbox item once its signal is accepted:
// stamp read_at if the item is still unread. Best-effort — the run resume must
// never fail because the inbox bookkeeping did, so a failure is logged and
// swallowed.
async function markGateMailReadBestEffort(
  db: HubDb,
  runId: string,
  signalName: string,
): Promise<void> {
  try {
    await markGateMailboxItemRead(db, runId, signalName);
  } catch (err) {
    log.warn("failed to mark gate mail read", {
      runId,
      signalName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  // CL-2755: tears down a per-run deployment the async start tail minted AFTER
  // the run had already been failed (the hard-deadline/failRun race). Without it
  // that deployment would run behind a `failed` record — a phantom run. The
  // reconciler janitor is the backstop, but reclaiming eagerly here closes the
  // window immediately. Optional so non-route callers can omit it.
  reclaimDeployment?: ReclaimDeploymentFn;
} & SidecarReadinessDeps;

/**
 * Start a run of `kind` owned by `principalId` (CL-2755, async start): resolve
 * the kind's registry deployment along the tenant chain, seed the run record in
 * a `provisioning` state, and return IMMEDIATELY — the per-run deployment
 * cold-start (CL-2582) + trigger mail run on a detached background task
 * (`backgroundTask`) so the browser gets an instant ack instead of blocking on
 * the full deploy. The tail is loud-fail: on sidecar timeout, provision failure,
 * or trigger failure it flips the run to `failed`; on success it attaches the
 * deployment and fires the trigger mail (messageId === runId) only once the
 * deployment is routable, then lets the projection bridge advance the run to
 * `running`.
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
  // Owner-controlled run gate (CL-2885). Enforced HERE — the single layer every
  // run entry point funnels through (the /workflow-exec start route AND the
  // workflow_start agent tool) — so no caller can start a disabled workflow.
  // Allow-by-default: blocked only by an explicit member-role deny for this kind
  // on the workbench or an ancestor. (The legacy /workflow-runs start route does
  // not pass through here and gates itself.)
  if (await isWorkflowRunDeniedForTenant(deps.db, opts.chain, opts.kind)) {
    return {
      ok: false,
      status: 403,
      error: "This workflow is disabled for your workbench",
    };
  }

  const definition = await resolveDeployment(deps.db, opts.chain, opts.kind);
  if (!definition) {
    return {
      ok: false,
      status: 404,
      error: `no deployed workflow of kind "${opts.kind}"`,
    };
  }

  const runId = mintRunId();
  const inputObject =
    typeof opts.input === "object" &&
    opts.input !== null &&
    !Array.isArray(opts.input)
      ? (opts.input as Record<string, unknown>)
      : {};
  const triggerPayload = { ...inputObject, runId };

  // Durable-first: the run row exists (status `provisioning`, no deployment yet)
  // before we return, so the FE can poll it and show live "Starting…" progress
  // the instant the 200 lands — the deploy is no longer on the critical path.
  const state = await insertRunRecord(deps.db, {
    runId,
    deploymentId: null,
    kind: opts.kind,
    tenantId: definition.tenantId,
    principalId: opts.principalId,
    input: triggerPayload,
    originConversationId: opts.originConversationId,
    status: "provisioning",
  });

  const backgroundTask = provisionAndTrigger(deps, {
    runId,
    kind: opts.kind,
    input: triggerPayload,
    tenantId: definition.tenantId,
    deployPrincipalId: definition.principalId,
  });

  return { ok: true, state, backgroundTask };
}

type ProvisionTailOpts = {
  runId: string;
  kind: string;
  input: unknown;
  tenantId: string;
  deployPrincipalId: string;
};

// Fail the run ONLY if it is still `provisioning` (CAS) — never clobber a run the
// deadline or the projection already moved. Logs the reason regardless.
async function failProvisioningRun(
  deps: StartWorkflowRunDeps,
  opts: ProvisionTailOpts,
  reason: string,
  err?: unknown,
): Promise<void> {
  log.error(reason, {
    runId: opts.runId,
    kind: opts.kind,
    tenantId: opts.tenantId,
    ...(err !== undefined
      ? { error: err instanceof Error ? err : new Error(String(err)) }
      : {}),
  });
  await failRunIfStillProvisioning(deps.db, opts.runId).catch((setErr) => {
    log.error("failed to mark provisioning run failed", {
      runId: opts.runId,
      error: setErr instanceof Error ? setErr : new Error(String(setErr)),
    });
  });
}

// True only while the run row is still `provisioning`. A `false` means the
// deadline/failRun or the projection already moved the run on — the tail MUST NOT
// attach a deployment or fire a trigger behind that record.
async function stillProvisioning(
  deps: StartWorkflowRunDeps,
  runId: string,
): Promise<boolean> {
  const row = await loadRunRecord(deps.db, runId);
  return row?.status === "provisioning";
}

// The run was failed (deadline/late-provision race) AFTER its deployment was
// already minted — tear that deployment down so it never runs behind a `failed`
// record (a phantom run). This is ESSENTIAL, not just optimization, for the
// pre-attach bail: the reconciler janitor (`reclaimOrphanedDeployments`) keys off
// the run row's `deploymentId`, so a deployment minted but never attached (null
// on the row) is invisible to it and would leak without this eager reclaim. For
// the post-attach bail the janitor is a backstop. Best-effort either way.
async function reclaimAbandonedDeployment(
  deps: StartWorkflowRunDeps,
  opts: ProvisionTailOpts,
  deploymentId: string,
  reason: string,
): Promise<void> {
  log.warn("reclaiming abandoned per-run deployment (start-tail race)", {
    runId: opts.runId,
    deploymentId,
    reason,
  });
  if (deps.reclaimDeployment === undefined) return;
  await deps
    .reclaimDeployment({
      deploymentId,
      tenantId: opts.tenantId,
      reason: `CL-2755 abandoned start-tail deployment for run ${opts.runId}: ${reason}`,
    })
    .catch((err) => {
      log.warn("abandoned deployment reclaim failed (janitor will retry)", {
        runId: opts.runId,
        deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

// CL-2755: the detached start tail. Provisions the per-run deployment, attaches
// it to the run, then fires the trigger mail — NEVER before the deployment is
// routable. It NEVER throws (every error path fails the run via CAS and returns),
// so a caller that does not await it gets no unhandled rejection. A hard deadline
// races the body: if provisioning hangs (or resolves late), the deadline fails
// the run and the abandoned body's race-guards (below) bail — reclaiming any
// deployment already minted so nothing runs behind the `failed` record.
async function provisionAndTrigger(
  deps: StartWorkflowRunDeps,
  opts: ProvisionTailOpts,
): Promise<void> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      void failProvisioningRun(
        deps,
        opts,
        "workflow run provisioning exceeded hard deadline",
      ).finally(resolve);
    }, PROVISION_HARD_DEADLINE_MS);
  });

  try {
    await Promise.race([runProvisionAndTrigger(deps, opts), deadline]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

// The provisioning body. NEVER throws: each failure fails the run (CAS) and
// returns. After the deployment is minted, RE-READS the run status before both
// attaching the deployment and firing the trigger — if the deadline (or a
// concurrent fail) already moved the run off `provisioning`, it bails and
// reclaims the freshly-minted deployment so it can never run behind a `failed`
// record.
async function runProvisionAndTrigger(
  deps: StartWorkflowRunDeps,
  opts: ProvisionTailOpts,
): Promise<void> {
  // Provisioning a per-run deployment needs the sidecar. During the deploy
  // window (hub up, sidecar reconnecting) wait bounded for it rather than
  // failing the provision instantly (CL-2707).
  if (!(await waitForSidecarReady(deps))) {
    await failProvisioningRun(
      deps,
      opts,
      "no sidecar available to provision the run",
    );
    return;
  }

  // A freshly-deployed supervisor is routable by construction, so the start path
  // needs no ensureDeploymentRoutable (resume still does — a parked run's
  // deployment can lose its address to a restart).
  let deploymentId: string;
  try {
    ({ deploymentId } = await deps.provisionRunDeployment({
      kind: opts.kind,
      tenantId: opts.tenantId,
      creatorPrincipalId: opts.deployPrincipalId,
    }));
  } catch (err) {
    await failProvisioningRun(deps, opts, "workflow run provision failed", err);
    return;
  }

  // Race guard: the deadline may have failed the run while the provision was in
  // flight. Do NOT attach the deployment to a no-longer-provisioning record —
  // reclaim it and bail.
  if (!(await stillProvisioning(deps, opts.runId))) {
    await reclaimAbandonedDeployment(
      deps,
      opts,
      deploymentId,
      "run left provisioning before deployment attach",
    );
    return;
  }

  // Attach the deployment BEFORE the trigger fires so every pack the projection
  // bridge receives can be addressed to this run.
  await setRunDeployment(deps.db, opts.runId, deploymentId);

  // Second race guard: never fire the trigger for a run the deadline failed
  // between the attach and here — tear the deployment down instead.
  if (!(await stillProvisioning(deps, opts.runId))) {
    await reclaimAbandonedDeployment(
      deps,
      opts,
      deploymentId,
      "run left provisioning before trigger",
    );
    return;
  }

  try {
    await deps.sessionService.sendUserMessage({
      agentAddress: deriveDeploymentAddress({
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
      }),
      from: `hub@${deps.deploymentDomain}`,
      messageId: opts.runId,
      date: new Date(),
      content: JSON.stringify(opts.input),
      sessionId: randomUUID(),
      tenantId: opts.tenantId,
      cryptoProvider: deps.cryptoProvider,
    });
  } catch (err) {
    await failProvisioningRun(
      deps,
      opts,
      "workflow run trigger send failed",
      err,
    );
  }
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
 * Accept-and-deliver a gate signal addressed BY DEPLOYMENT (the legacy
 * deployment-scoped signal route). The pending-signal record this persists is
 * a durable rail the reconciler acts on (wake + re-deliver), so acceptance is
 * guarded like the records-route resume: the run must belong to the
 * authorized deployment (404 otherwise — no cross-deployment stamping) and
 * must be parked on an open gate for the named signal (409 otherwise), so an
 * unmatchable signal can never be persisted, re-delivered forever, and block
 * hibernation. On success: persist durably, ensure the deployment is
 * routable, then dispatch.
 */
export async function acceptGateSignal(
  deps: ResumeWorkflowRunDeps,
  opts: {
    deploymentId: string;
    kind: string;
    tenantId: string;
    creatorPrincipalId: string;
    runId: string;
    signalName: string;
    payload: unknown;
  },
): Promise<RunExecResult> {
  const state = await loadRunRecord(deps.db, opts.runId);
  if (!state || state.deploymentId !== opts.deploymentId) {
    // Unknown run, or a run owned by a DIFFERENT deployment than the one the
    // caller is authorized for — reject without persisting anything, and
    // without disclosing whether the foreign run exists.
    return { ok: false, status: 404, error: "run not found for deployment" };
  }

  const gateConflict = await assertResumableGate(
    deps,
    state,
    opts.deploymentId,
    opts.signalName,
  );
  if (gateConflict) return gateConflict;

  // Durable-before-dispatch (same contract as resumeWorkflowRun): the
  // reconciler re-delivers from this record until the run log proves receipt.
  const signalId = randomUUID();
  await setPendingSignal(deps.db, state.runId, {
    signalId,
    signalName: opts.signalName,
    payload: opts.payload ?? {},
    receivedAt: new Date().toISOString(),
  });
  await deps.ensureDeploymentRoutable({
    deploymentId: opts.deploymentId,
    kind: opts.kind,
    tenantId: opts.tenantId,
    creatorPrincipalId: opts.creatorPrincipalId,
  });
  deps.sidecarRouter.sendSignalDeliver({
    agentAddress: deriveDeploymentAddress({
      deploymentId: opts.deploymentId,
      deploymentDomain: deps.deploymentDomain,
    }),
    runId: state.runId,
    signalName: opts.signalName,
    signalId,
    payload: opts.payload ?? {},
  });
  await markGateMailReadBestEffort(deps.db, state.runId, opts.signalName);
  return { ok: true, state };
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
    // Durable-before-dispatch: persist the accepted signal on the run record
    // FIRST, so a teardown racing the fire-and-forget delivery below cannot
    // lose it — the awaiting reconciler re-delivers from this record until
    // the run log proves receipt (the projection clears it by signalId).
    const signalId = randomUUID();
    await setPendingSignal(deps.db, state.runId, {
      signalId,
      signalName: opts.signalName,
      payload: opts.payload ?? {},
      receivedAt: new Date().toISOString(),
    });
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
      signalId,
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

  await markGateMailReadBestEffort(deps.db, state.runId, opts.signalName);

  // CL-2727: the projection bridge is the SOLE writer of run STATUS progression
  // — we no longer optimistically persist `running` here. The gate is cleared on
  // disk by the delivered signal; the sidecar emits SignalReceived + the next
  // StepStarted, and the projection bridge folds the row from `awaiting` back to
  // `running` on the resulting pack. The response still reports the optimistic
  // `running` so the caller's UI reacts immediately, but the DB row is advanced
  // only by the log-derived projection.
  return { ok: true, state: { ...state, status: "running" } };
}
