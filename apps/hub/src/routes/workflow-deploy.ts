import { and, eq, inArray, isNull, like, ne } from "drizzle-orm";
import { type } from "arktype";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import { authorize } from "@intx/authz";
import type { GrantStore } from "@intx/authz";
import type { SessionService } from "@intx/hub-sessions";
import type { WorkflowDefinition } from "@intx/workflow";
import { workflowDefinitionEnvelopeSchema } from "@intx/hub-sessions";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { getRequestedUserContext } from "../lib/user-context";
import { ensureGlobalMember } from "../lib/tenant-provisioning";
import type { WorkflowDeployService } from "../services/workflow-deploy";
import { resolveWorkflowDeployConfig } from "../services/workflow-deploy-config";
import { requestBodySchema } from "../lib/openapi";
import { WorkflowMeta } from "../lib/workflow-meta";

const log = getLogger(["api", "workflow-deploy"]);

// The capability grant a caller must hold to deploy a workflow over the
// session path, mirroring Interchange's native admin grammar (`agent:*` /
// `create`, `credential:*` / `create`). The global owner role's `*:*` grant
// satisfies it, so an owner session deploys workflows the same way it creates
// agents and credentials.
const WORKFLOW_DEPLOY_RESOURCE = "workflow:*";
const WORKFLOW_DEPLOY_ACTION = "create";

// Shared deploy dependencies, independent of how the request is authorized.
export interface WorkflowDeployCoreDeps {
  db: HubDb;
  workflowDeployService: WorkflowDeployService;
  // Tears down a deployment's sidecar supervisor + step agents on redeploy
  // supersede and on DELETE. `endSession(address, reason)` sends the
  // `agent.undeploy` frame the sidecar's deploy router routes to
  // `supervisor.shutdown()`.
  sessionService: SessionService;
  hubPublicKey: string;
  deploymentDomain: string;
  globalTenantId: string;
}

// Tear down a workflow deployment's runtime: undeploy the sidecar supervisor
// and soft-stop every backing `agent_instance` row (the deployment supervisor
// `ins_<deploymentId>@<domain>` plus each step `ins_<deploymentId>-<stepId>@…`).
//
// The sidecar's deploy router keys its `undeploy` hook on the supervisor's
// deployment address; that hook runs `supervisor.shutdown()`, which kills the
// workflow-child process and unregisters the deployment's mail/signal/drain
// routes. Step "agents" are logical addresses inside that supervisor, not
// separate sidecar deployments, so undeploying the supervisor address is the
// sufficient sidecar teardown. We still soft-stop the per-step DB instance rows
// (mirroring the agent-instance DELETE handler) so they leave the active set
// and the sidecar will not try to re-register them on reconnect, and we best-
// effort `endSession` each step address — a no-op on the sidecar today, but
// correct if step agents ever become routable.
//
// Best-effort by contract: callers (supersede + DELETE) must not let a teardown
// failure fail the request; every step logs and continues.
export async function tearDownDeployment(deps: {
  db: HubDb;
  sessionService: SessionService;
  deploymentDomain: string;
  deploymentId: string;
  tenantId: string;
  reason: string;
}): Promise<void> {
  const { db, deploymentId, deploymentDomain } = deps;
  const supervisorAddress = deriveDeploymentAddress({
    deploymentId,
    deploymentDomain,
  });

  // All backing instance rows for this deployment: the supervisor address and
  // every step address. Step addresses are `ins_<deploymentId>-<stepId>@<domain>`,
  // so a prefix match on `ins_<deploymentId>` within the tenant collects both
  // without re-parsing the workflow definition. `_` and `%` do not appear in a
  // `ses_…` deploymentId, so no LIKE escaping is required.
  const instances = await db.query.agentInstance.findMany({
    where: and(
      eq(intxSchema.agentInstance.tenantId, deps.tenantId),
      like(intxSchema.agentInstance.address, `ins_${deploymentId}%`),
    ),
    columns: { id: true, address: true },
  });

  // Undeploy each routable address. The supervisor address is always included
  // (its instance row exists from deploy); step addresses are harmless no-ops.
  const addresses = new Set<string>([supervisorAddress]);
  for (const instance of instances) addresses.add(instance.address);
  for (const address of addresses) {
    await deps.sessionService.endSession(address, deps.reason).catch((err) => {
      log.warn("workflow deployment teardown: endSession failed", {
        deploymentId,
        address,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Soft-stop the instance rows so they leave the active set and the sidecar
  // does not re-register them on reconnect (endedAt is now set).
  const instanceIds = instances.map((instance) => instance.id);
  if (instanceIds.length > 0) {
    const now = new Date();
    await db
      .update(intxSchema.agentInstance)
      .set({ status: "stopped", endedAt: now, updatedAt: now })
      .where(inArray(intxSchema.agentInstance.id, instanceIds));
  }
}

// Supersede every prior active deployment of `(kind, tenantId)` other than the
// just-created one: mark each `deletedAt = now` and tear it down. A teardown
// failure on one old deployment is logged and does not block superseding the
// rest — the caller already guards the whole call so the new deploy survives.
export async function supersedePriorDeployments(deps: {
  db: HubDb;
  sessionService: SessionService;
  deploymentDomain: string;
  kind: string;
  tenantId: string;
  newDeploymentId: string;
}): Promise<void> {
  const priors = await deps.db.query.workflowRun.findMany({
    where: and(
      eq(workflowRun.kind, deps.kind),
      eq(workflowRun.tenantId, deps.tenantId),
      isNull(workflowRun.deletedAt),
      ne(workflowRun.deploymentId, deps.newDeploymentId),
    ),
    columns: { id: true, deploymentId: true },
  });

  for (const prior of priors) {
    if (!prior.deploymentId) continue;
    const now = new Date();
    await deps.db
      .update(workflowRun)
      .set({ deletedAt: now, status: "superseded", updatedAt: now })
      .where(eq(workflowRun.id, prior.id));
    await tearDownDeployment({
      db: deps.db,
      sessionService: deps.sessionService,
      deploymentDomain: deps.deploymentDomain,
      deploymentId: prior.deploymentId,
      tenantId: deps.tenantId,
      reason: `superseded by deployment ${deps.newDeploymentId}`,
    }).catch((err) => {
      log.warn("workflow supersede teardown failed for prior deployment", {
        kind: deps.kind,
        tenantId: deps.tenantId,
        priorDeploymentId: prior.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover this operation and validate its responses; these schemas document
// (they do not replace) the handler's existing manual validation.
const WorkflowDeployResponse = type({
  kind: "string",
  deploymentId: "string",
  result: "unknown",
});
const ErrorResponse = type({ error: "string" });

// Hono middleware that authorizes the session caller to deploy a workflow via
// Interchange's native grant model: resolve the caller's global principal, then
// `authorize` against `workflow:*`/`create`. Fail-closed (403) on anything but
// an explicit allow. Used on the session-authenticated `/api/v1/workflows/deploy`
// route, where an upstream middleware has already set `userId`.
export function createWorkflowDeployGrantGuard(deps: {
  db: HubDb;
  grantStore: GrantStore;
  globalTenantId: string;
}): MiddlewareHandler<{ Variables: { userId: string } }> {
  return async (c, next) => {
    const userId = c.get("userId");
    const { principalId } = await ensureGlobalMember(deps.db, { userId });
    const result = await authorize(
      deps.grantStore,
      principalId,
      deps.globalTenantId,
      WORKFLOW_DEPLOY_RESOURCE,
      WORKFLOW_DEPLOY_ACTION,
    );
    if (result.effect !== "allow") {
      log.info("workflow deploy denied", {
        principalId,
        effect: result.effect ?? "no_match",
      });
      return c.json(
        { error: "You do not have permission to deploy workflows" },
        403,
      );
    }
    return next();
  };
}

// The deploy handler body, independent of the auth path. Validates the posted
// @intx/workflow definition, resolves the tenant deploy config, and hands it to
// the orchestrator, which commits the definition to its git-backed `workflow`
// repo and launches the steps. The hub imports no workflow code. See
// docs/DEPLOYING_WORKFLOWS.md.
export function deployWorkflowHandler(
  deps: WorkflowDeployCoreDeps,
): (c: Context) => Promise<Response> {
  return async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const definition = workflowDefinitionEnvelopeSchema(rawBody);
    if (definition instanceof type.errors) {
      return c.json(
        { error: `invalid workflow definition: ${definition.summary}` },
        400,
      );
    }

    // Optional target tenant. Default (no `?tenant=`) → the global org tenant,
    // unchanged. A non-global target must be the global tenant or a descendant
    // of it — Interchange resolves catalog/credentials down the hierarchy, so a
    // sub-tenant deploy lands collateral scoped to that workbench only.
    const targetSlug = c.req.query("tenant");
    let targetTenantId = deps.globalTenantId;
    if (targetSlug !== undefined && targetSlug !== "") {
      const targetTenant = await deps.db.query.tenant.findFirst({
        where: eq(intxSchema.tenant.slug, targetSlug),
        columns: { id: true },
      });
      if (!targetTenant) {
        return c.json({ error: `unknown target tenant: ${targetSlug}` }, 404);
      }
      const ancestors = await getAncestorChain(deps.db, targetTenant.id);
      if (!ancestors.includes(deps.globalTenantId)) {
        return c.json(
          {
            error: `target tenant ${targetSlug} is not the global tenant or a descendant`,
          },
          403,
        );
      }
      targetTenantId = targetTenant.id;
    }

    // Deploying principal: a user principal of the target tenant. Per-step
    // execution principals are derived by the orchestrator.
    const owner = await deps.db.query.principal.findFirst({
      where: and(
        eq(intxSchema.principal.tenantId, targetTenantId),
        eq(intxSchema.principal.kind, "user"),
      ),
    });
    if (!owner) {
      return c.json(
        { error: "no deploying principal in the target tenant" },
        409,
      );
    }

    try {
      const { deploymentId, config, deployContent } =
        await resolveWorkflowDeployConfig({
          db: deps.db,
          tenantId: targetTenantId,
          principalId: owner.id,
          deploymentDomain: deps.deploymentDomain,
        });

      const result = await deps.workflowDeployService.deployWorkflow({
        // Validated envelope; the orchestrator (deployWorkflow → validateWorkflowDefinition)
        // re-runs full definition validation before launch.
        workflow: definition as WorkflowDefinition,
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
        tenantId: targetTenantId,
        creatorPrincipalId: owner.id,
        config,
        deployContent,
        hubPublicKey: deps.hubPublicKey,
      });

      // Parse optional deploy-time meta (version, sha, deployedAt) from the
      // query param the deploy-workflow CLI sends. Absent or malformed → null.
      let deployMeta: typeof WorkflowMeta.infer | null = null;
      const rawMeta = c.req.query("meta");
      if (rawMeta !== undefined && rawMeta !== "") {
        try {
          const parsed = WorkflowMeta(JSON.parse(rawMeta));
          if (!(parsed instanceof type.errors)) {
            deployMeta = parsed;
          }
        } catch {
          // ignore — old callers won't send meta
        }
      }

      // Index the deployment so the user-facing /workflow-runs routes can list it
      // by tenant without re-walking the workflow-run repos.
      await deps.db.insert(workflowRun).values({
        deploymentId,
        tenantId: targetTenantId,
        principalId: owner.id,
        kind: definition.id,
        status: "running",
        ...(deployMeta !== null ? { meta: deployMeta } : {}),
      });

      // Redeploy supersedes: the newest deploy of a (kind, tenant) is the only
      // active one. Mark every prior active deployment of this kind in this
      // tenant deleted and tear it down. Best-effort — a supersede failure on an
      // old deployment must never fail the new deploy, so the whole block is
      // guarded and only logs.
      await supersedePriorDeployments({
        db: deps.db,
        sessionService: deps.sessionService,
        deploymentDomain: deps.deploymentDomain,
        kind: definition.id,
        tenantId: targetTenantId,
        newDeploymentId: deploymentId,
      }).catch((err) => {
        log.warn("workflow redeploy supersede failed", {
          kind: definition.id,
          tenantId: targetTenantId,
          newDeploymentId: deploymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json({ kind: definition.id, deploymentId, result });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(
        `workflow deploy failed for kind ${definition.id} in tenant ${targetTenantId}: ${error.message}`,
        { kind: definition.id, tenantId: targetTenantId, error },
      );
      return c.json({ error: "failed to deploy workflow" }, 500);
    }
  };
}

// DELETE handler for `/api/v1/workflows/:deploymentId`, session-authorized and
// gated by the same operator grant guard as the deploy route. Resolves the
// deployment within the caller's tenant ancestor chain (so a user cannot delete
// another tenant's deployment), soft-deletes the `workflow_run` index row, and
// tears down the sidecar supervisor + step instances. Idempotent-ish: a 404 is
// returned for an unknown, other-tenant, or already-deleted deployment.
export function deleteWorkflowHandler(
  deps: Pick<
    WorkflowDeployCoreDeps,
    "db" | "sessionService" | "deploymentDomain"
  >,
): (c: Context<{ Variables: { userId: string } }>) => Promise<Response> {
  return async (c) => {
    const userId = c.get("userId");
    const { context, forbidden } = await getRequestedUserContext(
      deps.db,
      userId,
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Forbidden" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);

    const deploymentId = c.req.param("deploymentId");
    if (!deploymentId) {
      return c.json({ error: "deploymentId is required" }, 400);
    }
    const chain = await getAncestorChain(deps.db, context.tenantId);
    const owned = await deps.db.query.workflowRun.findFirst({
      where: and(
        eq(workflowRun.deploymentId, deploymentId),
        inArray(workflowRun.tenantId, chain),
        isNull(workflowRun.deletedAt),
      ),
      columns: { id: true, tenantId: true },
    });
    if (!owned) return c.json({ error: "Workflow deployment not found" }, 404);

    const now = new Date();
    await deps.db
      .update(workflowRun)
      .set({ deletedAt: now, status: "deleted", updatedAt: now })
      .where(eq(workflowRun.id, owned.id));

    // Best-effort teardown: the row is already soft-deleted (out of the UI),
    // so a sidecar teardown failure must not turn this into a 500. Log and
    // return success — the deployment is gone from the user's perspective.
    await tearDownDeployment({
      db: deps.db,
      sessionService: deps.sessionService,
      deploymentDomain: deps.deploymentDomain,
      deploymentId,
      tenantId: owned.tenantId,
      reason: "operator deleted workflow deployment",
    }).catch((err) => {
      log.warn("workflow delete teardown failed", {
        deploymentId,
        tenantId: owned.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.body(null, 204);
  };
}

// Generic workflow deploy, OPERATOR/machine path. Gated by the sidecar/service
// token (Bearer), not a user session — the sidecar and unattended callers use
// this. The session-authorized operator path is `/api/v1/workflows/deploy`
// (see createWorkflowDeployGrantGuard). Mounted under /api/internal.
export function createWorkflowDeployRouter(
  deps: WorkflowDeployCoreDeps & { serviceToken: string },
): Hono {
  const router = new Hono();

  router.use("/workflows/deploy", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${deps.serviceToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  router.post(
    "/workflows/deploy",
    describeRoute({
      tags: ["Workflows"],
      summary: "Deploy a workflow definition",
      description:
        "Operator-gated (service token). Validates a serialized @intx/workflow definition, resolves the tenant deploy config, and launches it. Optional `?tenant=<slug>` targets the global tenant or a descendant; default is the global tenant.",
      parameters: [
        {
          name: "tenant",
          in: "query",
          required: false,
          description:
            "Target tenant slug (global tenant or a descendant). Omit for the global tenant.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: requestBodySchema(workflowDefinitionEnvelopeSchema),
          },
        },
      },
      responses: {
        200: {
          description: "Workflow deployed",
          content: {
            "application/json": { schema: resolver(WorkflowDeployResponse) },
          },
        },
        400: {
          description: "Invalid JSON or workflow definition",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: "Missing or invalid service token",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Target tenant is not the global tenant or a descendant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Unknown target tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "No deploying principal in the target tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Deploy failed",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    deployWorkflowHandler(deps),
  );

  return router;
}
