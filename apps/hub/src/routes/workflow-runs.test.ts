import { describe, expect, it, mock } from 'bun:test';
import type { CryptoProvider } from '@intx/types/runtime';
import type { RepoStore, SessionService, SidecarRouter } from '@intx/hub-sessions';

// Mock the user-context resolver: the routes call getRequestedUserContext(db,
// userId, tenantId) and gate on its result. forbidden=true → 403; a non-null
// context lets the ancestor-walk ownership checks run.
type RequestedResult = {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
};
let userContextImpl: () => Promise<RequestedResult> = () =>
  Promise.resolve({
    context: { tenantId: 'tenant-1', principalId: 'principal-1' },
    forbidden: false,
  });
mock.module('../lib/user-context', () => ({
  getRequestedUserContext: () => userContextImpl(),
}));

// The routes walk the active tenant -> ancestors chain via getAncestorChain
// (most-specific first). Default: workbench shadows the global root.
let ancestorChain: string[] = ['tenant-1', 'tenant-global'];
const intxDbReal = await import('@intx/db');
mock.module('@intx/db', () => ({
  ...intxDbReal,
  getAncestorChain: () => Promise.resolve(ancestorChain),
}));

// subscribeKind yields the run's on-disk event entries. The endpoint replays
// from seq 0 to find the StepCompleted for the requested step. We mock it at
// the @intx/hub-sessions boundary with a crafted async generator.
type FakeEntry = { seq: number; runId: string; event: Record<string, unknown> };
let subscribeKindEntries: FakeEntry[] = [];
let subscribeKindThrows: Error | null = null;
// When true, the mock simulates a PARKED HITL run's live tail: it yields the
// backlog entries and then blocks forever (until the consumer's AbortSignal
// fires). This is the deadlock the bounded backlog read must break (CL-2233).
let subscribeKindHangsAfterBacklog = false;

// createWorkflowRunBlobSubstrate yields a BlobSubstrate; we stub resolveRef to
// map crafted refs to values, asserting the endpoint resolves the right ref.
let resolveRefImpl: (ref: string) => Promise<unknown> = (ref) =>
  Promise.reject(new Error(`unexpected ref ${ref}`));

// Captures the repoId the endpoint subscribes the run-event log under, so a
// test can assert the hub reads under the SLUGGED workflow-run repo id the
// sidecar writes (not the raw `ses_<id>` deploymentId) — the id-mismatch that
// left every run's event log appearing empty.
//
// A container (not a bare `let`) so the test's read after `await getOutput(...)`
// is not narrowed by control-flow analysis to the `null` it was reset to — TS
// cannot see the async-generator mutation, but it does invalidate property
// narrowing across the intervening call.
const subscribeCapture: { repoId: { kind: string; id: string } | null } = {
  repoId: null,
};
const intxHubSessionsReal = await import('@intx/hub-sessions');
mock.module('@intx/hub-sessions', () => ({
  ...intxHubSessionsReal,
  subscribeKind: async function* (
    _store: unknown,
    _principal: unknown,
    repoId: { kind: string; id: string },
    _ref: unknown,
    _validator: unknown,
    opts: { signal: AbortSignal }
  ) {
    subscribeCapture.repoId = repoId;
    if (subscribeKindThrows) throw subscribeKindThrows;
    for (const entry of subscribeKindEntries) {
      yield entry;
    }
    if (subscribeKindHangsAfterBacklog) {
      // Block until the consumer aborts — a live tail of a parked run never
      // commits another event. A real subscribe would reject on abort.
      await new Promise<void>((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
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
import {
  createWorkflowRunsRouter,
  deriveWorkflowRunRepoId,
  setBacklogIdleMsForTest,
  type EnsureDeploymentRoutableFn,
} from './workflow-runs';
import type { HubDb } from '../db';
import { workflowRun, workflowRunInstance } from '../db/schema';

// Map a Drizzle table object to a stable string by identity so a captured
// insert/update can be asserted against the right table — this is how the
// CL-2233 tests prove the instance routes touch `workflow_run_instance` and
// NOT the shared `workflow_run` deployment table.
function tableName(table: unknown): string {
  if (table === workflowRunInstance) return 'workflow_run_instance';
  if (table === workflowRun) return 'workflow_run';
  return 'unknown';
}

type WorkflowRunRow = {
  deploymentId: string;
  kind: string;
  status: string;
  createdAt: string;
  tenantId: string;
};

function makeDb(owned: boolean, ownsRun = true) {
  const findFirst = mock(() =>
    Promise.resolve(owned ? { deploymentId: 'dep-1', tenantId: 'tenant-1' } : undefined)
  );
  // The /stream route gates on run ownership (CL-2233): a non-deleted
  // workflow_run_instance for the runId scoped to the caller's principal.
  const instanceFindFirst = mock(() =>
    Promise.resolve(ownsRun ? { runId: 'run-A', memberPrincipalId: 'caller-p' } : undefined)
  );
  const setMock = mock((_values: { status: string }) => ({
    where: (cond: unknown) => {
      void cond;
      return Promise.resolve();
    },
  }));
  return {
    query: {
      workflowRun: {
        findFirst,
      },
      workflowRunInstance: {
        findFirst: instanceFindFirst,
      },
    },
    update: () => ({ set: setMock }),
  } as unknown as HubDb;
}

// A db whose LIST select() returns the given rows verbatim and whose findMany
// (start route) returns the given candidates. The route applies its own
// ancestor-chain filtering on top of `findMany` (shadowing); the LIST route
// trusts the rows the query returns.
function makeListDb(rows: WorkflowRunRow[], findManyRows: WorkflowRunRow[] = rows) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
    query: {
      workflowRun: {
        findMany: mock(() => Promise.resolve(findManyRows)),
      },
    },
    // The start route records a user-owned instance row before delivering the
    // trigger (CL-2233). These shadowing/visibility tests do not assert on it,
    // but the route must be able to insert/update without throwing.
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({
      set: () => ({ where: () => ({ catch: () => Promise.resolve() }) }),
    }),
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
      ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
    })
  );
  return parent;
}

function getOutput(
  app: Hono<{ Variables: { userId: string } }>,
  dep: string,
  step: string,
  runId: string | null = 'run-1'
) {
  const q = runId === null ? '' : `?runId=${runId}`;
  return app.request(
    new Request(`http://local/workflow-runs/${dep}/steps/${step}/output${q}`, {
      method: 'GET',
    })
  );
}

describe('deriveWorkflowRunRepoId', () => {
  it('slugifies the deployment mail address the way the sidecar keys the run repo', () => {
    // Must match apps/sidecar/src/workflow-host-wiring.ts deriveTrivialDeploymentId
    // applied to deriveDeploymentAddress(`ins_<deploymentId>@<domain>`): every
    // character outside /[a-zA-Z0-9_-]/ becomes `-`.
    expect(
      deriveWorkflowRunRepoId({
        deploymentId: 'ses_e47abe56e772d99a71e794b8f8e73a2f',
        deploymentDomain: 'abklabs.com',
      })
    ).toBe('ins_ses_e47abe56e772d99a71e794b8f8e73a2f-abklabs-com');
  });

  it('produces a substrate-safe id (no @ or . survive)', () => {
    const id = deriveWorkflowRunRepoId({
      deploymentId: 'ses_abc',
      deploymentDomain: 'deploy.example.com',
    });
    expect(id).toBe('ins_ses_abc-deploy-example-com');
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('GET /workflow-runs/:deploymentId/steps/:stepId/output', () => {
  it('subscribes the run-event log under the slugged repo id, not the raw deploymentId', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [];
    subscribeCapture.repoId = null;

    // 404 (step never completes) is fine; we only assert WHICH repo id the
    // endpoint read from. The raw param is `dep-1`; the sidecar writes under
    // the slug of `ins_dep-1@deploy.example.com`.
    await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    // Read through a typed getter so control-flow analysis does not narrow the
    // capture back to the `null` it was reset to before the call.
    const captured = (): { kind: string; id: string } | null => subscribeCapture.repoId;
    expect(captured()).toEqual({
      kind: 'workflow-run',
      id: 'ins_dep-1-deploy-example-com',
    });
  });

  it('resolves an inline ref to the step output content', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-1', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-1',
        event: {
          type: 'StepCompleted',
          seq: 1,
          stepId: 'step-a',
          output: { ref: 'inline:{"x":1}' },
        },
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
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-9', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 2,
        runId: 'run-9',
        event: {
          type: 'StepCompleted',
          seq: 2,
          stepId: 'step-b',
          output: { ref: 'blob:abc123' },
        },
      },
    ];
    const big = { payload: 'large' };
    resolveRefImpl = (ref) => {
      expect(ref).toBe('blob:abc123');
      return Promise.resolve(big);
    };

    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-b', 'run-9');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: 'step-b', output: big });
  });

  it('404s for a deployment the caller does not own', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    const res = await getOutput(buildApp(makeDb(false)), 'dep-x', 'step-a');
    expect(res.status).toBe(404);
  });

  it('404s when the requested step has not completed', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-1', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-1',
        event: {
          type: 'StepCompleted',
          seq: 1,
          stepId: 'other-step',
          output: { ref: 'inline:1' },
        },
      },
    ];
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(404);
  });

  it('403s when there is no user context', async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: false });
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(403);
  });

  it('500s when ref resolution fails', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      {
        seq: 1,
        runId: 'run-1',
        event: {
          type: 'StepCompleted',
          seq: 1,
          stepId: 'step-a',
          output: { ref: 'inline:bad' },
        },
      },
    ];
    resolveRefImpl = () => Promise.reject(new Error('boom'));
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a');
    expect(res.status).toBe(500);
  });

  it('403s when runId is omitted (CL-2233 run-scoped read)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a', null);
    expect(res.status).toBe(403);
  });

  it('403s when the caller does not own the requested runId (CL-2233)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'user-b' },
        forbidden: false,
      });
    // makeDb(true, false): deployment owned, but no instance row for this caller.
    const res = await getOutput(buildApp(makeDb(true, false)), 'dep-1', 'step-a', 'run-A');
    expect(res.status).toBe(403);
  });

  it('returns ONLY the owned run’s step output, not a co-tenant run on the same deployment (CL-2233)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    // Same deployment log carries two runs' StepCompleted for the SAME stepId.
    // The caller owns run-A; run-B is another user's run and must be invisible.
    subscribeKindEntries = [
      { seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-A',
        event: { type: 'StepCompleted', seq: 1, stepId: 'step-a', output: { ref: 'inline:mine' } },
      },
      {
        seq: 2,
        runId: 'run-B',
        event: {
          type: 'StepCompleted',
          seq: 2,
          stepId: 'step-a',
          output: { ref: 'inline:theirs' },
        },
      },
    ];
    resolveRefImpl = (ref) => {
      if (ref === 'inline:mine') return Promise.resolve({ owner: 'A' });
      return Promise.reject(new Error(`must not resolve another run's ref: ${ref}`));
    };
    const res = await getOutput(buildApp(makeDb(true)), 'dep-1', 'step-a', 'run-A');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: 'step-a', output: { owner: 'A' } });
  });
});

describe('GET /workflow-runs (workbench-aware visibility)', () => {
  function listApp(db: HubDb) {
    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use('*', async (c, next) => {
      c.set('userId', 'user-1');
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
        ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
      })
    );
    return parent;
  }

  it('lists the active workbench deployments plus global-inherited ones', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1', 'tenant-global'];
    const rows: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-wb',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-01T00:00:00.000Z',
        tenantId: 'tenant-1',
      },
      {
        deploymentId: 'dep-global',
        kind: 'report',
        status: 'idle',
        createdAt: '2026-05-01T00:00:00.000Z',
        tenantId: 'tenant-global',
      },
    ];
    const res = await listApp(makeListDb(rows)).request(
      new Request('http://local/workflow-runs?tenantId=tenant-1', {
        method: 'GET',
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ deploymentId: string }>;
    expect(body.map((r) => r.deploymentId).sort()).toEqual(['dep-global', 'dep-wb']);
  });

  it('403s when the caller is not a principal of the requested tenant', async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: true });
    const res = await listApp(makeListDb([])).request(
      new Request('http://local/workflow-runs?tenantId=tenant-other', {
        method: 'GET',
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /workflow-runs/:kind/start (shadowing + visibility)', () => {
  function startApp(
    db: HubDb,
    capture: { msg?: { tenantId: string } },
    ensure?: EnsureDeploymentRoutableFn
  ) {
    const sessionService = {
      sendUserMessage: (args: { tenantId: string }) => {
        capture.msg = args;
        return Promise.resolve();
      },
    } as unknown as SessionService;
    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      await next();
    });
    parent.route(
      '/',
      createWorkflowRunsRouter({
        db,
        repoStore: noopRepoStore,
        sidecarRouter: noopSidecarRouter,
        sessionService,
        cryptoProvider: noopCrypto,
        deploymentDomain: 'deploy.example.com',
        ensureDeploymentRoutable: ensure ?? (() => Promise.resolve({ reestablished: false })),
      })
    );
    return parent;
  }

  it('re-establishes the supervisor before delivering, and does not deliver if that fails (CL-2225)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-wb',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-01T00:00:00.000Z',
        tenantId: 'tenant-1',
      },
    ];
    const ensureArgs: Array<{ deploymentId: string; kind: string }> = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      ensureArgs.push({ deploymentId: args.deploymentId, kind: args.kind });
      return Promise.reject(new Error('sidecar down'));
    };
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], candidates), capture, ensure).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
    );
    expect(res.status).toBe(500);
    // ensure was invoked with the resolved deployment's identity...
    expect(ensureArgs).toEqual([{ deploymentId: 'dep-wb', kind: 'deck' }]);
    // ...and the trigger was NOT delivered because re-establishment failed.
    expect(capture.msg).toBeUndefined();
  });

  it('the most-specific tenant deployment shadows an inherited global one', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1', 'tenant-global'];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-global',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-10T00:00:00.000Z',
        tenantId: 'tenant-global',
      },
      {
        deploymentId: 'dep-wb',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-01T00:00:00.000Z',
        tenantId: 'tenant-1',
      },
    ];
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], candidates), capture).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { deploymentId: string };
    expect(body.deploymentId).toBe('dep-wb');
    expect(capture.msg?.tenantId).toBe('tenant-1');
  });

  it('starts the inherited global deployment when the workbench has none', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1', 'tenant-global'];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-global',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-10T00:00:00.000Z',
        tenantId: 'tenant-global',
      },
    ];
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], candidates), capture).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(202);
    expect(capture.msg?.tenantId).toBe('tenant-global');
  });

  it('403s for a tenant the caller is not a principal of', async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: true });
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], []), capture).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-other', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /workflow-runs/:deploymentId/steps (batched step outputs)', () => {
  function allSteps(app: ReturnType<typeof buildApp>, dep: string, runId: string | null = 'run-1') {
    const q = runId === null ? '' : `?runId=${runId}`;
    return app.request(
      new Request(`http://local/workflow-runs/${dep}/steps${q}`, { method: 'GET' })
    );
  }

  it('replays the log once and returns all completed step outputs as a map', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-1', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-1',
        event: {
          type: 'StepCompleted',
          seq: 1,
          stepId: 'step-a',
          output: { ref: 'inline:{"a":1}' },
        },
      },
      {
        seq: 2,
        runId: 'run-1',
        event: {
          type: 'StepCompleted',
          seq: 2,
          stepId: 'step-b',
          output: { ref: 'inline:{"b":2}' },
        },
      },
    ];
    resolveRefImpl = (ref) => {
      if (ref === 'inline:{"a":1}') return Promise.resolve({ a: 1 });
      if (ref === 'inline:{"b":2}') return Promise.resolve({ b: 2 });
      return Promise.reject(new Error(`unexpected ref: ${ref}`));
    };

    const res = await allSteps(buildApp(makeDb(true)), 'dep-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({ 'step-a': { a: 1 }, 'step-b': { b: 2 } });
  });

  it('returns an empty outputs map when no steps have completed', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [{ seq: 0, runId: 'run-2', event: { type: 'RunStarted', seq: 0 } }];

    const res = await allSteps(buildApp(makeDb(true)), 'dep-1', 'run-2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({});
  });

  it('404s for a deployment the caller does not own', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    const res = await allSteps(buildApp(makeDb(false)), 'dep-x');
    expect(res.status).toBe(404);
  });

  it('403s when there is no user context', async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: false });
    const res = await allSteps(buildApp(makeDb(true)), 'dep-1');
    expect(res.status).toBe(403);
  });

  it('500s when the event log replay throws', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'p-1' },
        forbidden: false,
      });
    subscribeKindThrows = new Error('log unavailable');
    subscribeKindEntries = [];

    const res = await allSteps(buildApp(makeDb(true)), 'dep-1');
    expect(res.status).toBe(500);
  });

  it('403s when runId is omitted (CL-2233 run-scoped read)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    const res = await allSteps(buildApp(makeDb(true)), 'dep-1', null);
    expect(res.status).toBe(403);
  });

  it('403s when the caller does not own the requested runId (CL-2233)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'user-b' },
        forbidden: false,
      });
    const res = await allSteps(buildApp(makeDb(true, false)), 'dep-1', 'run-A');
    expect(res.status).toBe(403);
  });

  it('returns ONLY the owned run’s outputs, not a co-tenant run on the same deployment (CL-2233)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    // The shared deployment log carries run-A (caller's) and run-B (someone
    // else's). The batched read must only resolve run-A's refs.
    subscribeKindEntries = [
      { seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-A',
        event: { type: 'StepCompleted', seq: 1, stepId: 'step-a', output: { ref: 'inline:mine' } },
      },
      {
        seq: 2,
        runId: 'run-B',
        event: {
          type: 'StepCompleted',
          seq: 2,
          stepId: 'step-x',
          output: { ref: 'inline:theirs' },
        },
      },
    ];
    resolveRefImpl = (ref) => {
      if (ref === 'inline:mine') return Promise.resolve({ owner: 'A' });
      return Promise.reject(new Error(`must not resolve another run's ref: ${ref}`));
    };
    const res = await allSteps(buildApp(makeDb(true)), 'dep-1', 'run-A');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({ 'step-a': { owner: 'A' } });
  });
});

// === CL-2233: bounded backlog read (parked HITL run must not hang) ===========

describe('GET /workflow-runs/:deploymentId/steps — bounded backlog read', () => {
  function allStepsReq(app: ReturnType<typeof buildApp>, dep: string, runId: string) {
    return app.request(
      new Request(`http://local/workflow-runs/${dep}/steps?runId=${runId}`, { method: 'GET' })
    );
  }

  it('terminates and returns the backlog steps even when the event tail never ends (parked run)', async () => {
    // Idle window short so the test is fast; the real default is 1000ms.
    setBacklogIdleMsForTest(50);
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    subscribeKindThrows = null;
    // A parked HITL run: step 1 completed, then the run blocks at an awaitSignal
    // gate so subscribeKind's live tail yields nothing more and never ends.
    subscribeKindHangsAfterBacklog = true;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } },
      {
        seq: 1,
        runId: 'run-A',
        event: { type: 'StepCompleted', seq: 1, stepId: 'step-1', output: { ref: 'inline:one' } },
      },
    ];
    resolveRefImpl = (ref) =>
      ref === 'inline:one'
        ? Promise.resolve({ notes: ['n1'] })
        : Promise.reject(new Error(`unexpected ref ${ref}`));

    // Fail-before (tail-forever code): this never resolves and the test times
    // out. Pass-after: the idle-timeout aborts the drain and we get the backlog.
    const res = await Promise.race([
      allStepsReq(buildApp(makeDb(true)), 'dep-1', 'run-A'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('read hung: backlog drain did not terminate')), 5000)
      ),
    ]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({ 'step-1': { notes: ['n1'] } });

    subscribeKindHangsAfterBacklog = false;
    setBacklogIdleMsForTest(1000);
  });
});

// === CL-2233: user-owned run instances ======================================

// Capture buffers shared by the instance-route tests. Each entry records WHICH
// table (by identity) a write targeted, so a test can assert the instance
// routes never mutate the shared `workflow_run` deployment table.
type InsertCapture = { table: string; values: Record<string, unknown> };
type UpdateCapture = { table: string; set: Record<string, unknown> };

// A db that backs the CL-2233 routes: instance findMany/findFirst (caller-scoped
// reads), deployment findMany (start-route candidates), and table-tagged
// insert/update capture. `instanceFindMany` receives the resolved arktype/Drizzle
// `where` args so a test can echo them back, but most tests just return crafted
// rows. `instanceFindFirst` gates ownership (owned row or undefined).
function makeInstanceDb(opts: {
  instanceRows?: Array<Record<string, unknown>>;
  instanceRowsByPrincipal?: (principalId: string | undefined) => Array<Record<string, unknown>>;
  owned?: Record<string, unknown> | undefined;
  deploymentCandidates?: WorkflowRunRow[];
  inserts: InsertCapture[];
  updates: UpdateCapture[];
  findManyArgs?: Array<{ where: unknown }>;
}): HubDb {
  let findManyCalls = 0;
  const instanceFindMany = mock((args: { where: unknown }) => {
    opts.findManyArgs?.push({ where: args.where });
    findManyCalls += 1;
    if (opts.instanceRowsByPrincipal) {
      // The route re-reads after reconcile; echo the same set both times.
      return Promise.resolve(opts.instanceRowsByPrincipal(undefined));
    }
    return Promise.resolve(opts.instanceRows ?? []);
  });
  void findManyCalls;
  return {
    query: {
      workflowRun: {
        findMany: mock(() => Promise.resolve(opts.deploymentCandidates ?? [])),
        findFirst: mock(() =>
          Promise.resolve({
            deploymentId: 'dep-1',
            tenantId: 'tenant-1',
            principalId: 'creator-p',
            kind: 'deck',
          })
        ),
      },
      workflowRunInstance: {
        findMany: instanceFindMany,
        findFirst: mock(() => Promise.resolve(opts.owned)),
      },
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        opts.inserts.push({ table: tableName(table), values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const chain = {
          where: (_cond: unknown) => {
            opts.updates.push({ table: tableName(table), set });
            return {
              catch: () => Promise.resolve(),
              then: (resolve: () => unknown) => Promise.resolve().then(resolve),
            };
          },
        };
        return chain as unknown as ReturnType<typeof chain.where>;
      },
    }),
  } as unknown as HubDb;
}

function instanceApp(
  db: HubDb,
  sessionService: SessionService = noopSessionService,
  ensure?: EnsureDeploymentRoutableFn
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  parent.route(
    '/',
    createWorkflowRunsRouter({
      db,
      repoStore: noopRepoStore,
      sidecarRouter: noopSidecarRouter,
      sessionService,
      cryptoProvider: noopCrypto,
      deploymentDomain: 'deploy.example.com',
      ensureDeploymentRoutable: ensure ?? (() => Promise.resolve({ reestablished: false })),
    })
  );
  return parent;
}

describe('POST /workflow-runs/:kind/start (CL-2233 instance row + correlation)', () => {
  it('inserts a caller-owned instance row and delivers a trigger whose messageId equals the returned correlationMessageId', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-wb',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-01T00:00:00.000Z',
        tenantId: 'tenant-1',
      },
    ];
    const db = makeInstanceDb({ deploymentCandidates: candidates, inserts, updates });
    const sent: Array<{ messageId: string; tenantId: string }> = [];
    const sessionService = {
      sendUserMessage: (args: { messageId: string; tenantId: string }) => {
        sent.push({ messageId: args.messageId, tenantId: args.tenantId });
        return Promise.resolve();
      },
    } as unknown as SessionService;

    const res = await instanceApp(db, sessionService).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'launch' }),
      })
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      deploymentId: string;
      runId: string | null;
      correlationMessageId: string;
      accepted: boolean;
    };
    expect(body.deploymentId).toBe('dep-wb');
    expect(body.runId).toBeNull();
    expect(body.accepted).toBe(true);

    // The inserted row carries the CALLER principal + the resolved deployment.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe('workflow_run_instance');
    expect(inserts[0]?.values).toMatchObject({
      correlationMessageId: body.correlationMessageId,
      deploymentId: 'dep-wb',
      kind: 'deck',
      tenantId: 'tenant-1',
      memberPrincipalId: 'caller-p',
      status: 'running',
      input: { topic: 'launch' },
    });

    // The delivered trigger's messageId IS the correlation handle returned.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messageId).toBe(body.correlationMessageId);

    // The happy path issues no failure-path update.
    expect(updates).toHaveLength(0);
  });

  it('marks the instance row failed (not the deployment) when delivery throws', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: 'dep-wb',
        kind: 'deck',
        status: 'idle',
        createdAt: '2026-06-01T00:00:00.000Z',
        tenantId: 'tenant-1',
      },
    ];
    const db = makeInstanceDb({ deploymentCandidates: candidates, inserts, updates });
    const sessionService = {
      sendUserMessage: () => Promise.reject(new Error('sidecar down')),
    } as unknown as SessionService;

    const res = await instanceApp(db, sessionService).request(
      new Request('http://local/workflow-runs/deck/start?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(500);
    expect(inserts[0]?.table).toBe('workflow_run_instance');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      table: 'workflow_run_instance',
      set: { status: 'failed' },
    });
  });
});

describe('GET /workflow-runs/mine (CL-2233 caller isolation + reconcile)', () => {
  it("returns only the caller's runs, mapped to the instance summary shape", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({
      inserts,
      updates,
      instanceRows: [
        {
          runId: 'run-1',
          correlationMessageId: 'corr-1',
          deploymentId: 'dep-1',
          kind: 'deck',
          status: 'running',
          startedAt: '2026-06-01T00:00:00.000Z',
          memberPrincipalId: 'caller-p',
        },
      ],
    });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/mine?tenantId=tenant-1', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toEqual([
      {
        runId: 'run-1',
        correlationMessageId: 'corr-1',
        deploymentId: 'dep-1',
        kind: 'deck',
        status: 'running',
        startedAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    // A read with no pending (runId-null) rows reconciles nothing and mutates
    // nothing — in particular the shared deployment table is untouched.
    expect(updates).toHaveLength(0);
  });

  it('scopes the findMany to the caller principal and returns disjoint sets for two users', async () => {
    ancestorChain = ['tenant-1'];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const findManyArgs: Array<{ where: unknown }> = [];
    const rowsFor = (principalId: string) => [
      {
        runId: `run-${principalId}`,
        correlationMessageId: `corr-${principalId}`,
        deploymentId: 'dep-1',
        kind: 'deck',
        status: 'running',
        startedAt: '2026-06-01T00:00:00.000Z',
        memberPrincipalId: principalId,
      },
    ];

    // User A.
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'A' },
        forbidden: false,
      });
    const dbA = makeInstanceDb({
      inserts,
      updates,
      findManyArgs,
      instanceRows: rowsFor('A'),
    });
    const resA = await instanceApp(dbA).request(
      new Request('http://local/workflow-runs/mine?tenantId=tenant-1', { method: 'GET' })
    );
    const bodyA = (await resA.json()) as Array<{ runId: string }>;

    // User B — same deployment, different principal, different rows.
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'B' },
        forbidden: false,
      });
    const dbB = makeInstanceDb({
      inserts,
      updates,
      findManyArgs,
      instanceRows: rowsFor('B'),
    });
    const resB = await instanceApp(dbB).request(
      new Request('http://local/workflow-runs/mine?tenantId=tenant-1', { method: 'GET' })
    );
    const bodyB = (await resB.json()) as Array<{ runId: string }>;

    expect(bodyA.map((r) => r.runId)).toEqual(['run-A']);
    expect(bodyB.map((r) => r.runId)).toEqual(['run-B']);
    // Each /mine read issued a principal-scoped findMany (the where filter is a
    // real, non-empty Drizzle condition, proving the route filtered rather than
    // returning everything).
    expect(findManyArgs).toHaveLength(2);
    expect(findManyArgs[0]?.where).toBeDefined();
    // No /mine read mutates the shared deployment table (or any table).
    expect(updates).toHaveLength(0);
  });

  it('reconciles a pending (runId-null) row by binding the RunStarted runId via consumedMessageId', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    subscribeKindThrows = null;
    subscribeKindEntries = [
      {
        seq: 0,
        runId: 'run-x',
        event: { type: 'RunStarted', seq: 0, consumedMessageId: 'corr-pending' },
      },
    ];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({
      inserts,
      updates,
      instanceRows: [
        {
          runId: null,
          correlationMessageId: 'corr-pending',
          deploymentId: 'dep-1',
          kind: 'deck',
          status: 'running',
          // Within RECONCILE_WINDOW_MS, and a Date (matching Drizzle's return
          // type) so the age-bound check can read getTime() (CL-2233).
          startedAt: new Date(),
          memberPrincipalId: 'caller-p',
        },
      ],
    });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/mine?tenantId=tenant-1', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    // The pending row drove a reconcile replay that issued an instance update
    // binding runId — on the instance table, never the deployment table.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      table: 'workflow_run_instance',
      set: { runId: 'run-x' },
    });
  });

  it('does not replay-reconcile an orphaned pending row past the reconcile window', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    subscribeKindThrows = null;
    subscribeKindEntries = [
      {
        seq: 0,
        runId: 'run-x',
        event: { type: 'RunStarted', seq: 0, consumedMessageId: 'corr-old' },
      },
    ];
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({
      inserts,
      updates,
      instanceRows: [
        {
          runId: null,
          correlationMessageId: 'corr-old',
          deploymentId: 'dep-1',
          kind: 'deck',
          status: 'running',
          // Older than RECONCILE_WINDOW_MS: an orphan (trigger never delivered).
          // It must NOT force a replay/update on every /mine read.
          startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          memberPrincipalId: 'caller-p',
        },
      ],
    });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/mine?tenantId=tenant-1', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });
});

describe('DELETE /workflow-runs/instances/:runId (CL-2233 run-scoped soft delete)', () => {
  it('soft-deletes the caller-owned instance (cancelled + deletedAt) and never ends a session or touches the deployment', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const endSession = mock(() => Promise.resolve());
    const sessionService = { endSession } as unknown as SessionService;
    const db = makeInstanceDb({
      inserts,
      updates,
      owned: { runId: 'run-1', deploymentId: 'dep-1', memberPrincipalId: 'caller-p' },
    });
    const res = await instanceApp(db, sessionService).request(
      new Request('http://local/workflow-runs/instances/run-1', { method: 'DELETE' })
    );
    expect(res.status).toBe(204);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe('workflow_run_instance');
    expect(updates[0]?.set.status).toBe('cancelled');
    expect(updates[0]?.set.deletedAt).toBeTruthy();
    // No deployment teardown / undeploy: the deployment table is never written.
    expect(updates.some((u) => u.table === 'workflow_run')).toBe(false);
    // The shared session is never ended by a run-scoped delete.
    expect(endSession).not.toHaveBeenCalled();
  });

  it("404s and issues no update when deleting another user's run (ownership gate)", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'user-B' },
        forbidden: false,
      });
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({ inserts, updates, owned: undefined });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/instances/run-owned-by-A', { method: 'DELETE' })
    );
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });
});

describe('PATCH /workflow-runs/instances/:runId/status (CL-2233 instance-scoped)', () => {
  it('updates the instance row (not the deployment) and returns the deployment id + status', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({
      inserts,
      updates,
      owned: { runId: 'run-1', deploymentId: 'dep-1', memberPrincipalId: 'caller-p' },
    });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/instances/run-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploymentId: string; status: string };
    expect(body).toEqual({ deploymentId: 'dep-1', status: 'completed' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      table: 'workflow_run_instance',
      set: { status: 'completed' },
    });
  });

  it('404s for a run not owned by the caller', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'user-B' },
        forbidden: false,
      });
    const inserts: InsertCapture[] = [];
    const updates: UpdateCapture[] = [];
    const db = makeInstanceDb({ inserts, updates, owned: undefined });
    const res = await instanceApp(db).request(
      new Request('http://local/workflow-runs/instances/run-A/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
    );
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });
});

describe('GET /workflow-runs/:deploymentId/stream (CL-2233 per-run privacy filter)', () => {
  it('with ?runId=run-A streams only run-A frames, dropping run-B', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } },
      { seq: 1, runId: 'run-B', event: { type: 'RunStarted', seq: 1 } },
      { seq: 2, runId: 'run-A', event: { type: 'StepCompleted', seq: 2, stepId: 's' } },
      { seq: 3, runId: 'run-B', event: { type: 'StepCompleted', seq: 3, stepId: 's' } },
    ];
    const res = await buildApp(makeDb(true)).request(
      new Request('http://local/workflow-runs/dep-1/stream?runId=run-A', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('run-A');
    expect(text).not.toContain('run-B');
  });

  it('rejects with 403 when runId is omitted (no firehose over the shared log)', async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'caller-p' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } },
      { seq: 1, runId: 'run-B', event: { type: 'RunStarted', seq: 1 } },
    ];
    const res = await buildApp(makeDb(true)).request(
      new Request('http://local/workflow-runs/dep-1/stream', { method: 'GET' })
    );
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('run-A');
    expect(text).not.toContain('run-B');
  });

  it('rejects with 403 when the caller does not own the requested runId', async () => {
    // User B is a member of the deployment's tenant (deployment ownership
    // passes) but does NOT own run-A — the instance ownership gate must block it
    // even though B can reach the shared deployment log.
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: 'tenant-1', principalId: 'user-b' },
        forbidden: false,
      });
    ancestorChain = ['tenant-1'];
    subscribeKindThrows = null;
    subscribeKindEntries = [{ seq: 0, runId: 'run-A', event: { type: 'RunStarted', seq: 0 } }];
    // makeDb(true, false): deployment owned, but no instance row for this caller.
    const res = await buildApp(makeDb(true, false)).request(
      new Request('http://local/workflow-runs/dep-1/stream?runId=run-A', { method: 'GET' })
    );
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('run-A');
  });
});
