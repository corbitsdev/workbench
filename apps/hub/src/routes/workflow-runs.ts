import { and, eq, inArray } from "drizzle-orm";
import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { streamSSE } from "hono/streaming";
import { subscribeKind } from "@workbench/hub-sessions";
import type {
  Principal,
  RepoId,
  RepoStore,
  SessionService,
  SidecarRouter,
} from "@workbench/hub-sessions";
import { createWorkflowRunBlobSubstrate } from "@intx/workflow-host";
import type { CryptoProvider } from "@intx/types/runtime";
import { getLogger } from "@intx/log";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { getAncestorChain } from "@intx/db";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { acceptGateSignal } from "../workflow-executor/run-exec";
import { getRequestedUserContext } from "../lib/user-context";
import {
  isWorkflowRunDeniedForTenant,
  listRunnableWorkflowDeployments,
} from "../lib/workflow-run-gate";

export {
  listRunnableWorkflowDeployments,
  listRunnableWorkflowKinds,
} from "../lib/workflow-run-gate";
import { requestBodySchema } from "../lib/openapi";
import { WorkflowMeta } from "../lib/workflow-meta";
import type { WorkflowRunStarter } from "../services/workflow-run-starter";

// User-facing read/control surface over natively-deployed workflows.
// The hub indexes each deployment in `workflow_run` at deploy time; these
// routes list that index, tail the workflow-run event log over SSE, deliver
// signals, and start runs. Mounted on the v1 (user-session) router.

// All @intx/workflow on-disk event `type` discriminator values. subscribeKind
// filters committed event blobs against this set (the blobs store the
// state-machine `kind` under the field name `type`; see
// @intx/workflow-host adapters/repo-store.ts workflowEventToOnDisk).
const WORKFLOW_EVENT_TYPES: readonly string[] = [
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

// Passthrough validator: subscribeKind narrows each blob through this before
// yielding. The state machine owns the full 17-variant narrow; here we only
// assert the on-disk envelope shape (a string `type` discriminator + seq).
const WorkflowEventBlob = type({
  type: "string",
  seq: "number",
  "+": "ignore",
});

// On-disk `StepCompleted` envelope. The repo-store adapter writes events as
// `{ seq, type, ...rest }` (the state-machine `kind` becomes `type`); a
// completed step carries its `stepId` and `output.ref`. We narrow only the
// fields we read so an envelope-shape drift surfaces loudly at the boundary.
const StepCompletedBlob = type({
  type: "'StepCompleted'",
  stepId: "string",
  output: { ref: "string" },
  "+": "ignore",
});

const HUB_PRINCIPAL: Principal = { kind: "hub" };
const RUN_EVENT_REF = "refs/heads/main";

// Derive the workflow-run repo id the sidecar's multi-step supervisor writes
// (and packs) run events under. The sidecar does NOT key the workflow-run repo
// by the raw `ses_<id>` deploymentId — its deploy router uses the
// SUBSTRATE-SAFE SLUG of the deployment's mail address
// (`deriveTrivialDeploymentId(agentAddress)` in
// apps/sidecar/src/workflow-host-wiring.ts), which replaces every character
// outside /[a-zA-Z0-9_-]/ with `-` so the id satisfies the substrate's
// SAFE_REPO_ID contract. e.g. `ins_ses_<id>@abklabs.com` -> `ins_ses_<id>-abklabs-com`.
// The hub indexes deployments by the raw `ses_<id>` (the DB column, the FE id,
// the route param), so every read against the run-event log MUST translate to
// the slug or the log appears permanently empty. This MUST stay in lockstep
// with the sidecar's `deriveTrivialDeploymentId`.
export function deriveWorkflowRunRepoId(args: {
  deploymentId: string;
  deploymentDomain: string;
}): string {
  return deriveDeploymentAddress(args).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

// WORKBENCH-LOCAL (CL-4231): shared helper for the three route handlers
// below that need a `workflow-run` `repoId`. Annotated with the closed
// literal kind (not the widened `RepoId` from `@workbench/hub-sessions`)
// because this repoId is passed to `createWorkflowRunBlobSubstrate`
// (upstream `@intx/workflow-host`, untouched), which still expects the
// closed wire `RepoId` shape. This kind is always the hardcoded
// `"workflow-run"` literal, never derived from the registered kind set,
// so it is genuinely safe — unlike the `resolveAttachment` cast in
// `session-service.ts`, which derives its kind from a DB row and does
// need a runtime guard.
function workflowRunRepoId(args: {
  deploymentId: string;
  deploymentDomain: string;
}): { kind: "workflow-run"; id: string } {
  return { kind: "workflow-run", id: deriveWorkflowRunRepoId(args) };
}

const log = getLogger(["api", "workflow-runs"]);

const SignalBody = type({
  runId: "string > 0",
  signalName: "string > 0",
  payload: "unknown",
});

// The run trigger payload — any JSON object; passed to the workflow's first step.
const StartRunBody = type({ "+": "ignore" });

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover these operations and validate their responses; these schemas
// document (they do not replace) the handler's existing manual validation.
const WorkflowRunSummary = type({
  deploymentId: "string",
  kind: "string",
  status: "string",
  createdAt: "unknown",
  // Deploy-time provenance (CL-2321); null for deployments that predate capture.
  "meta?": WorkflowMeta.or("null"),
});
const WorkflowRunList = WorkflowRunSummary.array();
const StepOutputResponse = type({ stepId: "string", output: "unknown" });
const AllStepOutputsResponse = type({ outputs: "unknown" });
const SignalAcceptedResponse = type({ accepted: "boolean" });
const StartRunResponse = type({ deploymentId: "string", accepted: "boolean" });
const ErrorResponse = type({ error: "string" });

// Re-establish a deployment's supervisor if the hub has lost its routable
// address (hub/sidecar restart). Pre-bound in index.ts over deploymentDomain +
// hubPublicKey; idempotent (a no-op when already routable) and coalesced per
// deploymentId in the deploy service. The start/signal handlers await it before
// delivering so a run never dead-ends on `agent is unreachable`.
export type EnsureDeploymentRoutableFn = (args: {
  deploymentId: string;
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
}) => Promise<{ reestablished: boolean }>;

// Provision a fresh, single-use deployment for ONE workflow run (per-run
// deployment, CL-2582): read the kind's published definition, resolve a fresh
// deploymentId + config, and deploy the supervisor + steps. Pre-bound in
// index.ts over deploymentDomain + hubPublicKey. The run-start handler awaits it
// and triggers the returned deployment, which is torn down when the run reaches
// a terminal status.
export type ProvisionRunDeploymentFn = (args: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
}) => Promise<{ deploymentId: string }>;

// Shared helper: replay the run-event log once and collect every StepCompleted
// entry as `{ stepId, outputRef, runId }`. Callers can filter or resolve refs
// as needed. Returns the discovered runId (from the first event) alongside the
// collected steps. Aborts the subscription on return.
async function collectCompletedSteps(
  repoStore: RepoStore,
  repoId: RepoId,
): Promise<{
  runId: string | null;
  steps: { stepId: string; outputRef: string; runId: string }[];
}> {
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
      kinds: WORKFLOW_EVENT_TYPES,
    },
  );

  // `subscribeKind` is a live tail with no end-of-backlog signal: it replays the
  // backlog from {seq:0} then blocks waiting for the next event forever. A
  // one-shot read must stop once the backlog is drained — otherwise a parked
  // HITL run (awaiting a human signal, so no further events arrive) hangs this
  // endpoint indefinitely, which deadlocks the UI that needs step-1 output to
  // collect that very signal. Backlog events replay from local disk in sub-ms,
  // so a >200ms idle gap means we've caught up (run parked or done) and it is
  // safe to stop. (CL-2233: the step-output read must never hang on a live run.)
  // Lockstep with projection-bridge.ts BACKLOG_IDLE_MS; if one moves, move both
  // (lowered 1000 → 200 in CL-2244 to cut per-step latency).
  const BACKLOG_IDLE_MS = 200;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => abort.abort(), BACKLOG_IDLE_MS);
  };

  let firstRunId: string | null = null;
  const steps: { stepId: string; outputRef: string; runId: string }[] = [];
  try {
    armIdle();
    for await (const entry of iter) {
      armIdle();
      if (firstRunId === null) firstRunId = entry.runId;
      if (entry.event.type !== "StepCompleted") continue;
      const completed = StepCompletedBlob(entry.event);
      if (completed instanceof type.errors) {
        throw new Error(`malformed StepCompleted event: ${completed.summary}`);
      }
      steps.push({
        stepId: completed.stepId,
        outputRef: completed.output.ref,
        runId: entry.runId,
      });
    }
  } catch (err) {
    // The idle-timeout aborts the subscription to end the backlog drain; that
    // surfaces as an abort error on the iterator — expected, not a failure.
    if (!abort.signal.aborted) throw err;
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    abort.abort();
  }
  return { runId: firstRunId, steps };
}

export function createWorkflowRunsRouter(deps: {
  db: HubDb;
  repoStore: RepoStore;
  sidecarRouter: SidecarRouter;
  sessionService: SessionService;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  runStarter: WorkflowRunStarter;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const { repoStore } = deps;

  router.get(
    "/workflow-runs",
    describeRoute({
      tags: ["Workflows"],
      summary: "List workflow deployments",
      description:
        "Lists workflow deployments visible to the calling user — the active workbench plus any inherited from ancestor tenants — omitting kinds denied by the member run gate. Optional `?tenantId=` selects a workbench the user belongs to; default is the active workbench.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Workflow deployments visible to the user",
          content: {
            "application/json": { schema: resolver(WorkflowRunList) },
          },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      // Walk active workbench -> ... -> global so a workbench sees its own
      // deployments plus those inherited from any ancestor tenant.
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const runnable = await listRunnableWorkflowDeployments(deps.db, chain);
      return c.json(runnable);
    },
  );

  router.get(
    "/workflow-runs/:deploymentId/stream",
    describeRoute({
      tags: ["Workflows"],
      summary: "Stream workflow-run events",
      description:
        "Server-Sent Events stream of a deployment's workflow-run event log, tailed from seq 0 and kept open for live events. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "deploymentId",
          in: "path",
          required: true,
          description: "Deployment id of the workflow run to tail.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Server-Sent Events stream of workflow-run events",
          content: { "text/event-stream": {} },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Workflow deployment not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const deploymentId = c.req.param("deploymentId");
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const owned = await deps.db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.deploymentId, deploymentId),
          inArray(workflowRun.tenantId, chain),
        ),
      });
      if (!owned)
        return c.json({ error: "Workflow deployment not found" }, 404);

      const repoId = workflowRunRepoId({
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
      });

      return streamSSE(c, async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());

        const iter = subscribeKind(
          repoStore,
          HUB_PRINCIPAL,
          repoId,
          RUN_EVENT_REF,
          WorkflowEventBlob,
          {
            signal: abort.signal,
            from: { seq: 0 },
            kinds: WORKFLOW_EVENT_TYPES,
          },
        );

        try {
          for await (const entry of iter) {
            await stream.writeSSE({
              data: JSON.stringify({
                seq: entry.seq,
                runId: entry.runId,
                event: entry.event,
              }),
            });
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            log.error("workflow-run event stream failed", {
              deploymentId,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      });
    },
  );

  router.get(
    "/workflow-runs/:deploymentId/steps/:stepId/output",
    describeRoute({
      tags: ["Workflows"],
      summary: "Get a completed step output",
      description:
        "Replays the deployment's workflow-run event log to find the requested step's StepCompleted output and resolves it from the run's blob substrate. Returns 404 if the step has not completed. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "deploymentId",
          in: "path",
          required: true,
          description: "Deployment id of the workflow run.",
          schema: { type: "string" },
        },
        {
          name: "stepId",
          in: "path",
          required: true,
          description: "Id of the step whose output to read.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Resolved step output",
          content: {
            "application/json": { schema: resolver(StepOutputResponse) },
          },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Workflow deployment not found, or no completed step output found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description:
            "Failed to read the event log or resolve the step output",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const deploymentId = c.req.param("deploymentId");
      const stepId = c.req.param("stepId");
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const owned = await deps.db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.deploymentId, deploymentId),
          inArray(workflowRun.tenantId, chain),
        ),
      });
      if (!owned)
        return c.json({ error: "Workflow deployment not found" }, 404);

      const repoId = workflowRunRepoId({
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
      });

      // Replay the run's append-only event log to find the StepCompleted for the
      // requested step. A bounded log that drains without yielding the step means
      // the step has not completed → 404.
      let steps: { stepId: string; outputRef: string; runId: string }[];
      let runId: string | null;
      try {
        ({ steps, runId } = await collectCompletedSteps(repoStore, repoId));
      } catch (err) {
        log.error("workflow step output replay failed", {
          deploymentId,
          stepId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to read workflow event log" }, 500);
      }

      const match = steps.find((s) => s.stepId === stepId);
      const outputRef = match?.outputRef ?? null;
      if (match) runId = match.runId;

      if (outputRef === null || runId === null) {
        return c.json({ error: "no completed step output found" }, 404);
      }

      // Resolve the ref against the same blob substrate the workflow child wrote
      // it with: a per-run BlobSubstrate over the hub's repoStore. `inline:` refs
      // resolve from the ref body alone; `blob:` refs read bytes from the
      // workflow-run repo dir keyed by runId. (See @intx/workflow-host
      // createWorkflowRunBlobSubstrate({ substrate, repoId, principal, runId, ref }).)
      const blobs = createWorkflowRunBlobSubstrate({
        substrate: repoStore,
        repoId,
        principal: HUB_PRINCIPAL,
        runId,
        ref: RUN_EVENT_REF,
      });
      let output: unknown;
      try {
        output = await blobs.resolveRef(outputRef);
      } catch (err) {
        log.error("workflow step output resolution failed", {
          deploymentId,
          stepId,
          runId,
          outputRef,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to resolve workflow step output" }, 500);
      }

      return c.json({ stepId, output });
    },
  );

  router.get(
    "/workflow-runs/:deploymentId/steps",
    describeRoute({
      tags: ["Workflows"],
      summary: "Get all completed step outputs in one replay",
      description:
        "Replays the deployment's workflow-run event log ONCE and returns every completed step's resolved output as a map. Avoids the N-parallel per-step replays the individual step-output endpoint requires. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "deploymentId",
          in: "path",
          required: true,
          description: "Deployment id of the workflow run.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description:
            "Map of stepId → resolved output for every completed step",
          content: {
            "application/json": { schema: resolver(AllStepOutputsResponse) },
          },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Workflow deployment not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Failed to read the event log or resolve step outputs",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const deploymentId = c.req.param("deploymentId");
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const owned = await deps.db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.deploymentId, deploymentId),
          inArray(workflowRun.tenantId, chain),
        ),
      });
      if (!owned)
        return c.json({ error: "Workflow deployment not found" }, 404);

      const repoId = workflowRunRepoId({
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
      });

      let steps: { stepId: string; outputRef: string; runId: string }[];
      let runId: string | null;
      try {
        ({ steps, runId } = await collectCompletedSteps(repoStore, repoId));
      } catch (err) {
        log.error("workflow all-steps replay failed", {
          deploymentId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to read workflow event log" }, 500);
      }

      if (steps.length === 0 || runId === null) {
        return c.json({ outputs: {} });
      }

      // All completed steps share the same runId (the latest run). Build a
      // BlobSubstrate once and resolve all refs in parallel.
      const blobs = createWorkflowRunBlobSubstrate({
        substrate: repoStore,
        repoId,
        principal: HUB_PRINCIPAL,
        runId,
        ref: RUN_EVENT_REF,
      });

      let outputs: Record<string, unknown>;
      try {
        const resolved = await Promise.all(
          steps.map(async (s) => {
            const output = await blobs.resolveRef(s.outputRef);
            return [s.stepId, output] as const;
          }),
        );
        outputs = Object.fromEntries(resolved);
      } catch (err) {
        log.error("workflow all-steps output resolution failed", {
          deploymentId,
          runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json(
          { error: "failed to resolve workflow step outputs" },
          500,
        );
      }

      return c.json({ outputs });
    },
  );

  router.post(
    "/workflow-runs/:deploymentId/signal",
    describeRoute({
      tags: ["Workflows"],
      summary: "Send a signal to a workflow run",
      description:
        "Delivers a signal to a deployment's running workflow via the sidecar router. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "deploymentId",
          in: "path",
          required: true,
          description: "Deployment id of the workflow run to signal.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        description:
          "Signal envelope: target `runId`, `signalName`, and opaque `payload`.",
        content: {
          "application/json": { schema: requestBodySchema(SignalBody) },
        },
      },
      responses: {
        202: {
          description: "Signal accepted for delivery",
          content: {
            "application/json": { schema: resolver(SignalAcceptedResponse) },
          },
        },
        400: {
          description: "Invalid JSON or signal body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Workflow deployment not found, or the run does not belong to it",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description:
            "The run is not parked on an open gate for the named signal",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Failed to deliver the signal",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const deploymentId = c.req.param("deploymentId");
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const owned = await deps.db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.deploymentId, deploymentId),
          inArray(workflowRun.tenantId, chain),
        ),
      });
      if (!owned)
        return c.json({ error: "Workflow deployment not found" }, 404);

      let rawSignal: unknown;
      try {
        rawSignal = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      const body = SignalBody(rawSignal);
      if (body instanceof type.errors) {
        return c.json({ error: `invalid signal: ${body.summary}` }, 400);
      }

      try {
        // Guarded durable acceptance: the run must belong to THIS authorized
        // deployment and be parked on an open gate for the named signal
        // before the pending-signal record (a reconciler-actionable durable
        // rail) is persisted; then the signal is dispatched. See
        // `acceptGateSignal` for the ordering contract.
        const result = await acceptGateSignal(
          {
            db: deps.db,
            repoStore: deps.repoStore,
            sidecarRouter: deps.sidecarRouter,
            deploymentDomain: deps.deploymentDomain,
            ensureDeploymentRoutable: deps.ensureDeploymentRoutable,
          },
          {
            deploymentId,
            kind: owned.kind,
            tenantId: owned.tenantId,
            creatorPrincipalId: owned.principalId,
            runId: body.runId,
            signalName: body.signalName,
            payload: body.payload,
          },
        );
        if (!result.ok) {
          return c.json(
            { error: result.error },
            result.status as 404 | 409 | 500,
          );
        }
      } catch (err) {
        log.error("workflow signal delivery failed", {
          deploymentId,
          runId: body.runId,
          signalName: body.signalName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "failed to deliver signal" }, 500);
      }

      return c.json({ accepted: true }, 202);
    },
  );

  router.post(
    "/workflow-runs/:kind/start",
    describeRoute({
      tags: ["Workflows"],
      summary: "Start a workflow run",
      description:
        "Starts a run of the most-specific deployment of the given kind visible to the user, delivering the request body as the trigger message. The new run surfaces on the SSE stream. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "kind",
          in: "path",
          required: true,
          description: "Workflow kind to start a run of.",
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        description:
          "Trigger payload — any JSON object; passed to the workflow's first step.",
        content: {
          "application/json": { schema: requestBodySchema(StartRunBody) },
        },
      },
      responses: {
        202: {
          description: "Run start accepted",
          content: {
            "application/json": { schema: resolver(StartRunResponse) },
          },
        },
        400: {
          description: "Invalid JSON or trigger input",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No deployed workflow of the given kind",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        429: {
          description:
            "Too many workflow run starts for this workbench in the current window",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Failed to start the workflow run",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const kind = c.req.param("kind");
      const chain = await getAncestorChain(deps.db, context.tenantId);

      // Owner-controlled run gate (CL-2885). Allow-by-default; blocked only by an
      // explicit member-role deny for this kind on the workbench or an ancestor.
      if (await isWorkflowRunDeniedForTenant(deps.db, chain, kind)) {
        return c.json(
          { error: "This workflow is disabled for your workbench" },
          403,
        );
      }

      // A run begins when the deployment's mail address receives a message: the
      // supervisor enqueues it and forwards a trigger.fire to the workflow child.
      // We deliver the request body as that trigger message; the new run surfaces
      // on the SSE stream (the client reads its runId from RunStarted).
      let rawInput: unknown;
      try {
        rawInput = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      const input = StartRunBody(rawInput);
      if (input instanceof type.errors) {
        return c.json({ error: `invalid input: ${input.summary}` }, 400);
      }

      const result = await deps.runStarter.startRun({
        kind,
        tenantId: context.tenantId,
        input,
        chain,
      });
      if (!result.ok && result.reason === "not_found") {
        return c.json({ error: result.message }, 404);
      }
      if (!result.ok && result.reason === "rate_limited") {
        return c.json({ error: result.message }, 429);
      }
      if (!result.ok) {
        return c.json({ error: "failed to start workflow run" }, 500);
      }
      return c.json({ deploymentId: result.deploymentId, accepted: true }, 202);
    },
  );

  return router;
}
