import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { type } from 'arktype';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribeKind } from '@intx/hub-sessions';
import type {
  Principal,
  RepoId,
  RepoStore,
  SessionService,
  SidecarRouter,
} from '@intx/hub-sessions';
import type { CryptoProvider } from '@intx/types/runtime';
import { getLogger } from '@intx/log';
import { deriveDeploymentAddress } from '@intx/workflow-deploy';
import type { HubDb } from '../db';
import { workflowRun } from '../db/schema';
import { getUserContext } from '../lib/user-context';

// User-facing read/control surface over natively-deployed workflows.
// The hub indexes each deployment in `workflow_run` at deploy time; these
// routes list that index, tail the workflow-run event log over SSE, deliver
// signals, and start runs. Mounted on the v1 (user-session) router.

// All @intx/workflow on-disk event `type` discriminator values. subscribeKind
// filters committed event blobs against this set (the blobs store the
// state-machine `kind` under the field name `type`; see
// @intx/workflow-host adapters/repo-store.ts workflowEventToOnDisk).
const WORKFLOW_EVENT_TYPES: readonly string[] = [
  'RunStarted',
  'StepStarted',
  'StepCompleted',
  'StepFailed',
  'AttemptScheduled',
  'SignalAwaited',
  'SignalReceived',
  'TimerSet',
  'TimerFired',
  'CancelRequested',
  'CancelPropagated',
  'ChildSpawned',
  'ChildCancelRequested',
  'ChildCompleted',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
];

// Passthrough validator: subscribeKind narrows each blob through this before
// yielding. The state machine owns the full 17-variant narrow; here we only
// assert the on-disk envelope shape (a string `type` discriminator + seq).
const WorkflowEventBlob = type({ type: 'string', seq: 'number', '+': 'ignore' });

const HUB_PRINCIPAL: Principal = { kind: 'hub' };
const RUN_EVENT_REF = 'refs/heads/main';

const log = getLogger(['api', 'workflow-runs']);

const SignalBody = type({
  runId: 'string > 0',
  signalName: 'string > 0',
  payload: 'unknown',
});

// The run trigger payload — any JSON object; passed to the workflow's first step.
const StartRunBody = type({ '+': 'ignore' });

export function createWorkflowRunsRouter(deps: {
  db: HubDb;
  repoStore: RepoStore;
  sidecarRouter: SidecarRouter;
  sessionService: SessionService;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const { repoStore } = deps;

  router.get('/workflow-runs', async (c) => {
    const userId = c.get('userId');
    const context = await getUserContext(deps.db, userId);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const rows = await deps.db
      .select({
        deploymentId: workflowRun.deploymentId,
        kind: workflowRun.kind,
        status: workflowRun.status,
        createdAt: workflowRun.createdAt,
      })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.tenantId, context.tenantId),
          isNotNull(workflowRun.deploymentId),
          isNull(workflowRun.deletedAt)
        )
      )
      .orderBy(desc(workflowRun.createdAt));

    return c.json(rows);
  });

  router.get('/workflow-runs/:deploymentId/stream', async (c) => {
    const userId = c.get('userId');
    const context = await getUserContext(deps.db, userId);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const deploymentId = c.req.param('deploymentId');
    const owned = await deps.db.query.workflowRun.findFirst({
      where: and(
        eq(workflowRun.deploymentId, deploymentId),
        eq(workflowRun.tenantId, context.tenantId)
      ),
    });
    if (!owned) return c.json({ error: 'Workflow deployment not found' }, 404);

    const repoId: RepoId = { kind: 'workflow-run', id: deploymentId };

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
        }
      );

      try {
        for await (const entry of iter) {
          await stream.writeSSE({
            data: JSON.stringify({ seq: entry.seq, runId: entry.runId, event: entry.event }),
          });
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          log.error('workflow-run event stream failed', {
            deploymentId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    });
  });

  router.post('/workflow-runs/:deploymentId/signal', async (c) => {
    const userId = c.get('userId');
    const context = await getUserContext(deps.db, userId);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const deploymentId = c.req.param('deploymentId');
    const owned = await deps.db.query.workflowRun.findFirst({
      where: and(
        eq(workflowRun.deploymentId, deploymentId),
        eq(workflowRun.tenantId, context.tenantId)
      ),
    });
    if (!owned) return c.json({ error: 'Workflow deployment not found' }, 404);

    let rawSignal: unknown;
    try {
      rawSignal = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const body = SignalBody(rawSignal);
    if (body instanceof type.errors) {
      return c.json({ error: `invalid signal: ${body.summary}` }, 400);
    }

    try {
      deps.sidecarRouter.sendSignalDeliver({
        agentAddress: deriveDeploymentAddress({
          deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
        runId: body.runId,
        signalName: body.signalName,
        signalId: randomUUID(),
        payload: body.payload,
      });
    } catch (err) {
      log.error('workflow signal delivery failed', {
        deploymentId,
        runId: body.runId,
        signalName: body.signalName,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return c.json({ error: 'failed to deliver signal' }, 500);
    }

    return c.json({ accepted: true }, 202);
  });

  router.post('/workflow-runs/:kind/start', async (c) => {
    const userId = c.get('userId');
    const context = await getUserContext(deps.db, userId);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const kind = c.req.param('kind');
    const deployment = await deps.db.query.workflowRun.findFirst({
      where: and(
        eq(workflowRun.kind, kind),
        eq(workflowRun.tenantId, context.tenantId),
        isNotNull(workflowRun.deploymentId),
        isNull(workflowRun.deletedAt)
      ),
      orderBy: desc(workflowRun.createdAt),
    });
    if (!deployment?.deploymentId) {
      return c.json({ error: `no deployed workflow of kind "${kind}"` }, 404);
    }

    // A run begins when the deployment's mail address receives a message: the
    // supervisor enqueues it and forwards a trigger.fire to the workflow child.
    // We deliver the request body as that trigger message; the new run surfaces
    // on the SSE stream (the client reads its runId from RunStarted).
    let rawInput: unknown;
    try {
      rawInput = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const input = StartRunBody(rawInput);
    if (input instanceof type.errors) {
      return c.json({ error: `invalid input: ${input.summary}` }, 400);
    }

    try {
      await deps.sessionService.sendUserMessage({
        agentAddress: deriveDeploymentAddress({
          deploymentId: deployment.deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
        from: `hub@${deps.deploymentDomain}`,
        messageId: randomUUID(),
        date: new Date(),
        content: JSON.stringify(input),
        sessionId: randomUUID(),
        tenantId: context.tenantId,
        cryptoProvider: deps.cryptoProvider,
      });
    } catch (err) {
      log.error('workflow run-start failed', {
        kind,
        deploymentId: deployment.deploymentId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return c.json({ error: 'failed to start workflow run' }, 500);
    }

    return c.json({ deploymentId: deployment.deploymentId, accepted: true }, 202);
  });

  return router;
}
