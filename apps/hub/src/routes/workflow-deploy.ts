import { and, eq } from 'drizzle-orm';
import { type } from 'arktype';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { schema as intxSchema, getAncestorChain } from '@intx/db';
import type { WorkflowDefinition } from '@intx/workflow';
import { workflowDefinitionEnvelopeSchema } from '@intx/hub-sessions';
import { getLogger } from '@intx/log';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import type { WorkflowDeployService } from '../services/workflow-deploy';
import { resolveWorkflowDeployConfig } from '../services/workflow-deploy-config';
import { requestBodySchema } from '../lib/openapi';

const log = getLogger(['api', 'workflow-deploy']);

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover this operation and validate its responses; these schemas document
// (they do not replace) the handler's existing manual validation.
const WorkflowDeployResponse = type({
  kind: 'string',
  deploymentId: 'string',
  result: 'unknown',
});
const ErrorResponse = type({ error: 'string' });

// Generic workflow deploy. The caller (the workflows:push script, run by an
// operator) sends a serialized @intx/workflow definition; the hub validates it,
// resolves the tenant deploy config, and hands it to the orchestrator, which
// commits the definition to its git-backed `workflow` repo and launches the
// steps. The hub imports no workflow code. See docs/DEPLOYING_WORKFLOWS.md.
//
// Authorization: this is an OPERATOR action, gated by the sidecar/service token
// (Bearer), not a user session. The orchestrator auto-approves the grants the
// posted definition declares, so the caller must be a trusted operator — a
// member session must not reach this route. Mounted under /api/internal.
export function createWorkflowDeployRouter(deps: {
  db: HubDb;
  workflowDeployService: WorkflowDeployService;
  hubPublicKey: string;
  deploymentDomain: string;
  globalTenantId: string;
  serviceToken: string;
}): Hono {
  const router = new Hono();

  router.use('/workflows/deploy', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${deps.serviceToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  router.post(
    '/workflows/deploy',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Deploy a workflow definition',
      description:
        'Operator-gated (service token). Validates a serialized @intx/workflow definition, resolves the tenant deploy config, and launches it. Optional `?tenant=<slug>` targets the global tenant or a descendant; default is the global tenant.',
      parameters: [
        {
          name: 'tenant',
          in: 'query',
          required: false,
          description:
            'Target tenant slug (global tenant or a descendant). Omit for the global tenant.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: requestBodySchema(workflowDefinitionEnvelopeSchema) },
        },
      },
      responses: {
        200: {
          description: 'Workflow deployed',
          content: {
            'application/json': { schema: resolver(WorkflowDeployResponse) },
          },
        },
        400: {
          description: 'Invalid JSON or workflow definition',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: 'Missing or invalid service token',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: 'Target tenant is not the global tenant or a descendant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Unknown target tenant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: 'No deploying principal in the target tenant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: 'Deploy failed',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      const definition = workflowDefinitionEnvelopeSchema(rawBody);
      if (definition instanceof type.errors) {
        return c.json({ error: `invalid workflow definition: ${definition.summary}` }, 400);
      }

      // Optional target tenant. Default (no `?tenant=`) → the global org tenant,
      // unchanged. A non-global target must be the global tenant or a descendant
      // of it — Interchange resolves catalog/credentials down the hierarchy, so a
      // sub-tenant deploy lands collateral scoped to that workbench only.
      const targetSlug = c.req.query('tenant');
      let targetTenantId = deps.globalTenantId;
      if (targetSlug !== undefined && targetSlug !== '') {
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
            403
          );
        }
        targetTenantId = targetTenant.id;
      }

      // Deploying principal: a user principal of the target tenant. Per-step
      // execution principals are derived by the orchestrator.
      const owner = await deps.db.query.principal.findFirst({
        where: and(
          eq(intxSchema.principal.tenantId, targetTenantId),
          eq(intxSchema.principal.kind, 'user')
        ),
      });
      if (!owner) {
        return c.json({ error: 'no deploying principal in the target tenant' }, 409);
      }

      try {
        const { deploymentId, config, deployContent } = await resolveWorkflowDeployConfig({
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
          status: 'running',
        });

        return c.json({ kind: definition.id, deploymentId, result });
      } catch (err) {
        log.error('workflow deploy failed', {
          kind: definition.id,
          tenantId: targetTenantId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: 'failed to deploy workflow' }, 500);
      }
    }
  );

  return router;
}
