import { and, eq } from 'drizzle-orm';
import { type } from 'arktype';
import { Hono } from 'hono';
import { schema as intxSchema } from '@intx/db';
import type { WorkflowDefinition } from '@intx/workflow';
import { workflowDefinitionEnvelopeSchema } from '@intx/hub-sessions';
import { getLogger } from '@intx/log';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import type { WorkflowDeployService } from '../services/workflow-deploy';
import { resolveWorkflowDeployConfig } from '../services/workflow-deploy-config';

const log = getLogger(['api', 'workflow-deploy']);

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

  router.post('/workflows/deploy', async (c) => {
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

    // Deploying principal: the global org tenant's owner. Per-step execution
    // principals are derived by the orchestrator; deployment-principal semantics
    // are finalized during staging validation.
    const owner = await deps.db.query.principal.findFirst({
      where: and(
        eq(intxSchema.principal.tenantId, deps.globalTenantId),
        eq(intxSchema.principal.kind, 'user')
      ),
    });
    if (!owner) {
      return c.json({ error: 'no deploying principal in the global tenant' }, 409);
    }

    try {
      const { deploymentId, config, deployContent } = await resolveWorkflowDeployConfig({
        db: deps.db,
        tenantId: deps.globalTenantId,
        principalId: owner.id,
        deploymentDomain: deps.deploymentDomain,
      });

      const result = await deps.workflowDeployService.deployWorkflow({
        // Validated envelope; the orchestrator (deployWorkflow → validateWorkflowDefinition)
        // re-runs full definition validation before launch.
        workflow: definition as WorkflowDefinition,
        deploymentId,
        deploymentDomain: deps.deploymentDomain,
        tenantId: deps.globalTenantId,
        creatorPrincipalId: owner.id,
        config,
        deployContent,
        hubPublicKey: deps.hubPublicKey,
      });

      // Index the deployment so the user-facing /workflow-runs routes can list it
      // by tenant without re-walking the workflow-run repos.
      await deps.db.insert(workflowRun).values({
        deploymentId,
        tenantId: deps.globalTenantId,
        principalId: owner.id,
        kind: definition.id,
        status: 'running',
      });

      return c.json({ kind: definition.id, deploymentId, result });
    } catch (err) {
      log.error('workflow deploy failed', {
        kind: definition.id,
        tenantId: deps.globalTenantId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return c.json({ error: 'failed to deploy workflow' }, 500);
    }
  });

  return router;
}
