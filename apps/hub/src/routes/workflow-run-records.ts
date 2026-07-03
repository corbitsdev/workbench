import { getAncestorChain, schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";
import { isTerminalRunStatus } from "../workflow-executor/run-status";
import {
  listRunRecords,
  loadRunRecord,
  markRunStopped,
  softDeleteRunRecord,
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
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "./workflow-runs";

const log = getLogger(["api", "workflow-run-records"]);

const StartBody = type({
  "input?": "unknown",
  // The conversation the run is being started from (CL-2677); omitted for
  // direct starts with no chat context. Length-capped: it is stored as
  // unbounded text and only ever used as an equality filter.
  "originConversationId?": "string <= 256",
});
const ResumeBody = type({ signalName: "string", "payload?": "unknown" });

// The thin run-INDEX response (CL-2669): run-level identity + coarse status.
// Per-step state (phase / outputs / errors) is read separately from the log via
// GET /workflow-exec/runs/:runId/state.
const RunStateResponse = type({
  runId: "string",
  kind: "string",
  status: "'running'|'awaiting'|'completed'|'failed'",
  "deploymentId?": "string",
  "originConversationId?": "string",
});

const ErrorResponse = type({ error: "string" });
const ArchiveResponse = type({ archived: "true" });

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

function stateResponse(state: {
  runId: string;
  kind: string;
  status: "running" | "awaiting" | "completed" | "failed";
  deploymentId?: string;
  originConversationId?: string;
}): {
  runId: string;
  kind: string;
  status: string;
  deploymentId?: string;
  originConversationId?: string;
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
  };
}

// Map a run-exec failure to an HTTP response. The deploy-window 503 (CL-2707)
// gets a sanitized, machine-readable body and a Retry-After header so the FE
// can auto-retry and show an honest "redeploying" state — never a raw 500 with
// "workflow resume signal failed". All other failures keep the flat
// { error: string } shape the existing surface returns.
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
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const resolveContext = deps.resolveContext ?? getRequestedUserContext;

  router.post(
    "/workflow-exec/:kind/start",
    describeRoute({
      tags: ["Workflows"],
      summary: "Start a workflow run",
      description:
        "Seeds a run record and triggers the run on the sidecar supervisor (the deployed definition executes there). Returns the seeded run state immediately; the record advances asynchronously as the sidecar emits events. Optional `?tenantId=` selects a workbench the user belongs to.",
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

      // Return the seeded row immediately (status 'running'); the UI polls it and
      // the projection bridge advances it as the sidecar emits run events.
      return c.json(stateResponse(result.state));
    },
  );

  router.get(
    "/workflow-exec/records",
    describeRoute({
      tags: ["Workflows"],
      summary: "List thin-executor workflow runs",
      description:
        "Lists the run records visible to the user along the tenant chain. Optional `?kind=` and `?originConversationId=` filter.",
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
      const rows = await listRunRecords(
        deps.db,
        chain,
        context.principalId,
        c.req.query("kind"),
        originFilter !== undefined
          ? { originConversationId: originFilter }
          : undefined,
      );
      return c.json(rows);
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

      return c.json(stateResponse(state));
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
      return c.json(stateResponse(result.state));
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

      const active = !isTerminalRunStatus(state.status);
      if (active) {
        // Mark terminal first so the record is consistent (and the janitor would
        // reclaim it) even if the immediate teardown below fails. Shared with the
        // operator abort path so terminal-marking never drifts between them.
        await markRunStopped(deps.db, state);
        if (state.deploymentId !== undefined) {
          await deps
            .reclaimDeployment({
              deploymentId: state.deploymentId,
              tenantId: state.tenantId,
              reason: `run ${runId} archived by user`,
            })
            .catch((err) => {
              log.warn("archive run: per-run deployment teardown failed", {
                runId,
                deploymentId: state.deploymentId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }

      await softDeleteRunRecord(deps.db, runId);
      return c.json({ archived: true });
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
