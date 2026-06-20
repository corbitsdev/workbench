import { describe, expect, it, mock } from 'bun:test';
import type { CryptoProvider } from '@intx/types/runtime';
import type {
  RepoStore,
  SessionService,
  SidecarRouter,
} from '@intx/hub-sessions';

// Mock the user-context resolver: the routes call getUserContext(db, userId)
// and gate on its tenantId. A non-null context lets ownership checks run; the
// db query mock then decides ownership.
let userContextImpl: () => Promise<{ tenantId: string; principalId: string } | null> = () =>
  Promise.resolve({ tenantId: 'tenant-1', principalId: 'principal-1' });
mock.module('../lib/user-context', () => ({
  getUserContext: () => userContextImpl(),
}));

// subscribeKind yields the run's on-disk event entries. The endpoint replays
// from seq 0 to find the StepCompleted for the requested step. We mock it at
// the @intx/hub-sessions boundary with a crafted async generator.
type FakeEntry = { seq: number; runId: string; event: Record<string, unknown> };
let subscribeKindEntries: FakeEntry[] = [];
let subscribeKindThrows: Error | null = null;

// createWorkflowRunBlobSubstrate yields a BlobSubstrate; we stub resolveRef to
// map crafted refs to values, asserting the endpoint resolves the right ref.
let resolveRefImpl: (ref: string) => Promise<unknown> = (ref) =>
  Promise.reject(new Error(`unexpected ref ${ref}`));

const intxHubSessionsReal =
  await import('@intx/hub-sessions');
mock.module('@intx/hub-sessions', () => ({
  ...intxHubSessionsReal,
  subscribeKind: async function* () {
    if (subscribeKindThrows) throw subscribeKindThrows;
    for (const entry of subscribeKindEntries) {
      yield entry;
    }
  },
}));

mock.module('@intx/workflow-host', () => ({
  createWorkflowRunBlobSubstrate: () => ({
    ephemeral: false,
    recordOutput: () => Promise.reject(new Error('not implemented')),
    resolveRef: (ref: string) => resolveRefImpl(ref),
  }),
}));

import { Hono } from 'hono';
import { createWorkflowRunsRouter } from './workflow-runs';
import type { HubDb } from '../db';

function makeDb(owned: boolean) {
  return {
    query: {
      workflowRun: {
        findFirst: mock(() =>
          Promise.resolve(owned ? { deploymentId: 'dep-1', tenantId: 'tenant-1' } : undefined)
        ),
      },
    },
  } as unknown as HubDb;
}

const noopRepoStore = {} as unknown as RepoStore;
const noopSessionService = {} as unknown as SessionService;
const noopSidecarRouter = {} as unknown as SidecarRouter;
const noopCrypto = {} as unknown as CryptoProvider;

function buildApp(db: HubDb, userId = 'user-1') {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route(
    '/',
    createWorkflowRunsRouter({
      db,
      repoStore: noopRepoStore,
      sidecarRouter: noopSidecarRouter,
      sessionService: noopSessionService,
      cryptoProvider: noopCrypto,
      deploymentDomain: 'deploy.example.com',
    })
  );
  return parent;
}

function getOutput(app: Hono<{ Variables: { userId: string } }>, dep: string, step: string) {
  return app.request(
    new Request(`http://local/workflow-runs/${dep}/steps/${step}/output`, { method: 'GET' })
  );
}

describe('GET /workflow-runs/:deploymentId/steps/:stepId/output', () => {
  it('resolves an inline ref to the step output content', async () => {
    userContextImpl = () => Promise.resolve({ tenantId: 'tenant-1', principalId: 'p-1' });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-1', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-1',
        event: { type: 'StepCompleted', seq: 1, stepId: 'step-a', output: { ref: 'inline:{"x":1}' } },
      },
    ];
    resolveRefImpl = (ref) => {
      expect(ref).toBe('inline:{"x":1}');
      return Promise.resolve({ x: 1 });
    };

    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: 'step-a', output: { x: 1 } });
  });

  it('resolves a blob ref to the step output content', async () => {
    userContextImpl = () => Promise.resolve({ tenantId: 'tenant-1', principalId: 'p-1' });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-9', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 2,
        runId: 'run-9',
        event: { type: 'StepCompleted', seq: 2, stepId: 'step-b', output: { ref: 'blob:abc123' } },
      },
    ];
    const big = { payload: 'large' };
    resolveRefImpl = (ref) => {
      expect(ref).toBe('blob:abc123');
      return Promise.resolve(big);
    };

    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-b');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: 'step-b', output: big });
  });

  it('404s for a deployment the caller does not own', async () => {
    userContextImpl = () => Promise.resolve({ tenantId: 'tenant-1', principalId: 'p-1' });
    const res = await getOutput(buildApp(makeDb(false)), 'dep-x', 'step-a');
    expect(res.status).toBe(404);
  });

  it('404s when the requested step has not completed', async () => {
    userContextImpl = () => Promise.resolve({ tenantId: 'tenant-1', principalId: 'p-1' });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-1', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-1',
        event: { type: 'StepCompleted', seq: 1, stepId: 'other-step', output: { ref: 'inline:1' } },
      },
    ];
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(404);
  });

  it('403s when there is no user context', async () => {
    userContextImpl = () => Promise.resolve(null);
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(403);
  });

  it('500s when ref resolution fails', async () => {
    userContextImpl = () => Promise.resolve({ tenantId: 'tenant-1', principalId: 'p-1' });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      {
        seq: 1,
        runId: 'run-1',
        event: { type: 'StepCompleted', seq: 1, stepId: 'step-a', output: { ref: 'inline:bad' } },
      },
    ];
    resolveRefImpl = () => Promise.reject(new Error('boom'));
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(500);
  });
});
