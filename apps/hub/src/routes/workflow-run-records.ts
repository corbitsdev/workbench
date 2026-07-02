import { getAncestorChain, schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { requestBodySchema } from "../lib/openapi";
import { randomBytes, randomUUID } from "node:crypto";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { getRequestedUserContext } from "../lib/user-context";
import { isTerminalRunStatus } from "../workflow-executor/run-status";
import {
  insertRunRecord,
  listRunRecords,
  loadRunRecord,
  markRunStopped,
  setRunStatus,
  softDeleteRunRecord,
} from "../workflow-executor/run-store";
import type { ReclaimDeploymentFn } from "../services/workflow-deploy";
import { validateResumePayload } from "../workflow-executor/resume-payload-registry";
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
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "./workflow-runs";

const log = getLogger(["api", "workflow-run-records"]);

const StartBody = type({ "input?": "unknown" });
const ResumeBody = type({ signalName: "string", "payload?": "unknown" });

// The thin run-INDEX response (CL-2669): run-level identity + coarse status.
// Per-step state (phase / outputs / errors) is read separately from the log via
// GET /workflow-exec/runs/:runId/state.
const RunStateResponse = type({
  runId: "string",
  kind: "string",
  status: "'running'|'awaiting'|'completed'|'failed'",
  "deploymentId?": "string",
});

const ErrorResponse = type({ error: "string" });
const ArchiveResponse = type({ archived: "true" });

function mintRunId(): string {
  return `wfr_${randomBytes(16).toString("hex")}`;
}

// Resolve the most-specific deployment of `kind` visible along the user's
// tenant chain (active workbench shadows inherited globals; ties break on
// recency). Mirrors the native start route's shadowing rule.
async function resolveDeployment(
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
function assertRunOwnership(
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

function stateResponse(state: {
  runId: string;
  kind: string;
  status: "running" | "awaiting" | "completed" | "failed";
  deploymentId?: string;
}): {
  runId: string;
  kind: string;
  status: string;
  deploymentId?: string;
} {
  return {
    runId: state.runId,
    kind: state.kind,
    status: state.status,
    ...(state.deploymentId !== undefined
      ? { deploymentId: state.deploymentId }
      : {}),
  };
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
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No deployment",
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

      const kind = c.req.param("kind");
      const chain = await getAncestorChain(deps.db, context.tenantId);
      // The registry row resolves the kind's tenant + deploy principal; its
      // deploymentId is the operator's shared deployment and is NOT reused —
      // each run gets its own (per-run deployment, CL-2582).
      const definition = await resolveDeployment(deps.db, chain, kind);
      if (!definition)
        return c.json({ error: `no deployed workflow of kind "${kind}"` }, 404);

      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = StartBody(body);
      const input = parsed instanceof type.errors ? {} : (parsed.input ?? {});

      // Mint the runId here and thread it to the sidecar as the trigger mail's
      // messageId. The supervisor derives the run's id from the message id, so
      // the seeded row and every run event the sidecar emits share this id — the
      // projection bridge folds those events back into this exact row.
      const runId = mintRunId();

      // A freshly-deployed supervisor is routable by construction, so the start
      // path needs no ensureDeploymentRoutable (resume still does — a parked run's
      // deployment can lose its address to a restart).
      let deploymentId: string;
      try {
        ({ deploymentId } = await deps.provisionRunDeployment({
          kind,
          tenantId: definition.tenantId,
          creatorPrincipalId: definition.principalId,
        }));
      } catch (err) {
        log.error("workflow run provision failed", {
          runId,
          kind,
          tenantId: definition.tenantId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to provision workflow run" }, 500);
      }

      const state = await insertRunRecord(deps.db, {
        runId,
        deploymentId,
        kind,
        tenantId: definition.tenantId,
        principalId: context.principalId,
        input,
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
          content: JSON.stringify(input),
          sessionId: randomUUID(),
          tenantId: definition.tenantId,
          cryptoProvider: deps.cryptoProvider,
        });
      } catch (err) {
        log.error("workflow run-start failed", {
          runId,
          kind,
          deploymentId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        await setRunStatus(deps.db, runId, "failed");
        return c.json({ error: "failed to start workflow run" }, 500);
      }

      // Return the seeded row immediately (status 'running'); the UI polls it and
      // the projection bridge advances it as the sidecar emits run events.
      return c.json(stateResponse(state));
    },
  );

  router.get(
    "/workflow-exec/records",
    describeRoute({
      tags: ["Workflows"],
      summary: "List thin-executor workflow runs",
      description:
        "Lists the run records visible to the user along the tenant chain. Optional `?kind=` filters.",
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
      const rows = await listRunRecords(
        deps.db,
        chain,
        context.principalId,
        c.req.query("kind"),
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

      // Validate the gate payload at the trust boundary for workflows/signals
      // that register a schema; unregistered ones pass through untouched.
      const payloadCheck = validateResumePayload(
        state.kind,
        parsed.signalName,
        parsed.payload ?? {},
      );
      if (!payloadCheck.ok) {
        return c.json(
          { error: `invalid resume payload: ${payloadCheck.error}` },
          400,
        );
      }

      if (state.deploymentId === undefined) {
        return c.json({ error: "run has no deployment to signal" }, 400);
      }

      // The run owns its single-use deployment (`state.deploymentId`) — a per-run
      // deployment writes NO `workflow_run` registry row, so we must NOT look it
      // up there. Recover only the deploy principal (needed to revive the
      // supervisor's rows if a restart dropped it) from the kind's registry row,
      // exactly as start does; a kind with no active deployment can't be resumed.
      const definition = await resolveDeployment(deps.db, chain, state.kind);
      if (!definition)
        return c.json({ error: "workflow deployment not found" }, 404);

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
          signalName: parsed.signalName,
          signalId: randomUUID(),
          payload: parsed.payload ?? {},
        });
      } catch (err) {
        log.error("workflow resume signal failed", {
          runId,
          signalName: parsed.signalName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to deliver signal" }, 500);
      }

      // Optimistically clear the gate so the UI resumes polling — a row in
      // 'awaiting' pauses the poll. The projection bridge advances it as the
      // sidecar emits the next StepStarted/StepCompleted/RunCompleted.
      await setRunStatus(deps.db, state.runId, "running");
      return c.json(stateResponse({ ...state, status: "running" }));
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
