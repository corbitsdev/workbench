import { describe, expect, it, mock } from 'bun:test';

// Mock inference lib before any module that loads it at module-evaluation time
mock.module('../lib/inference', () => ({
  buildInferenceSource: mock(() => ({
    id: 'src-1',
    provider: 'openai',
    baseURL: '',
    apiKey: '',
    model: '',
  })),
  runSingleTurnAgent: mock(() => Promise.resolve('')),
}));
mock.module('../lib/extraction', () => ({
  extractPainPoints: mock(() => Promise.resolve({ companyName: 'Acme', painPoints: [] })),
}));
mock.module('../lib/generation', () => ({
  generateCollateralWithLLM: mock(() => Promise.resolve({ title: 'Test', body: 'content' })),
}));
mock.module('../lib/feedback', () => ({
  refineFeedbackWithLLM: mock(() => Promise.resolve('refined')),
}));

import { createWorkflowRouter } from './workflow';

// ─── Shared mock DB factory ─────────────────────────────────────────

function createMockDb(overrides: Record<string, unknown> = {}) {
  const db = {
    query: {
      tenant: {
        findFirst: mock(() => Promise.resolve({ id: 'tenant-1', slug: 'user-user-1' })),
      },
      principal: {
        findFirst: mock(() =>
          Promise.resolve({ id: 'principal-1', kind: 'user', refId: 'user-1' })
        ),
      },
      workflowRun: {
        findFirst: mock(() =>
          Promise.resolve({
            id: 'wf-1',
            tenantId: 'tenant-1',
            principalId: 'principal-1',
            kind: 'collateral-generation',
            status: 'pending',
            input: { transcriptId: 'tx-1', companyName: 'Acme' },
            createdAt: new Date().toISOString(),
          })
        ),
        findMany: mock(() => Promise.resolve([])),
      },
      transcript: {
        findFirst: mock(() => Promise.resolve({ id: 'tx-1', content: 'Transcript text' })),
      },
      painPoint: { findMany: mock(() => Promise.resolve([])) },
      artifact: {
        findMany: mock(() => Promise.resolve([])),
        findFirst: mock(() => Promise.resolve(null)),
      },
      agentInstance: {
        // Default: approve any agentId by echoing it back as owned by the test tenant.
        // Individual tests that need to exercise the ownership-check rejection path
        // should override this mock with .mockResolvedValueOnce([]).
        findMany: mock((opts: { where?: unknown } = {}) => {
          void opts;
          return Promise.resolve([
            { id: 'agent-abc', tenantId: 'tenant-1' },
            { id: 'agent-def', tenantId: 'tenant-1' },
            { id: 'agent-xyz', tenantId: 'tenant-1' },
            { id: 'agent-1', tenantId: 'tenant-1' },
          ]);
        }),
      },
    },
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{ id: 'wf-1', status: 'pending', input: {} }])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => Promise.resolve()),
    })),
    ...overrides,
  };
  return db;
}

function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {}
): Request {
  const { method = 'GET', body, userId = 'user-1' } = opts;
  const headers: Record<string, string> = { 'x-user-id': userId };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

function wrapRouter(db: ReturnType<typeof createMockDb>) {
  const { Hono } = require('hono') as typeof import('hono');
  const inner = createWorkflowRouter(db);
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user-id') ?? 'user-1');
    await next();
  });
  app.route('/', inner);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('PATCH /workflows/:id/step-config', () => {
  it('saves a valid stepConfig and returns 200', async () => {
    let savedInput: unknown;
    const db = createMockDb();
    (db.update as ReturnType<typeof mock>).mockImplementation(() => ({
      set: mock((vals: { input?: unknown }) => {
        if (vals.input !== undefined) savedInput = vals.input;
        return { where: mock(() => Promise.resolve([])) };
      }),
    }));

    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: {
        stepConfig: {
          analyze: { agentId: 'agent-abc', toolIds: ['web_search'] },
          generate: { agentId: 'agent-def', toolIds: [] },
        },
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe('wf-1');
    expect(json.stepConfig).toMatchObject({
      analyze: { agentId: 'agent-abc', toolIds: ['web_search'] },
      generate: { agentId: 'agent-def', toolIds: [] },
    });
    expect(savedInput).toMatchObject({
      stepConfig: {
        analyze: { agentId: 'agent-abc', toolIds: ['web_search'] },
      },
    });
  });

  it('accepts an empty stepConfig object', async () => {
    const db = createMockDb();
    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: { stepConfig: {} },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
  });

  it('accepts stepConfig with only some steps configured', async () => {
    const db = createMockDb();
    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: {
        stepConfig: {
          improve: { agentId: 'agent-xyz' },
        },
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stepConfig.improve).toMatchObject({ agentId: 'agent-xyz' });
  });

  it('returns 400 when stepConfig is missing from body', async () => {
    const db = createMockDb();
    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: { unrelated: 'field' },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when stepConfig contains an unknown step key', async () => {
    const db = createMockDb();
    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: {
        stepConfig: {
          bogusStep: { agentId: 'agent-1' },
        },
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when workflow does not belong to user', async () => {
    const db = createMockDb();
    (db.query.workflowRun.findFirst as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );

    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/no-such-wf/step-config', {
      method: 'PATCH',
      body: { stepConfig: {} },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 when stepConfig contains an agentId from a different tenant', async () => {
    const db = createMockDb();
    // Override agentInstance.findMany to return empty — simulates cross-tenant agentId
    // that does not appear in the user's tenant.
    (db.query.agentInstance.findMany as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );

    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: {
        stepConfig: {
          analyze: { agentId: 'agent-from-other-tenant' },
        },
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('agentId');
  });

  it('returns 400 when user context cannot be resolved', async () => {
    const db = createMockDb();
    (db.query.tenant.findFirst as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );

    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1/step-config', {
      method: 'PATCH',
      body: { stepConfig: {} },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /workflows/:id returns stepConfig', () => {
  it('includes stepConfig when present in stored input', async () => {
    const db = createMockDb();
    db.query.workflowRun.findFirst = mock(() =>
      Promise.resolve({
        id: 'wf-1',
        tenantId: 'tenant-1',
        principalId: 'principal-1',
        kind: 'collateral-generation',
        status: 'pending',
        input: {
          transcriptId: 'tx-1',
          companyName: 'Acme',
          stepConfig: {
            analyze: { agentId: 'agent-abc', toolIds: ['web_search'] },
          },
        },
        createdAt: new Date().toISOString(),
      })
    );

    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stepConfig).toMatchObject({
      analyze: { agentId: 'agent-abc', toolIds: ['web_search'] },
    });
  });

  it('returns stepConfig as empty object when not set', async () => {
    const db = createMockDb();
    const app = wrapRouter(db);
    const req = makeRequest('http://localhost/workflows/wf-1');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stepConfig).toEqual({});
  });
});
