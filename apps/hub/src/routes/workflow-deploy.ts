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
import { ensureMember } from "../lib/tenant-provisioning";
import type { WorkflowDeployService } from "../services/workflow-deploy";
import { resolveWorkflowDeployConfig } from "../services/workflow-deploy-config";
import { requestBodySchema } from "../lib/openapi";
import { WorkflowMeta } from "../lib/workflow-meta";
import { loadWorkflowCatalogKinds } from "../lib/workflow-catalog";
import { seedDenyGrantForNewWorkflowKind } from "../lib/workflow-run-gate";
import { escapeLikePattern } from "../lib/like-pattern";

const log = getLogger(["api", "workflow-deploy"]);

// A deploy whose `kind` (the definition id) is not one of the real workflow
// kinds in the build-time embedded catalog. Every `workflow_run` deployment
// index row is written with `kind: definition.id` (the ONLY writer is
// `publishWorkflowDefinition`), and redeploy-supersede only supersedes the same
// `(kind, tenant)`. A junk/unique kind therefore never supersedes, never
// soft-deletes, and its on-disk isogit repos + resident sidecar supervisor are
// never reclaimed — the sidecar-OOM + hub-disk root cause (CL-2811). Rejecting
// the write at the source is what stops the bleed. The autopublish bootstrap
// only ever deploys catalog kinds, so it always passes this guard.
export class NonCatalogWorkflowKindError extends Error {
  constructor(readonly kind: string) {
    super(
      `Refusing to deploy workflow kind "${kind}": it is not in the embedded ` +
        `workflow catalog. Only build-time catalog workflows are deployable ` +
        `(add the definition to apps/hub/generated/workflow-defs to deploy it).`,
    );
    this.name = "NonCatalogWorkflowKindError";
  }
}

// Throw unless `kind` is a real catalog workflow kind. Kept as a small pure
// helper so the boundary is unit-testable without standing up a full deploy.
export function assertDeployableKind(
  kind: string,
  catalogKinds: ReadonlySet<string>,
): void {
  if (!catalogKinds.has(kind)) throw new NonCatalogWorkflowKindError(kind);
}

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
  rootTenantId: string;
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
  // without re-parsing the workflow definition. `deploymentId` is escaped
  // through the shared LIKE helper on the way in — defense in depth even
  // though a `ses_…` id is not expected to carry `%`/`_`/`\`.
  const instances = await db.query.agentInstance.findMany({
    where: and(
      eq(intxSchema.agentInstance.tenantId, deps.tenantId),
      like(
        intxSchema.agentInstance.address,
        `ins_${escapeLikePattern(deploymentId)}%`,
      ),
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

  // Drop the deployment's native `workflow_deployment` projection row so the
  // torn-down deployment's public key can no longer satisfy a reconnect
  // ownership challenge and the tenant's deployment list stays scoped to live
  // deployments. Deleted rather than status-flipped because upstream's status
  // enum ("deployed" | "error") has no terminal value yet — per-run ephemeral
  // deployments need one upstream; until then the delete is the honest
  // equivalent. No-op for pre-native (`ses_`-era) deployment ids, which never
  // had a row.
  await db
    .delete(intxSchema.workflowDeployment)
    .where(eq(intxSchema.workflowDeployment.id, deploymentId));
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
  rootTenantId: string;
}): MiddlewareHandler<{ Variables: { userId: string } }> {
  return async (c, next) => {
    const userId = c.get("userId");
    const { principalId } = await ensureMember(deps.db, {
      tenantId: deps.rootTenantId,
      userId,
    });
    const result = await authorize(
      deps.grantStore,
      principalId,
      deps.rootTenantId,
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

// Thrown when the target tenant has no `user` principal to deploy as. The
// route maps it to 409; the boot bootstrap (CL-2593) treats it as a skip.
export class NoDeployingPrincipalError extends Error {
  constructor(tenantId: string) {
    super(`no deploying principal in tenant ${tenantId}`);
    this.name = "NoDeployingPrincipalError";
  }
}

// Parse the optional deploy-time meta (version, sha, deployedAt, label,
// description). Absent or malformed → null. Shared by the HTTP handler (reads
// it off the `?meta=` query the CLI sends) and the boot bootstrap.
export function parseDeployMeta(
  raw: string | undefined,
): typeof WorkflowMeta.infer | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed = WorkflowMeta(JSON.parse(raw));
    return parsed instanceof type.errors ? null : parsed;
  } catch {
    return null;
  }
}

// Commit a validated workflow definition to the registry and launch it: resolve
// the deploying principal, build the deploy config, hand it to the orchestrator
// (which writes the git-backed `workflow` repo + sends the deploy frames),
// index the `workflow_run` row, and supersede prior deployments of this
// (kind, tenant). Extracted from the HTTP handler so the boot bootstrap
// (CL-2593) can publish embedded defs through the exact same path.
export async function publishWorkflowDefinition(
  deps: WorkflowDeployCoreDeps,
  args: {
    definition: WorkflowDefinition;
    targetTenantId: string;
    deployMeta: typeof WorkflowMeta.infer | null;
  },
): Promise<{
  deploymentId: string;
  result: Awaited<ReturnType<WorkflowDeployService["persistCatalog"]>>;
}> {
  const { definition, targetTenantId, deployMeta } = args;

  // Reject junk kinds at the source (CL-2811). Do this before any sidecar work
  // so a non-catalog deploy leaves no `workflow_run` row, no on-disk repo, and
  // no resident supervisor to leak.
  assertDeployableKind(definition.id, await loadWorkflowCatalogKinds());

  const owner = await deps.db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.tenantId, targetTenantId),
      eq(intxSchema.principal.kind, "user"),
    ),
  });
  if (!owner) throw new NoDeployingPrincipalError(targetTenantId);

  const { deploymentId, config, deployContent } =
    await resolveWorkflowDeployConfig({
      db: deps.db,
      tenantId: targetTenantId,
      principalId: owner.id,
      deploymentDomain: deps.deploymentDomain,
      definition,
    });

  // Hub-only catalog persistence: writes the git `workflow` definition repo +
  // per-step DB/grant rows and sends NO sidecar frame. The supervisor is minted
  // per run by provisionRunDeployment, so publishing never needs a connected
  // sidecar. `deployWorkflow` (with the frame) is reserved for per-run deploys.
  const result = await deps.workflowDeployService.persistCatalog({
    // Validated envelope; the orchestrator (deployWorkflow → validateWorkflowDefinition)
    // re-runs full definition validation before launch.
    workflow: definition,
    deploymentId,
    deploymentDomain: deps.deploymentDomain,
    tenantId: targetTenantId,
    creatorPrincipalId: owner.id,
    config,
    deployContent,
    hubPublicKey: deps.hubPublicKey,
  });

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

  // First-time publish of this (tenant, kind) starts disabled: seed a `deny`
  // grant on the tenant's system member role so the CL-2885 run gate blocks it
  // until an owner explicitly enables it. A kind that already has a grant row
  // (owner-enabled or owner-disabled) is left untouched — this only fills the
  // gap where no toggle has ever been made for the kind.
  await seedDenyGrantForNewWorkflowKind(deps.db, targetTenantId, definition.id);

  // Redeploy supersedes: the newest deploy of a (kind, tenant) is the only
  // active one. Mark every prior active deployment of this kind in this tenant
  // deleted and tear it down. Best-effort — a supersede failure on an old
  // deployment must never fail the new deploy, so the block is guarded.
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

  return { deploymentId, result };
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
    let targetTenantId = deps.rootTenantId;
    if (targetSlug !== undefined && targetSlug !== "") {
      const targetTenant = await deps.db.query.tenant.findFirst({
        where: eq(intxSchema.tenant.slug, targetSlug),
        columns: { id: true },
      });
      if (!targetTenant) {
        return c.json({ error: `unknown target tenant: ${targetSlug}` }, 404);
      }
      const ancestors = await getAncestorChain(deps.db, targetTenant.id);
      if (!ancestors.includes(deps.rootTenantId)) {
        return c.json(
          {
            error: `target tenant ${targetSlug} is not the global tenant or a descendant`,
          },
          403,
        );
      }
      targetTenantId = targetTenant.id;
    }

    // Optional deploy-time meta (version, sha, deployedAt) the CLI sends.
    const deployMeta = parseDeployMeta(c.req.query("meta"));

    try {
      const { deploymentId, result } = await publishWorkflowDefinition(deps, {
        definition: definition as WorkflowDefinition,
        targetTenantId,
        deployMeta,
      });
      return c.json({ kind: definition.id, deploymentId, result });
    } catch (err) {
      if (err instanceof NoDeployingPrincipalError) {
        return c.json(
          { error: "no deploying principal in the target tenant" },
          409,
        );
      }
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
