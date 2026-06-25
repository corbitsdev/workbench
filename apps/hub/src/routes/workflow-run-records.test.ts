import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { CryptoProvider } from '@intx/types/runtime';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import type { HubDb } from '../db';
import type { RunState } from '../workflow-executor/executor';

// Override only getAncestorChain (the routes walk the tenant chain); preserve
// every other @intx/db export so sibling suites in the same process keep theirs.
const realDb = await import('@intx/db');
let ancestorChain: readonly string[] = ['tn-1'];
mock.module('@intx/db', () => ({
  ...realDb,
  getAncestorChain: async () => [...ancestorChain],
}));

// In-memory run-store: the row is the durable record the UI polls. insert seeds
// it at /start, save updates it (the optimistic resume flip, and what the
// projection bridge would do), load reads it back — including deploymentId, which
// resume needs to address the sidecar.
const runs = new Map<string, RunState>();
mock.module('../workflow-executor/run-store', () => ({
  createRunStore: () => ({
    save: async (state: RunState) => {
      runs.set(state.runId, structuredClone(state));
    },
  }),
  insertRunRecord: async (
    _db: unknown,
    args: {
      runId: string;
      deploymentId: string | null;
      kind: string;
      tenantId: string;
      principalId: string;
      input: unknown;
    }
  ) => {
    const state: RunState = {
      runId: args.runId,
      kind: args.kind,
      tenantId: args.tenantId,
      principalId: args.principalId,
      status: 'running',
      currentStepId: null,
      input: args.input,
      outputs: {},
      ...(args.deploymentId !== null ? { deploymentId: args.deploymentId } : {}),
    };
    runs.set(state.runId, structuredClone(state));
    return state;
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    return found ? structuredClone(found) : null;
  },
  listRunRecords: async (
    _db: unknown,
    _tenantIds: readonly string[],
    principalId: string,
    kind?: string
  ) =>
    [...runs.values()]
      .filter((r) => r.principalId === principalId)
      .filter((r) => kind === undefined || r.kind === kind)
      .map((r) => ({
        runId: r.runId,
        kind: r.kind,
        status: r.status,
        createdAt: new Date(),
      })),
}));

const { createWorkflowRunRecordsRouter } = await import('./workflow-run-records');

// Captured sidecar interactions, asserted per test.
const sentMessages: Array<{ agentAddress: string; messageId: string; content: string }> = [];
const sentSignals: Array<{
  agentAddress: string;
  runId: string;
  signalName: string;
  payload: unknown;
}> = [];
const ensureCalls: Array<{ deploymentId: string; creatorPrincipalId: string }> = [];
let sendShouldThrow = false;

function resetCaptures(): void {
  runs.clear();
  sentMessages.length = 0;
  sentSignals.length = 0;
  ensureCalls.length = 0;
  sendShouldThrow = false;
}

const sessionService = {
  sendUserMessage: async (args: { agentAddress: string; messageId: string; content: string }) => {
    if (sendShouldThrow) throw new Error('sidecar unreachable');
    sentMessages.push({
      agentAddress: args.agentAddress,
      messageId: args.messageId,
      content: args.content,
    });
  },
} as unknown as SessionService;

const sidecarRouter = {
  sendSignalDeliver: (args: {
    agentAddress: string;
    runId: string;
    signalName: string;
    payload: unknown;
  }) => {
    sentSignals.push({
      agentAddress: args.agentAddress,
      runId: args.runId,
      signalName: args.signalName,
      payload: args.payload,
    });
  },
} as unknown as SidecarRouter;

const ensureDeploymentRoutable = async (args: {
  deploymentId: string;
  creatorPrincipalId: string;
}) => {
  ensureCalls.push({
    deploymentId: args.deploymentId,
    creatorPrincipalId: args.creatorPrincipalId,
  });
  return { reestablished: false };
};

const DEFAULT_DEPLOYMENT = {
  deploymentId: 'ses_dep1',
  tenantId: 'tn-1',
  kind: 'pain-point-collateral',
  principalId: 'prn-deployer',
  createdAt: new Date(),
};

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;
function makeDb(deployments: Array<typeof DEFAULT_DEPLOYMENT> = [DEFAULT_DEPLOYMENT]): HubDb {
  const db: MockDb = {
    query: {
      workflowRun: {
        findMany: async () => deployments,
        findFirst: async () => deployments[0],
      },
    },
  };
  return db as HubDb;
}

function routerWith(opts: {
  db?: HubDb;
  context?: { tenantId: string; principalId: string };
}): Hono<{ Variables: { userId: string } }> {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route(
    '/',
    createWorkflowRunRecordsRouter({
      db: opts.db ?? makeDb(),
      sidecarRouter,
      sessionService,
      cryptoProvider: {} as CryptoProvider,
      deploymentDomain: 'wf.localhost',
      ensureDeploymentRoutable,
      resolveContext: async () => ({
        context: opts.context ?? { tenantId: 'tn-1', principalId: 'prn-1' },
        forbidden: false,
      }),
    })
  );
  return a;
}

function app(): Hono<{ Variables: { userId: string } }> {
  return routerWith({});
}

function appAs(ctx: { tenantId: string; principalId: string }): Hono<{
  Variables: { userId: string };
}> {
  return routerWith({ context: ctx });
}

type AppHono = Hono<{ Variables: { userId: string } }>;

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function post(
  a: AppHono,
  path: string,
  body: unknown
): Promise<{ status: number; json: any }> {
  const res = await a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function get(a: AppHono, path: string): Promise<{ status: number; json: any }> {
  const res = await a.request(path);
  return { status: res.status, json: await res.json() };
}

describe('workflow runs on the sidecar (records router)', () => {
  test('start seeds a running run record and fires the sidecar trigger with messageId == runId', async () => {
    resetCaptures();
    const a = app();
    const { status, json } = await post(a, '/workflow-exec/pain-point-collateral/start', {
      input: { topic: 'Acme' },
    });

    expect(status).toBe(200);
    expect(json.status).toBe('running');
    expect(json.currentStepId).toBeNull();
    expect(json.outputs).toEqual({});
    expect(typeof json.runId).toBe('string');
    // The response surfaces the producing deployment so the UI can resolve the
    // exact deployed version that ran (CL-2321), not the newest of the kind.
    expect(json.deploymentId).toBe('ses_dep1');

    // The linchpin of the projection bridge: the trigger mail's messageId IS the
    // run record id, so the supervisor-derived runId on every emitted event
    // matches the seeded row.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.messageId).toBe(json.runId);
    expect(sentMessages[0]?.content).toBe(JSON.stringify({ topic: 'Acme' }));

    // Supervisor re-established with the DEPLOYMENT owner's principal, not the caller's.
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]?.deploymentId).toBe('ses_dep1');
    expect(ensureCalls[0]?.creatorPrincipalId).toBe('prn-deployer');
  });

  test('start returns 404 when no workflow of the kind is deployed', async () => {
    resetCaptures();
    const a = routerWith({ db: makeDb([]) });
    const { status } = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    expect(status).toBe(404);
    expect(sentMessages).toHaveLength(0);
  });

  test('start marks the run failed and 500s when the sidecar trigger send throws', async () => {
    resetCaptures();
    sendShouldThrow = true;
    const a = app();
    const { status, json } = await post(a, '/workflow-exec/pain-point-collateral/start', {
      input: {},
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/failed to start/);
    // The seeded row was flipped to failed so the UI doesn't poll a phantom run.
    const seeded = [...runs.values()][0];
    expect(seeded?.status).toBe('failed');
  });

  test('resume delivers the gate signal to the sidecar and optimistically marks running', async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;
    // Simulate the bridge having parked the row at a gate.
    const parked = runs.get(runId);
    if (parked) runs.set(runId, { ...parked, status: 'awaiting', currentStepId: 'select' });

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'note-selection',
      payload: { noteId: 'n1' },
    });

    expect(r.status).toBe(200);
    expect(r.json.status).toBe('running'); // optimistic flip so the UI resumes polling
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.runId).toBe(runId);
    expect(sentSignals[0]?.signalName).toBe('note-selection');
    expect(sentSignals[0]?.payload).toEqual({ noteId: 'n1' });
  });

  test('resume on an unknown run is 404 and sends no signal', async () => {
    resetCaptures();
    const a = app();
    const r = await post(a, '/workflow-exec/records/wfr_missing/resume', {
      signalName: 'x',
      payload: {},
    });
    expect(r.status).toBe(404);
    expect(sentSignals).toHaveLength(0);
  });

  test('GET run state is a single record read', async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.runId).toBe(start.json.runId);
    expect(read.json.status).toBe('running');
    // deploymentId persisted at start round-trips through the read DTO.
    expect(read.json.deploymentId).toBe('ses_dep1');
  });

  test('GET /records lists only the callers own runs (per-user private)', async () => {
    resetCaptures();
    const mine = app();
    const theirs = appAs({ tenantId: 'tn-1', principalId: 'prn-other' });
    const start = await post(mine, '/workflow-exec/pain-point-collateral/start', { input: {} });
    await post(theirs, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const list = await get(mine, '/workflow-exec/records');
    expect(list.status).toBe(200);
    const ids = list.json.map((r: { runId: string }) => r.runId);
    expect(ids).toContain(start.json.runId);
    expect(ids).toHaveLength(1);
  });

  test('cross-user GET /records/:runId is forbidden 403', async () => {
    resetCaptures();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const intruder = appAs({ tenantId: 'tn-1', principalId: 'prn-other' });
    const read = await get(intruder, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(403);
    expect(read.json.error).toBe('Forbidden');
  });

  test('cross-user resume is forbidden 403 and sends no signal', async () => {
    resetCaptures();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const intruder = appAs({ tenantId: 'tn-1', principalId: 'prn-other' });
    const r = await post(intruder, `/workflow-exec/records/${start.json.runId}/resume`, {
      signalName: 'note-selection',
      payload: {},
    });
    expect(r.status).toBe(403);
    expect(sentSignals).toHaveLength(0);
  });

  test('a run in a tenant outside the callers chain reads as 404', async () => {
    resetCaptures();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    ancestorChain = ['tn-9'];
    try {
      const read = await get(
        appAs({ tenantId: 'tn-9', principalId: 'prn-9' }),
        `/workflow-exec/records/${start.json.runId}`
      );
      expect(read.status).toBe(404);
    } finally {
      ancestorChain = ['tn-1'];
    }
  });
});
