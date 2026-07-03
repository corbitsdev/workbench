import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "../routes/workflow-runs";
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
  status: 400 | 403 | 404 | 500;
  error: string;
};
export type RunExecResult = { ok: true; state: RunState } | RunExecFailure;

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
};

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
  sidecarRouter: SidecarRouter;
  deploymentDomain: string;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
};

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

  // The run owns its single-use deployment (`state.deploymentId`) — a per-run
  // deployment writes NO `workflow_run` registry row, so we must NOT look it
  // up there. Recover only the deploy principal (needed to revive the
  // supervisor's rows if a restart dropped it) from the kind's registry row,
  // exactly as start does; a kind with no active deployment can't be resumed.
  const definition = await resolveDeployment(deps.db, opts.chain, state.kind);
  if (!definition) {
    return { ok: false, status: 404, error: "workflow deployment not found" };
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

  // Optimistically clear the gate so the UI resumes polling — a row in
  // 'awaiting' pauses the poll. The projection bridge advances it as the
  // sidecar emits the next StepStarted/StepCompleted/RunCompleted.
  await setRunStatus(deps.db, state.runId, "running");
  return { ok: true, state: { ...state, status: "running" } };
}
