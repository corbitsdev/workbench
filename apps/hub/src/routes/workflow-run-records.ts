import { getAncestorChain } from '@intx/db';
import { getLogger } from '@intx/log';
import { type } from 'arktype';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { requestBodySchema } from '../lib/openapi';
import { randomBytes } from 'node:crypto';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import { getRequestedUserContext } from '../lib/user-context';
import { advanceRun, resumeRun, type ExecutorDeps } from '../workflow-executor/executor';
import { createHubReasoningRunner, createHubToolRunner } from '../workflow-executor/hub-runners';
import { projectWorkflow, type ProjectedWorkflow } from '../workflow-executor/projection';
import {
  createRunStore,
  insertRunRecord,
  listRunRecords,
  loadRunRecord,
} from '../workflow-executor/run-store';
import type { AgentRepoStore } from '@intx/hub-sessions';
import type { WorkflowDefinition } from '@intx/workflow';
import { readWorkflowDefinition } from '../services/workflow-deploy';

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
): Promise<{ deploymentId: string; tenantId: string } | null> {
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
  return { deploymentId: best.deploymentId, tenantId: best.tenantId };
}

// Ownership/tenancy gate for reading or resuming a specific run. The record's
// tenant must be visible along the caller's tenant chain, AND the caller must
// own the run (the run's principal is the caller's principal in that tenant).
// Returns a gate result to deny, or null to allow. A cross-user request is
// denied 403; a record in a tenant outside the caller's chain is 404 (it does
// not exist for them).
async function assertRunOwnership(
  db: HubDb,
  context: { tenantId: string; principalId: string },
  state: { tenantId: string; principalId: string }
): Promise<{ status: 403 | 404; error: string } | null> {
  const chain = await getAncestorChain(db, context.tenantId);
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

// Thin-executor workflow runs (CL-2240). State lives in the workflow_run_record
// row; execution walks the deployed definition hub-side via @intx/agent + the
// hub tool registry. No sidecar supervisor, no event-log replay — reads are a
// single indexed row lookup and resume reads the record and continues.
export function createWorkflowRunRecordsRouter(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
  // Injectable for tests; production wires the hub-side executor + run store.
  executorDeps?: ExecutorDeps;
  readDefinition?: (repoStore: AgentRepoStore, kind: string) => Promise<WorkflowDefinition>;
  resolveContext?: typeof getRequestedUserContext;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const resolveContext = deps.resolveContext ?? getRequestedUserContext;

  const executorDeps: ExecutorDeps = deps.executorDeps ?? {
    store: createRunStore(deps.db),
    toolRunner: createHubToolRunner({ db: deps.db }),
    reasoningRunner: createHubReasoningRunner({ db: deps.db }),
  };
  const readDefinition = deps.readDefinition ?? readWorkflowDefinition;

  // Cache the projected workflow per kind for the lifetime of the process; the
  // deployed definition is immutable per deployment.
  const projectionCache = new Map<string, ProjectedWorkflow>();
  async function getProjection(kind: string): Promise<ProjectedWorkflow> {
    const cached = projectionCache.get(kind);
    if (cached) return cached;
    const definition = await readDefinition(deps.repoStore, kind);
    const projected = projectWorkflow(definition);
    projectionCache.set(kind, projected);
    return projected;
  }

  router.post(
    '/workflow-exec/:kind/start',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Start a thin-executor workflow run',
      description:
        'Mints a run record, executes the deployed definition hub-side until the first gate or completion, and returns the run state. Optional `?tenantId=` selects a workbench the user belongs to.',
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

      const projection = await getProjection(kind);
      const runId = mintRunId();
      const state = await insertRunRecord(deps.db, {
        runId,
        deploymentId: deployment.deploymentId,
        kind,
        tenantId: deployment.tenantId,
        principalId: context.principalId,
        input,
      });

      const advanced = await advanceRun(projection, executorDeps, state);
      if (advanced.status === 'failed') {
        log.error('workflow run failed during start', { runId, kind, error: advanced.error });
      }
      return c.json(stateResponse(advanced));
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

      const gate = await assertRunOwnership(deps.db, context, state);
      if (gate) return c.json({ error: gate.error }, gate.status);

      return c.json(stateResponse(state));
    }
  );

  router.post(
    '/workflow-exec/records/:runId/resume',
    describeRoute({
      tags: ['Workflows'],
      summary: 'Resume a gated thin-executor workflow run',
      description:
        "Applies a gate signal's payload as the awaiting step's output and continues execution until the next gate or completion. State is read from the record, so a restart mid-gate resumes cleanly.",
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

      const gate = await assertRunOwnership(deps.db, context, state);
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

      const projection = await getProjection(state.kind);
      try {
        const advanced = await resumeRun(
          projection,
          executorDeps,
          state,
          parsed.signalName,
          parsed.payload ?? {}
        );
        return c.json(stateResponse(advanced));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn('resume rejected', { runId, error: message });
        return c.json({ error: message }, 400);
      }
    }
  );

  return router;
}
