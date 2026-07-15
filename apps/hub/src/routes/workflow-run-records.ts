import { getAncestorChain, schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, resolver } from "hono-openapi";
import { subscribeKind } from "@intx/hub-sessions";
import type { Principal, RepoId } from "@intx/hub-sessions";
import { requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";
import { workflowRunRecord } from "../db/schema";
import { isTerminalRunStatus } from "../workflow-executor/run-status";
import {
  getRunKindStats,
  listRunRecords,
  listRunSteps,
  loadDeploymentMeta,
  loadRunRecord,
  markRunStopped,
  markRunUserStopped,
  softDeleteRunRecord,
  type RunState,
} from "../workflow-executor/run-store";
import {
  assertRunOwnership,
  resumeWorkflowRun,
  startWorkflowRun,
  type RunExecFailure,
} from "../workflow-executor/run-exec";
import type { ReclaimDeploymentFn } from "../services/workflow-deploy";
import type {
  AgentRepoStore,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import {
  getWorkflowRunState,
  LogRunStateSchema,
  type LogRunState,
} from "../workflow-executor/run-state-from-log";
import type { CryptoProvider } from "@intx/types/runtime";
import {
  deriveWorkflowRunRepoId,
  type EnsureDeploymentRoutableFn,
  type ProvisionRunDeploymentFn,
} from "./workflow-runs";
import {
  getWorkflowRunStepTokenTotals,
  getWorkflowRunTokenTotals,
} from "../services/activity-overview";
import { WorkflowMeta } from "../lib/workflow-meta";
import { resolvePrincipalNames } from "../services/admin-governance";

const log = getLogger(["api", "workflow-run-records"]);

// SSE run-state stream (CL-2727). The envelope subscribeKind narrows each
// committed event blob through, and the on-disk `type` discriminators it tails —
// the same set the raw-event stream in workflow-runs.ts uses. A run-state stream
// re-folds and re-emits the authoritative RunState whenever a new event lands,
// replacing the FE's fixed-interval poll of GET /workflow-exec/runs/:runId/state.
const RUN_SSE_EVENT_REF = "refs/heads/main";
const RUN_SSE_HUB_PRINCIPAL: Principal = { kind: "hub" };
const RUN_SSE_EVENT_BLOB = type({
  type: "string",
  seq: "number",
  "+": "ignore",
});
const RUN_SSE_EVENT_TYPES: readonly string[] = [
  "RunStarted",
  "StepStarted",
  "StepCompleted",
  "StepFailed",
  "AttemptScheduled",
  "SignalAwaited",
  "SignalReceived",
  "TimerSet",
  "TimerFired",
  "CancelRequested",
  "CancelPropagated",
  "ChildSpawned",
  "ChildCancelRequested",
  "ChildCompleted",
  "RunCompleted",
  "RunFailed",
  "RunCancelled",
];

const StartBody = type({
  "input?": "unknown",
  // The conversation the run is being started from (CL-2677); omitted for
  // direct starts with no chat context. Length-capped: it is stored as
  // unbounded text and only ever used as an equality filter.
  "originConversationId?": "string <= 256",
});
const ResumeBody = type({ signalName: "string", "payload?": "unknown" });

const RUN_INDEX_STATUS =
  "'provisioning'|'running'|'awaiting'|'completed'|'failed'|'stopped'" as const;

// The thin run-INDEX response (CL-2669): run-level identity + coarse status.
// Per-step state (phase / outputs / errors) is read separately from the log via
// GET /workflow-exec/runs/:runId/state.
const RunStateResponse = type({
  runId: "string",
  kind: "string",
  status: RUN_INDEX_STATUS,
  "deploymentId?": "string",
  "originConversationId?": "string",
  // The run's deploy-time version provenance, joined from the deployment index
  // by deploymentId. Sourced here rather than from the grant-filtered runnable
  // catalog so the run pane's version badge survives an owner disabling the
  // kind. Omitted for deployments that predate version capture.
  "meta?": WorkflowMeta,
  "principalId?": "string",
  "ownerDisplayName?": "string",
});

const ErrorResponse = type({ error: "string" });
const ArchiveResponse = type({ archived: "true" });
const StopResponse = type({ stopped: "true" });

// CL-2809: per-run token totals, read-side attribution over the existing
// analytics rollup — see `getWorkflowRunTokenTotals`. `available: false` covers
// every honest gap (no per-run instance attributable yet, or a legacy run
// whose usage collapsed into a later serial run on the same shared
// deployment) — the FE must render that as a gap, never as zero usage.
const WorkflowRunTokenCountsSchema = {
  turnCount: "number",
  toolCallCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
} as const;

export const WorkflowRunTokensResponse = type({
  runId: "string",
  available: "boolean",
  "totals?": WorkflowRunTokenCountsSchema,
  "steps?": type({
    stepId: "string",
    ...WorkflowRunTokenCountsSchema,
  }).array(),
});
export type WorkflowRunTokens = typeof WorkflowRunTokensResponse.infer;

// CL-2727 stats shapes, computed from the per-step projection. `RunKindStats` is
// the by-kind aggregate; `SoloRunStats` is a single run's per-step breakdown.
export const RunKindStatsSchema = type({
  kind: "string",
  runs: {
    provisioning: "number",
    running: "number",
    awaiting: "number",
    completed: "number",
    failed: "number",
    stopped: "number",
    total: "number",
  },
  steps: {
    total: "number",
    byPhase: { "[string]": "number" },
    avgDurationMs: "number | null",
  },
});
export const RunKindStatsListSchema = RunKindStatsSchema.array();
export type RunKindStatsList = typeof RunKindStatsListSchema.infer;

export const SoloRunStatsSchema = type({
  runId: "string",
  kind: "string",
  status: RUN_INDEX_STATUS,
  "startedAt?": "string | null",
  "endedAt?": "string | null",
  steps: type({
    stepId: "string",
    phase: "string",
    attempts: "number",
    "startedAt?": "string | null",
    "endedAt?": "string | null",
    "durationMs?": "number | null",
  }).array(),
});
export type SoloRunStats = typeof SoloRunStatsSchema.infer;

// The deploy-window 503 body (CL-2707). Unlike every other failure — which
// returns the flat { error: string } shape — this one nests a machine-readable
// `code` and a human `message` so the FE can auto-retry and show an honest
// "finishing an update" state. Exported so the OpenAPI 503 responses reference
// the real body contract, not a bare description.
export const DeployInProgressResponse = type({
  error: {
    code: "'deploy_in_progress'",
    message: "string",
  },
});
export type DeployInProgress = typeof DeployInProgressResponse.infer;

function stateResponse(
  state: {
    runId: string;
    kind: string;
    status:
      | "provisioning"
      | "running"
      | "awaiting"
      | "completed"
      | "failed"
      | "stopped";
    deploymentId?: string;
    originConversationId?: string;
  },
  meta?: WorkflowMeta | null,
): {
  runId: string;
  kind: string;
  status: string;
  deploymentId?: string;
  originConversationId?: string;
  meta?: WorkflowMeta;
} {
  return {
    runId: state.runId,
    kind: state.kind,
    status: state.status,
    ...(state.deploymentId !== undefined
      ? { deploymentId: state.deploymentId }
      : {}),
    ...(state.originConversationId !== undefined
      ? { originConversationId: state.originConversationId }
      : {}),
    ...(meta ? { meta } : {}),
  };
}

async function stateResponseWithOwnership(
  db: HubDb,
  tenantId: string,
  state: {
    runId: string;
    kind: string;
    status:
      | "provisioning"
      | "running"
      | "awaiting"
      | "completed"
      | "failed"
      | "stopped";
    deploymentId?: string;
    originConversationId?: string;
    principalId: string;
  },
  meta?: WorkflowMeta | null,
) {
  const base = stateResponse(state, meta);
  const names = await resolvePrincipalNames(db, tenantId, [state.principalId]);
  const ownerDisplayName = names.get(state.principalId);
  return {
    ...base,
    principalId: state.principalId,
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
  };
}

// Resolve the run's deploy-time version meta for the record response. Keyed by
// the run's own deploymentId (not the grant-filtered catalog), so a run whose
// kind an owner has since disabled still carries its version. Null when the run
// has no deployment yet (provisioning) or the deployment predates version meta.
async function resolveStateMeta(
  db: HubDb,
  state: { deploymentId?: string },
): Promise<WorkflowMeta | null> {
  if (state.deploymentId === undefined) return null;
  return loadDeploymentMeta(db, state.deploymentId);
}

// Map a run-exec failure to an HTTP response. The deploy-window 503 (CL-2707)
// gets a sanitized, machine-readable body and a Retry-After header so the FE
// can auto-retry and show an honest "redeploying" state — never a raw 500 with
// "workflow resume signal failed". All other failures keep the flat
// { error: string } shape the existing surface returns.
async function tearDownActiveRun(
  deps: { db: HubDb; reclaimDeployment: ReclaimDeploymentFn },
  runId: string,
  state: RunState,
  markTerminal: () => Promise<void>,
  reclaimReason: string,
): Promise<void> {
  if (isTerminalRunStatus(state.status)) return;
  await markTerminal();
  if (state.deploymentId === undefined) return;
  await deps
    .reclaimDeployment({
      deploymentId: state.deploymentId,
      tenantId: state.tenantId,
      reason: reclaimReason,
    })
    .catch((err) => {
      log.warn("workflow run: per-run deployment teardown failed", {
        runId,
        deploymentId: state.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function runExecErrorResponse(c: Context, result: RunExecFailure): Response {
  if (result.status === 503) {
    // A 503 only ever originates from the deploy-window failure, which always
    // sets both fields — no fallback needed.
    c.header("Retry-After", String(result.retryAfterSeconds));
    return c.json({ error: { code: result.code, message: result.error } }, 503);
  }
  return c.json({ error: result.error }, result.status);
}

// Workflow runs surface (CL-2243). State lives in the workflow_run_record row,
// but EXECUTION runs on the sidecar supervisor (the definition is deployed like
// an agent). /start seeds the row and fires the deployment's trigger mail;
// /resume delivers the gate signal. The projection bridge
// (wrapRepoStoreWithProjection) folds the sidecar's run events back into this
// row, which the UI polls. Reads are a single indexed row lookup — no replay.
export function createWorkflowRunRecordsRouter(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
  sidecarRouter: SidecarRouter;
  sessionService: SessionService;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  provisionRunDeployment: ProvisionRunDeploymentFn;
  // Tears down a run's single-use per-run deployment (CL-2582), used by the
  // archive route to free an active run's resources immediately.
  reclaimDeployment: ReclaimDeploymentFn;
  // CL-2707: sidecar readiness probe (sidecarRouter.getConnectedSidecars). When
  // provided, start/resume wait bounded for a sidecar during the deploy window
  // instead of failing instantly. The timeout/interval overrides are for tests.
  isSidecarConnected?: () => boolean;
  sidecarWaitTimeoutMs?: number;
  sidecarPollIntervalMs?: number;
  // Injectable for tests only.
  resolveContext?: typeof getRequestedUserContext;
  // CL-3688: fire analytics facts when a user stop marks the run terminal.
  onUserStoppedRunFacts?: (args: {
    runId: string;
    kind: string;
    tenantId: string;
    deploymentId: string | null;
  }) => void;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const resolveContext = deps.resolveContext ?? getRequestedUserContext;

  router.post(
    "/workflow-exec/:kind/start",
    describeRoute({
      tags: ["Workflows"],
      summary: "Start a workflow run",
      description:
        "Seeds a run record in a `provisioning` state and returns immediately, WITHOUT awaiting the per-run deployment cold-start (CL-2755). The deployment is minted and the trigger fired on a background task; the record advances to `running` as the sidecar emits events, or to `failed` if provisioning fails. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "kind",
          in: "path",
          required: true,
          description: "Workflow kind.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        description: "Trigger payload.",
        content: {
          "application/json": { schema: requestBodySchema(StartBody) },
        },
      },
      responses: {
        200: {
          description: "Run state after the initial advance",
          content: {
            "application/json": { schema: resolver(RunStateResponse) },
          },
        },
        400: {
          description: "Invalid start body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No deployment",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        503: {
          description:
            "Deploy in progress — the sidecar has not reconnected within the bounded wait; retry after the Retry-After hint (CL-2707)",
          content: {
            "application/json": {
              schema: resolver(DeployInProgressResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const kind = c.req.param("kind");
      const chain = await getAncestorChain(deps.db, context.tenantId);

      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = StartBody(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid start body: ${parsed.summary}` }, 400);
      }

      const result = await startWorkflowRun(
        {
          db: deps.db,
          sessionService: deps.sessionService,
          cryptoProvider: deps.cryptoProvider,
          deploymentDomain: deps.deploymentDomain,
          provisionRunDeployment: deps.provisionRunDeployment,
          // CL-2755: lets the async start tail reclaim a deployment it minted
          // AFTER the run was already failed (deadline race), so it never runs
          // behind a `failed` record.
          reclaimDeployment: deps.reclaimDeployment,
          ...(deps.isSidecarConnected !== undefined
            ? { isSidecarConnected: deps.isSidecarConnected }
            : {}),
          ...(deps.sidecarWaitTimeoutMs !== undefined
            ? { sidecarWaitTimeoutMs: deps.sidecarWaitTimeoutMs }
            : {}),
          ...(deps.sidecarPollIntervalMs !== undefined
            ? { sidecarPollIntervalMs: deps.sidecarPollIntervalMs }
            : {}),
        },
        {
          kind,
          chain,
          principalId: context.principalId,
          input: parsed.input ?? {},
          originConversationId: parsed.originConversationId ?? null,
        },
      );
      if (!result.ok) return runExecErrorResponse(c, result);

      // CL-2755: return the seeded row immediately (status 'provisioning') —
      // WITHOUT awaiting the per-run deployment cold-start. `startWorkflowRun`
      // provisions + fires the trigger on a detached background task; the UI
      // polls this row and the projection bridge advances it to 'running' once
      // the sidecar emits its first event, or the tail flips it to 'failed'.
      return c.json(
        stateResponse(
          result.state,
          await resolveStateMeta(deps.db, result.state),
        ),
      );
    },
  );

  router.get(
    "/workflow-exec/records",
    describeRoute({
      tags: ["Workflows"],
      summary: "List thin-executor workflow runs",
      description:
        "Lists the run records visible to the user along the tenant chain. Each row carries the starter principal and their display name so the run-history surface can filter by actor (CL-3667). Optional `?kind=` and `?originConversationId=` filter; `?scope=tenant` lists every run in the workbench (default `own` lists only the caller's).",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
        {
          name: "kind",
          in: "query",
          required: false,
          description: "Filter by workflow kind.",
          schema: { type: "string" },
        },
        {
          name: "originConversationId",
          in: "query",
          required: false,
          description:
            "Filter to runs started from this conversation (CL-2677).",
          schema: { type: "string" },
        },
        {
          name: "scope",
          in: "query",
          required: false,
          description:
            "`own` (default) lists the caller's runs; `tenant` lists every run in the workbench for the actor-filtered run history (CL-3667).",
          schema: { type: "string", enum: ["own", "tenant"] },
        },
      ],
      responses: {
        200: {
          description: "Run records",
          content: { "application/json": {} },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const originFilter = c.req.query("originConversationId");
      const listFilters: {
        originConversationId?: string;
        scope?: "own" | "tenant";
      } = {};
      if (c.req.query("scope") === "tenant") listFilters.scope = "tenant";
      if (originFilter !== undefined) {
        listFilters.originConversationId = originFilter;
      }
      const rows = await listRunRecords(
        deps.db,
        chain,
        context.principalId,
        c.req.query("kind"),
        listFilters,
      );
      // CL-3667: resolve the starter's display name once per distinct principal
      // so the run-history surface can show and filter by who started each run.
      const names = await resolvePrincipalNames(deps.db, context.tenantId, [
        ...new Set(rows.map((r) => r.principalId)),
      ]);
      const enriched = rows.map((r) => {
        const ownerDisplayName = names.get(r.principalId);
        return {
          ...r,
          isSelf: r.principalId === context.principalId,
          ...(ownerDisplayName ? { ownerDisplayName } : {}),
        };
      });
      return c.json(enriched);
    },
  );

  // CL-2727: run stats computed from the per-step projection. Without `?runId=`
  // it returns the by-kind aggregate for the caller's runs along the tenant
  // chain (optionally filtered by `?kind=`); with `?runId=` it returns that one
  // run's per-step breakdown (owner-gated). Neither replays the git log — both
  // read the projected `workflow_run_step` + `workflow_run_record` tables.
  router.get(
    "/workflow-exec/stats",
    describeRoute({
      tags: ["Workflows"],
      summary: "Workflow run stats from the per-step projection",
      description:
        "Aggregate run + per-step stats derived from the per-step projection (workflow_run_step). Default: by-kind aggregate (run counts by status, step phase distribution, mean step duration) for the caller's runs along the tenant chain. With `?runId=`: that run's per-step breakdown (phase, attempts, timing, duration). Optional `?kind=` filters the aggregate; `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
        {
          name: "kind",
          in: "query",
          required: false,
          description: "Filter the by-kind aggregate to one workflow kind.",
          schema: { type: "string" },
        },
        {
          name: "runId",
          in: "query",
          required: false,
          description: "Return one run's per-step breakdown instead.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "By-kind aggregate, or a solo run's per-step breakdown",
          content: {
            "application/json": { schema: resolver(RunKindStatsListSchema) },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found (solo mode)",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);
      const chain = await getAncestorChain(deps.db, context.tenantId);

      const runId = c.req.query("runId");
      if (runId !== undefined) {
        const state = await loadRunRecord(deps.db, runId);
        if (!state) return c.json({ error: "run not found" }, 404);
        const gate = assertRunOwnership(chain, context, state);
        if (gate) return c.json({ error: gate.error }, gate.status);

        const record = await deps.db.query.workflowRunRecord.findFirst({
          where: eq(workflowRunRecord.id, runId),
          columns: { startedAt: true, endedAt: true },
        });
        const steps = await listRunSteps(deps.db, runId);
        const solo: SoloRunStats = {
          runId: state.runId,
          kind: state.kind,
          status: state.status,
          startedAt: record?.startedAt?.toISOString() ?? null,
          endedAt: record?.endedAt?.toISOString() ?? null,
          steps: steps.map((s) => ({
            stepId: s.stepId,
            phase: s.phase,
            attempts: s.attempts,
            startedAt: s.startedAt?.toISOString() ?? null,
            endedAt: s.endedAt?.toISOString() ?? null,
            durationMs:
              s.startedAt !== null && s.endedAt !== null
                ? s.endedAt.getTime() - s.startedAt.getTime()
                : null,
          })),
        };
        return c.json(solo);
      }

      const stats = await getRunKindStats(
        deps.db,
        chain,
        context.principalId,
        c.req.query("kind"),
      );
      return c.json(stats);
    },
  );

  router.get(
    "/workflow-exec/records/:runId",
    describeRoute({
      tags: ["Workflows"],
      summary: "Read a workflow run's index row",
      description:
        "Returns the thin run-index row — run-level identity, kind, and coarse status — as a single indexed read. Per-step state (phase / outputs / errors) is read from the native event log via GET /workflow-exec/runs/:runId/state.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Run state",
          content: {
            "application/json": { schema: resolver(RunStateResponse) },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const state = await loadRunRecord(deps.db, c.req.param("runId"));
      if (!state) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      return c.json(
        await stateResponseWithOwnership(
          deps.db,
          context.tenantId,
          state,
          await resolveStateMeta(deps.db, state),
        ),
      );
    },
  );

  router.get(
    "/workflow-exec/records/:runId/tokens",
    describeRoute({
      tags: ["Workflows"],
      summary: "Read a workflow run's per-run token totals",
      description:
        "Per-run token totals recovered read-side from the existing analytics rollup (CL-2809): no new sink, no sidecar or schema change. `available: false` covers every honest gap — no per-run instance is attributable yet, or (documented legacy caveat) this run was an earlier serial run on a shared pre-CL-2582 deployment whose usage collapsed into a later run's row. Cost-in-dollars is a separate, in-flight concern (CL-2723); this route only surfaces token counts.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Per-run token totals, or an honest unavailable gap",
          content: {
            "application/json": { schema: resolver(WorkflowRunTokensResponse) },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const state = await loadRunRecord(deps.db, runId);
      if (!state) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      const totals = await getWorkflowRunTokenTotals({
        db: deps.db,
        tenantId: state.tenantId,
        runId,
      });
      if (totals === null) return c.json({ runId, available: false });
      const stepRows = await getWorkflowRunStepTokenTotals({
        db: deps.db,
        tenantId: state.tenantId,
        runId,
      });
      return c.json({
        runId,
        available: true,
        totals: {
          turnCount: totals.turnCount,
          toolCallCount: totals.toolCallCount,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          thinkingTokens: totals.thinkingTokens,
        },
        ...(stepRows.length > 0
          ? {
              steps: stepRows.map((s) => ({
                stepId: s.stepId,
                turnCount: s.turnCount,
                toolCallCount: s.toolCallCount,
                inputTokens: s.inputTokens,
                outputTokens: s.outputTokens,
                cacheReadTokens: s.cacheReadTokens,
                cacheWriteTokens: s.cacheWriteTokens,
                thinkingTokens: s.thinkingTokens,
              })),
            }
          : {}),
      });
    },
  );

  // Log-derived RunState (CL-2669 Phase 1a). Reads the run's native git event
  // log through the #534 layout-aware reader and folds it through the native
  // @intx/workflow state machine — returning the full run phase + per-step
  // phase/attempt/timing/type the runtime itself computes. Additive: it does not
  // replace the record read above; it proves the log is the source of truth
  // before any table is removed. Owner-gated identically to the record read.
  router.get(
    "/workflow-exec/runs/:runId/state",
    describeRoute({
      tags: ["Workflows"],
      summary: "Read a workflow run's state from its native event log",
      description:
        "Folds the run's append-only git event log through the native @intx/workflow state machine to return the authoritative RunState: run phase plus per-step phase, attempt, timing, and execution type (human/agent/deterministic/inline). Handles both in-flight (per-event) and sealed (combined) log layouts.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Log-derived run state",
          content: {
            "application/json": { schema: resolver(LogRunStateSchema) },
          },
        },
        400: {
          description: "Run has no deployment",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const record = await loadRunRecord(deps.db, runId);
      if (!record) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, record);
      if (gate) return c.json({ error: gate.error }, gate.status);

      if (record.deploymentId === undefined) {
        return c.json({ error: "run has no deployment log to read" }, 400);
      }

      // A fold/read failure (a TransitionError on a truncated log, an empty
      // repo, a reader failure) must NOT become a 500 that bricks the pane.
      // Degrade to an empty pending state the FE reconciles against the run-level
      // index status (an aborted run then renders failed via the overlay; a live
      // run shows "waiting for activity") rather than hanging or crashing.
      let runState: LogRunState;
      try {
        runState = await getWorkflowRunState(
          { repoStore: deps.repoStore },
          {
            deploymentId: record.deploymentId,
            runId,
            kind: record.kind,
            deploymentDomain: deps.deploymentDomain,
          },
        );
      } catch (err) {
        log.warn(
          "workflow log-state read failed; serving empty pending state",
          {
            runId,
            error: err instanceof Error ? err : new Error(String(err)),
          },
        );
        runState = { runId, phase: "pending", lastSeq: 0, steps: [] };
      }
      const parsed = LogRunStateSchema(runState);
      if (parsed instanceof type.errors) {
        log.error("workflow log-state failed validation", {
          runId,
          error: new Error(parsed.summary),
        });
        return c.json({ error: "failed to read run state" }, 500);
      }
      return c.json(parsed);
    },
  );

  // Live run-state SSE (CL-2727). Reuses the existing streamSSE + subscribeKind
  // tail pattern (workflow-runs.ts /stream), but instead of forwarding raw
  // events it re-folds the run's log through the native state machine and emits
  // the authoritative RunState on the initial connect and on every subsequent
  // event — so the FE can drop its fixed-interval poll of the /state route.
  router.get(
    "/workflow-exec/runs/:runId/state/stream",
    describeRoute({
      tags: ["Workflows"],
      summary: "Stream a workflow run's log-derived state",
      description:
        "Server-Sent Events stream of the run's authoritative RunState (run phase + per-step phase/attempt/timing), re-folded from the native git event log on connect and on every new event. Replaces polling GET /workflow-exec/runs/:runId/state. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Server-Sent Events stream of the run's RunState",
          content: { "text/event-stream": {} },
        },
        400: {
          description: "Run has no deployment",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const record = await loadRunRecord(deps.db, runId);
      if (!record) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, record);
      if (gate) return c.json({ error: gate.error }, gate.status);

      if (record.deploymentId === undefined) {
        return c.json({ error: "run has no deployment log to read" }, 400);
      }
      const deploymentId = record.deploymentId;

      const repoId: RepoId = {
        kind: "workflow-run",
        id: deriveWorkflowRunRepoId({
          deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
      };

      // Re-fold + emit the current RunState. A fold/read failure degrades to an
      // empty pending state (matching the non-stream route) rather than tearing
      // the stream down.
      const emitState = async (
        stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
      ): Promise<void> => {
        let runState: LogRunState;
        try {
          runState = await getWorkflowRunState(
            { repoStore: deps.repoStore },
            {
              deploymentId,
              runId,
              kind: record.kind,
              deploymentDomain: deps.deploymentDomain,
            },
          );
        } catch (err) {
          log.warn("workflow run-state stream fold failed; emitting pending", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
          runState = { runId, phase: "pending", lastSeq: 0, steps: [] };
        }
        await stream.writeSSE({ data: JSON.stringify(runState) });
      };

      return streamSSE(c, async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());

        // Emit the current state immediately so a late subscriber is never blank.
        await emitState(stream);

        const iter = subscribeKind(
          deps.repoStore.repoStore,
          RUN_SSE_HUB_PRINCIPAL,
          repoId,
          RUN_SSE_EVENT_REF,
          RUN_SSE_EVENT_BLOB,
          {
            signal: abort.signal,
            from: { seq: 0 },
            kinds: RUN_SSE_EVENT_TYPES,
          },
        );

        try {
          for await (const entry of iter) {
            // Only this run's events trigger a re-fold (one repo can carry
            // several runs' event streams).
            if (entry.runId !== runId) continue;
            await emitState(stream);
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            log.error("workflow run-state stream failed", {
              runId,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      });
    },
  );

  router.post(
    "/workflow-exec/records/:runId/resume",
    describeRoute({
      tags: ["Workflows"],
      summary: "Resume a gated workflow run",
      description:
        "Delivers the gate signal to the run's sidecar supervisor and optimistically marks the run running. The record advances as the sidecar emits the next step events.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        description: "Signal name and gate payload.",
        content: {
          "application/json": { schema: requestBodySchema(ResumeBody) },
        },
      },
      responses: {
        200: {
          description: "Run state after resume",
          content: {
            "application/json": { schema: resolver(RunStateResponse) },
          },
        },
        400: {
          description: "Invalid resume",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description:
            "Run is not currently awaiting this signal (stale resume) — no signal was delivered and the run's status is unchanged (CL-2681)",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        503: {
          description:
            "Deploy in progress — the sidecar has not reconnected within the bounded wait; retry after the Retry-After hint (CL-2707)",
          content: {
            "application/json": {
              schema: resolver(DeployInProgressResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const chain = await getAncestorChain(deps.db, context.tenantId);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const parsed = ResumeBody(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid resume body: ${parsed.summary}` }, 400);
      }

      const result = await resumeWorkflowRun(
        {
          db: deps.db,
          repoStore: deps.repoStore.repoStore,
          sidecarRouter: deps.sidecarRouter,
          deploymentDomain: deps.deploymentDomain,
          ensureDeploymentRoutable: deps.ensureDeploymentRoutable,
          ...(deps.isSidecarConnected !== undefined
            ? { isSidecarConnected: deps.isSidecarConnected }
            : {}),
          ...(deps.sidecarWaitTimeoutMs !== undefined
            ? { sidecarWaitTimeoutMs: deps.sidecarWaitTimeoutMs }
            : {}),
          ...(deps.sidecarPollIntervalMs !== undefined
            ? { sidecarPollIntervalMs: deps.sidecarPollIntervalMs }
            : {}),
        },
        {
          runId,
          chain,
          principalId: context.principalId,
          signalName: parsed.signalName,
          payload: parsed.payload ?? {},
        },
      );
      if (!result.ok) return runExecErrorResponse(c, result);
      return c.json(
        stateResponse(
          result.state,
          await resolveStateMeta(deps.db, result.state),
        ),
      );
    },
  );

  // Archive a run (CL-2629): stop it, free its resources, and drop it from the
  // list. Owner-scoped (same ownership gate as read/resume). An ACTIVE run
  // (non-terminal) is marked terminal and its single-use per-run deployment
  // (CL-2582) is torn down immediately — no waiting for the boot-reconciler.
  // A terminal run's deployment is already reclaimed on the terminal
  // transition, so this only soft-deletes the record. Teardown is best-effort:
  // the record is soft-deleted regardless, so a sidecar hiccup never leaves a
  // run stuck in the list — and the reconciler janitor's reclaim sweep now
  // includes soft-deleted terminal rows (workflow-reconciler.ts), so a failed
  // teardown's deployment is still reaped on the next pass rather than leaked.
  router.post(
    "/workflow-exec/records/:runId/archive",
    describeRoute({
      tags: ["Workflows"],
      summary: "Archive (stop and remove) a workflow run",
      description:
        "Owner-scoped. Stops an active run and tears down its per-run deployment, then soft-deletes the record so it leaves the run list. Terminal runs are soft-deleted only. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Run archived",
          content: {
            "application/json": { schema: resolver(ArchiveResponse) },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const state = await loadRunRecord(deps.db, runId);
      if (!state) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      await tearDownActiveRun(
        deps,
        runId,
        state,
        () => markRunStopped(deps.db, state),
        `run ${runId} archived by user`,
      );

      await softDeleteRunRecord(deps.db, runId);
      return c.json({ archived: true });
    },
  );

  // CL-3688: stop an in-flight run without soft-deleting — record stays in history
  // as `stopped`. Same ownership gate and active-run teardown as archive.
  router.post(
    "/workflow-exec/records/:runId/stop",
    describeRoute({
      tags: ["Workflows"],
      summary: "Stop a workflow run",
      description:
        "Owner-scoped. Marks an active run `stopped` and tears down its per-run deployment. Terminal runs are left unchanged (idempotent). Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          description: "Run id.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Run stopped (or already terminal)",
          content: {
            "application/json": { schema: resolver(StopResponse) },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Run not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const runId = c.req.param("runId");
      const state = await loadRunRecord(deps.db, runId);
      if (!state) return c.json({ error: "run not found" }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      const wasActive = !isTerminalRunStatus(state.status);
      await tearDownActiveRun(
        deps,
        runId,
        state,
        () => markRunUserStopped(deps.db, state),
        `run ${runId} stopped by user`,
      );
      if (wasActive && deps.onUserStoppedRunFacts !== undefined) {
        deps.onUserStoppedRunFacts({
          runId,
          kind: state.kind,
          tenantId: state.tenantId,
          deploymentId: state.deploymentId ?? null,
        });
      }

      return c.json({ stopped: true as const });
    },
  );

  // Inference credentials visible to the caller's tenant chain — used by the
  // A/B compare config step to populate the provider/model dropdowns. Returns
  // only tenant-owned (principalId IS NULL) credentials whose provider plugin
  // is in the inference whitelist; secrets are never included.
  const INFERENCE_PLUGINS = new Set([
    "anthropic",
    "openai",
    "openai-compatible",
    "google-genai",
  ]);

  router.get(
    "/workflow-exec/credentials",
    describeRoute({
      tags: ["Workflows"],
      summary: "List inference credentials for workflow configuration",
      description:
        "Returns tenant-owned inference credentials (no secrets) whose provider plugin is in the inference whitelist. Used to populate provider/model pickers in workflow config UIs.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description: "Target workbench tenant id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "List of inference credentials" },
        403: { description: "Forbidden" },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await resolveContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const chain = await getAncestorChain(deps.db, context.tenantId);

      const rows = await deps.db
        .select({
          id: intxSchema.credential.id,
          name: intxSchema.credential.name,
          metadata: intxSchema.credential.metadata,
          providerName: intxSchema.provider.name,
          providerPlugin: intxSchema.provider.plugin,
        })
        .from(intxSchema.credential)
        .innerJoin(
          intxSchema.provider,
          eq(intxSchema.credential.providerId, intxSchema.provider.id),
        )
        .where(
          and(
            inArray(intxSchema.credential.tenantId, [...chain]),
            isNull(intxSchema.credential.principalId),
          ),
        );

      const CredentialMeta = type({ "model?": "string" });
      const result = rows
        .filter((r) => INFERENCE_PLUGINS.has(r.providerPlugin))
        .map((r) => {
          const meta = CredentialMeta(r.metadata);
          return {
            id: r.id,
            name: r.name,
            providerName: r.providerName,
            providerPlugin: r.providerPlugin,
            model: meta instanceof type.errors ? undefined : meta.model,
          };
        });

      return c.json(result);
    },
  );

  return router;
}
