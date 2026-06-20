import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import { authorize } from "@intx/authz";
import type { GrantStore } from "@intx/authz";
import type { WorkflowDefinition } from "@intx/workflow";
import { workflowDefinitionEnvelopeSchema } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { ensureGlobalMember } from "../lib/tenant-provisioning";
import type { WorkflowDeployService } from "../services/workflow-deploy";
import { resolveWorkflowDeployConfig } from "../services/workflow-deploy-config";
import { requestBodySchema } from "../lib/openapi";

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
  hubPublicKey: string;
  deploymentDomain: string;
  globalTenantId: string;
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

      // Index the deployment so the user-facing /workflow-runs routes can list it
      // by tenant without re-walking the workflow-run repos.
      await deps.db.insert(workflowRun).values({
        deploymentId,
        tenantId: targetTenantId,
        principalId: owner.id,
        kind: definition.id,
        status: "running",
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
