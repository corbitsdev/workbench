import { getAncestorChain, schema as intxSchema } from '@intx/db';
import { getLogger } from '@intx/log';
import { type } from 'arktype';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { requestBodySchema } from '../lib/openapi';
import { randomBytes, randomUUID } from 'node:crypto';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import { getRequestedUserContext } from '../lib/user-context';
import type { RunState } from '../workflow-executor/executor';
import {
  createRunStore,
  insertRunRecord,
  listRunRecords,
  loadRunRecord,
} from '../workflow-executor/run-store';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import type { CryptoProvider } from '@intx/types/runtime';
import { deriveDeploymentAddress } from '@intx/workflow-deploy';
import type { EnsureDeploymentRoutableFn } from './workflow-runs';

const log = getLogger(['api', 'workflow-run-records']);

const StartBody = type({ 'input?': 'unknown' });
const ResumeBody = type({ signalName: 'string', 'payload?': 'unknown' });

const RunStateResponse = type({
  runId: 'string',
  kind: 'string',
  status: "'running'|'awaiting'|'completed'|'failed'",
  currentStepId: 'string|null',
  outputs: 'object',
  'error?': 'string',
});

const ErrorResponse = type({ error: 'string' });

function mintRunId(): string {
  return `wfr_${randomBytes(16).toString('hex')}`;
}

// Resolve the most-specific deployment of `kind` visible along the user's
// tenant chain (active workbench shadows inherited globals; ties break on
// recency). Mirrors the native start route's shadowing rule.
async function resolveDeployment(
  db: HubDb,
  chain: readonly string[],
  kind: string
): Promise<{ deploymentId: string; tenantId: string; principalId: string } | null> {
  const candidates = await db.query.workflowRun.findMany({
    where: and(
      eq(workflowRun.kind, kind),
      inArray(workflowRun.tenantId, [...chain]),
      isNotNull(workflowRun.deploymentId),
      isNull(workflowRun.deletedAt)
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
  state: { tenantId: string; principalId: string }
): { status: 403 | 404; error: string } | null {
  if (!chain.includes(state.tenantId)) {
    return { status: 404, error: 'run not found' };
  }
  if (state.principalId !== context.principalId) {
    return { status: 403, error: 'Forbidden' };
  }
  return null;
}

function stateResponse(state: {
  runId: string;
  kind: string;
  status: 'running' | 'awaiting' | 'completed' | 'failed';
  currentStepId: string | null;
  outputs: Record<string, unknown>;
  error?: string;
}): {
  runId: string;
  kind: string;
  status: string;
  currentStepId: string | null;
  outputs: Record<string, unknown>;
  error?: string;
} {
  return {
    runId: state.runId,
    kind: state.kind,
    status: state.status,
    currentStepId: state.currentStepId,
    outputs: state.outputs,
    ...(state.error !== undefined ? { error: state.error } : {}),
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
  sidecarRouter: SidecarRouter;
  sessionService: SessionService;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  // Injectable for tests only.
  resolveContext?: typeof getRequestedUserContext;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const resolveContext = deps.resolveContext ?? getRequestedUserContext;
  const runStore = createRunStore(deps.db);

  router.post(
    '/workflow-exec/:kind/start',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Start a workflow run',
      description:
        'Seeds a run record and triggers the run on the sidecar supervisor (the deployed definition executes there). Returns the seeded run state immediately; the record advances asynchronously as the sidecar emits events. Optional `?tenantId=` selects a workbench the user belongs to.',
      parameters: [
        {
          name: 'kind',
          in: 'path',
          required: true,
          description: 'Workflow kind.',
          schema: { type: 'string' },
        },
        {
          name: 'tenantId',
          in: 'query',
          required: false,
          description: 'Target workbench tenant id.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: false,
        description: 'Trigger payload.',
        content: { 'application/json': { schema: requestBodySchema(StartBody) } },
      },
      responses: {
        200: {
          description: 'Run state after the initial advance',
          content: { 'application/json': { schema: resolver(RunStateResponse) } },
        },
        403: {
          description: 'Forbidden',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'No deployment',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get('userId');
      const { context, forbidden } = await resolveContext(deps.db, userId, c.req.query('tenantId'));
      if (forbidden) return c.json({ error: 'Forbidden' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);

      const kind = c.req.param('kind');
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const deployment = await resolveDeployment(deps.db, chain, kind);
      if (!deployment) return c.json({ error: `no deployed workflow of kind "${kind}"` }, 404);

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
      const state = await insertRunRecord(deps.db, {
        runId,
        deploymentId: deployment.deploymentId,
        kind,
        tenantId: deployment.tenantId,
        principalId: context.principalId,
        input,
      });

      try {
        // The supervisor may have been dropped from the hub's addressIndex by a
        // restart since deploy; re-establish before delivering so the run does
        // not dead-end on `agent is unreachable` (CL-2225).
        await deps.ensureDeploymentRoutable({
          deploymentId: deployment.deploymentId,
          kind,
          tenantId: deployment.tenantId,
          creatorPrincipalId: deployment.principalId,
        });
        await deps.sessionService.sendUserMessage({
          agentAddress: deriveDeploymentAddress({
            deploymentId: deployment.deploymentId,
            deploymentDomain: deps.deploymentDomain,
          }),
          from: `hub@${deps.deploymentDomain}`,
          messageId: runId,
          date: new Date(),
          content: JSON.stringify(input),
          sessionId: randomUUID(),
          tenantId: deployment.tenantId,
          cryptoProvider: deps.cryptoProvider,
        });
      } catch (err) {
        log.error('workflow run-start failed', {
          runId,
          kind,
          deploymentId: deployment.deploymentId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        const failed: RunState = {
          ...state,
          status: 'failed',
          error: 'failed to start workflow run',
        };
        await runStore.save(failed);
        return c.json({ error: 'failed to start workflow run' }, 500);
      }

      // Return the seeded row immediately (status 'running'); the UI polls it and
      // the projection bridge advances it as the sidecar emits run events.
      return c.json(stateResponse(state));
    }
  );

  router.get(
    '/workflow-exec/records',
    describeRoute({
      tags: ['Workflows'],
      summary: 'List thin-executor workflow runs',
      description:
        'Lists the run records visible to the user along the tenant chain. Optional `?kind=` filters.',
      parameters: [
        {
          name: 'tenantId',
          in: 'query',
          required: false,
          description: 'Target workbench tenant id.',
          schema: { type: 'string' },
        },
        {
          name: 'kind',
          in: 'query',
          required: false,
          description: 'Filter by workflow kind.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'Run records', content: { 'application/json': {} } },
        403: {
          description: 'Forbidden',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get('userId');
      const { context, forbidden } = await resolveContext(deps.db, userId, c.req.query('tenantId'));
      if (forbidden) return c.json({ error: 'Forbidden' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);
      const chain = await getAncestorChain(deps.db, context.tenantId);
      const rows = await listRunRecords(deps.db, chain, c.req.query('kind'));
      return c.json(rows);
    }
  );

  router.get(
    '/workflow-exec/records/:runId',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Read a thin-executor workflow run state',
      description:
        'Returns the run record state — status, currentStepId, and the stepId->output map — as a single indexed read.',
      parameters: [
        {
          name: 'runId',
          in: 'path',
          required: true,
          description: 'Run id.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Run state',
          content: { 'application/json': { schema: resolver(RunStateResponse) } },
        },
        403: {
          description: 'Forbidden',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Run not found',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get('userId');
      const { context, forbidden } = await resolveContext(deps.db, userId, c.req.query('tenantId'));
      if (forbidden) return c.json({ error: 'Forbidden' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);

      const state = await loadRunRecord(deps.db, c.req.param('runId'));
      if (!state) return c.json({ error: 'run not found' }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      return c.json(stateResponse(state));
    }
  );

  router.post(
    '/workflow-exec/records/:runId/resume',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Resume a gated workflow run',
      description:
        "Delivers the gate signal to the run's sidecar supervisor and optimistically marks the run running. The record advances as the sidecar emits the next step events.",
      parameters: [
        {
          name: 'runId',
          in: 'path',
          required: true,
          description: 'Run id.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        description: 'Signal name and gate payload.',
        content: { 'application/json': { schema: requestBodySchema(ResumeBody) } },
      },
      responses: {
        200: {
          description: 'Run state after resume',
          content: { 'application/json': { schema: resolver(RunStateResponse) } },
        },
        400: {
          description: 'Invalid resume',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: 'Forbidden',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Run not found',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get('userId');
      const { context, forbidden } = await resolveContext(deps.db, userId, c.req.query('tenantId'));
      if (forbidden) return c.json({ error: 'Forbidden' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);

      const runId = c.req.param('runId');
      const state = await loadRunRecord(deps.db, runId);
      if (!state) return c.json({ error: 'run not found' }, 404);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const gate = assertRunOwnership(chain, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const parsed = ResumeBody(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid resume body: ${parsed.summary}` }, 400);
      }

      if (state.deploymentId === undefined) {
        return c.json({ error: 'run has no deployment to signal' }, 400);
      }

      // Re-establish + address the run's supervisor, then deliver the gate signal.
      const deployment = await deps.db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.deploymentId, state.deploymentId),
          inArray(workflowRun.tenantId, chain)
        ),
      });
      if (!deployment) return c.json({ error: 'workflow deployment not found' }, 404);

      try {
        await deps.ensureDeploymentRoutable({
          deploymentId: state.deploymentId,
          kind: state.kind,
          tenantId: deployment.tenantId,
          creatorPrincipalId: deployment.principalId,
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
        log.error('workflow resume signal failed', {
          runId,
          signalName: parsed.signalName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: 'failed to deliver signal' }, 500);
      }

      // Optimistically clear the gate so the UI resumes polling — a row in
      // 'awaiting' pauses the poll. The projection bridge advances it as the
      // sidecar emits the next StepStarted/StepCompleted/RunCompleted.
      const advanced: RunState = { ...state, status: 'running' };
      await runStore.save(advanced);
      return c.json(stateResponse(advanced));
    }
  );

  // Inference credentials visible to the caller's tenant chain — used by the
  // A/B compare config step to populate the provider/model dropdowns. Returns
  // only tenant-owned (principalId IS NULL) credentials whose provider plugin
  // is in the inference whitelist; secrets are never included.
  const INFERENCE_PLUGINS = new Set(['anthropic', 'openai', 'openai-compatible', 'google-genai']);

  router.get(
    '/workflow-exec/credentials',
    describeRoute({
      tags: ['Workflows'],
      summary: 'List inference credentials for workflow configuration',
      description:
        'Returns tenant-owned inference credentials (no secrets) whose provider plugin is in the inference whitelist. Used to populate provider/model pickers in workflow config UIs.',
      parameters: [
        {
          name: 'tenantId',
          in: 'query',
          required: false,
          description: 'Target workbench tenant id.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'List of inference credentials' },
        403: { description: 'Forbidden' },
      },
    }),
    async (c) => {
      const userId = c.get('userId');
      const { context, forbidden } = await resolveContext(deps.db, userId, c.req.query('tenantId'));
      if (forbidden) return c.json({ error: 'Forbidden' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);

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
          eq(intxSchema.credential.providerId, intxSchema.provider.id)
        )
        .where(
          and(
            inArray(intxSchema.credential.tenantId, [...chain]),
            isNull(intxSchema.credential.principalId)
          )
        );

      const CredentialMeta = type({ 'model?': 'string' });
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
    }
  );

  return router;
}
