import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { and, isNotNull, isNull } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { type } from 'arktype';
import {
  deriveDeploymentAddress,
  deriveStepAddress,
  deriveStepAgentId,
} from '@intx/workflow-deploy';
import type { AgentRepoStore } from '@intx/hub-sessions';
import { LiveDeploymentsResponse } from '@workbench/tool-credentials';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import { readWorkflowDefinition } from '../services/workflow-deploy';
import { deriveWorkflowRunRepoId } from './workflow-runs';

const log = getLogger(['api', 'internal-deployments']);

// Response shape for the OpenAPI spec; documents (does not replace) the
// arktype-validated body the handler returns.
const ErrorResponse = type({ error: 'string' });

// The deployment-level (supervisor) agent id the orchestrator derives:
// `ins_<deploymentId>`. `@intx/workflow-deploy` does not export the helper
// (only `deriveStepAgentId`), so it is mirrored here exactly as
// `workflow-deploy.ts` does.
function deriveDeploymentAgentId(deploymentId: string): string {
  return `ins_${deploymentId}`;
}

/**
 * Internal, sidecar-gated read of the positively-confirmed LIVE deployment
 * set: every `workflow_run` with a non-null `deploymentId` and
 * `deletedAt IS NULL`. The boot reconciler in the sidecar fetches this set
 * BEFORE the orchestrator connects so it can prune on-disk dirs belonging
 * to deployments the hub has since soft-deleted/superseded.
 *
 * The hub is the source of truth: this route only READS. For each live
 * deployment it returns the exact on-disk identifiers the reconciler maps
 * to dir names it must KEEP — the supervisor + step mail addresses (top-
 * level agent dirs), the workflow-run repo slug (`workflow-runs/<slug>`),
 * and each step's agent-state repo id (`agents/<id>`). Step ids are read
 * from the persisted workflow definition the same way the re-establish path
 * reads them, so the live set covers every dir the deploy/launch path keys.
 *
 * `readDefinition` is injected for testability, mirroring the tool-manifest
 * route's `listAssets`/`createResolver` seams; production uses the real
 * working-tree read.
 */
export function createInternalDeploymentsRouter(
  db: HubDb,
  sidecarToken: string,
  repoStore: AgentRepoStore,
  deploymentDomain: string,
  readDefinition: typeof readWorkflowDefinition = readWorkflowDefinition
): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${sidecarToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  router.get(
    '/deployments/live',
    describeRoute({
      tags: ['Deployments'],
      summary: 'List live workflow deployments',
      description:
        'Sidecar-gated (sidecar token). Returns the positively-confirmed live deployment set — every workflow_run with a non-null deploymentId and deletedAt IS NULL — with the supervisor + step mail addresses, the workflow-run repo slug, the step agent ids, and the step agent-state repo ids. The sidecar boot reconciler reads this to prune on-disk dirs for deployments the hub has soft-deleted/superseded. Read-only: it never mutates hub state.',
      responses: {
        200: {
          description: 'The live deployment set',
          content: {
            'application/json': { schema: resolver(LiveDeploymentsResponse) },
          },
        },
        401: {
          description: 'Missing or invalid sidecar token',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: 'Failed to read a persisted workflow definition',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const rows = await db
        .select({
          deploymentId: workflowRun.deploymentId,
          kind: workflowRun.kind,
        })
        .from(workflowRun)
        .where(and(isNotNull(workflowRun.deploymentId), isNull(workflowRun.deletedAt)));

      const deployments: LiveDeploymentsResponse['deployments'] = [];
      for (const row of rows) {
        // The `isNotNull` filter guarantees a non-null deploymentId; narrow
        // for the type system without trusting the DB beyond the predicate.
        const deploymentId = row.deploymentId;
        if (deploymentId === null) continue;

        let definition: Awaited<ReturnType<typeof readWorkflowDefinition>>;
        try {
          definition = await readDefinition(repoStore, row.kind);
        } catch (err) {
          // A live row whose definition cannot be read is an integrity
          // fault: the reconciler MUST positively confirm the entire live
          // set or delete nothing, so fail the whole response loudly rather
          // than return a partial set that would orphan this deployment's
          // dirs to deletion.
          log.error('live deployments: failed to read persisted workflow definition', {
            deploymentId,
            kind: row.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: `failed to read workflow definition for ${deploymentId}` }, 500);
        }

        const supervisorAddress = deriveDeploymentAddress({
          deploymentId,
          deploymentDomain,
        });
        const workflowRunSlug = deriveWorkflowRunRepoId({
          deploymentId,
          deploymentDomain,
        });
        const stepAgentIds: string[] = [];
        const stepAddresses: string[] = [];
        const agentStateRepoIds: string[] = [];
        for (const stepId of definition.stepOrder) {
          stepAgentIds.push(deriveStepAgentId({ deploymentId, stepId }));
          stepAddresses.push(deriveStepAddress({ deploymentId, stepId, deploymentDomain }));
          // The sidecar keys a step's agent-state repo by `<rawDeploymentId>-<stepId>`
          // (no `ins_` prefix) — see the ownedDirs derivation in
          // apps/sidecar/src/workflow-host-wiring.ts. Mirror that exactly.
          agentStateRepoIds.push(`${deploymentId}-${stepId}`);
        }

        deployments.push({
          deploymentId,
          supervisorAddress,
          supervisorAgentId: deriveDeploymentAgentId(deploymentId),
          workflowRunSlug,
          stepAgentIds,
          stepAddresses,
          agentStateRepoIds,
        });
      }

      return c.json({ deployments });
    }
  );

  return router;
}
