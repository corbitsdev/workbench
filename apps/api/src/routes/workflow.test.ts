import { describe, expect, it, mock } from 'bun:test';
import { createWorkflowRouter } from './workflow';

mock.module('../lib/extraction', () => ({
  extractPainPoints: mock(() =>
    Promise.resolve({
      companyName: 'Acme Corp',
      painPoints: [
        {
          sessionId: 'wf-1',
          severity: 'high' as const,
          context: 'Manual data entry is painful',
          quote: 'We spend hours copying data between sheets',
          selected: true,
        },
      ],
    })
  ),
}));

describe('Workflow router', () => {
  function createMockDb() {
    return {
      query: {
        workbenchSession: {
          findFirst: mock(() => ({ id: 'wf-1', status: 'analyzing', transcriptId: 'tx-1' })),
        },
        transcript: {
          findFirst: mock(() => ({ content: 'Test transcript content' })),
        },
        painPoint: {
          findMany: mock(() => [] as any[]),
        },
        collateralItem: {
          findMany: mock(() => [] as any[]),
          findFirst: mock(() => null),
        },
      },
      delete: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => [{ id: 'wf-1', status: 'analyzing' }]),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => []),
        })),
      })),
    };
  }

  it('POST /workflows creates a workflow', async () => {
    const router = createWorkflowRouter(createMockDb());
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'Hello world', source: 'paste' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.id).toBeString();
    expect(json.status).toBe('analyzing');
    expect(json.steps.intake.completed).toBe(true);
  });

  it('GET /workflows/:id returns workflow state', async () => {
    const router = createWorkflowRouter(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1', {
      method: 'GET',
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe('wf-1');
    expect(json.status).toBeString();
    expect(json.steps).toBeObject();
  });

  it('POST /workflows/:id/steps runs analyze step', async () => {
    const router = createWorkflowRouter(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
  });

  it('POST /workflows/:id/steps analyze accepts feedback', async () => {
    const router = createWorkflowRouter(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze', feedback: 'focus on automation pain' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.status).toBe('reviewing');
    expect(json.steps.analyze.completed).toBe(true);
  });

  it('POST /workflows/:id/steps analyze is idempotent (re-run replaces pain points)', async () => {
    const deletedWhere: unknown[] = [];
    const mockDb = createMockDb();
    mockDb.delete = mock(() => ({
      where: mock((condition: unknown) => {
        deletedWhere.push(condition);
        return Promise.resolve();
      }),
    }));

    const router = createWorkflowRouter(mockDb);
    const makeReq = () =>
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'analyze' }),
      });

    await router.fetch(makeReq());
    await router.fetch(makeReq());

    expect(deletedWhere.length).toBe(2);
  });

  it('POST /workflows/:id/steps export assembles collateral', async () => {
    const mockDb = createMockDb();
    mockDb.query.collateralItem.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        type: 'email',
        title: 'Sales automation ROI',
        body: 'Automating workflows saves 10 hours/week',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = createWorkflowRouter(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'export', target: 'markdown' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.status).toBe('done');
    expect(json.export).toBeObject();
    expect(json.export.target).toBe('markdown');
    expect(json.export.content).toBeString();
  });

  it('POST /workflows/:id/steps export rejects invalid target', async () => {
    const mockDb = createMockDb();
    mockDb.query.collateralItem.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        type: 'email',
        title: 'Test',
        body: 'Test body',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = createWorkflowRouter(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'export', target: 'invalid' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBeString();
  });

  it('POST /workflows/:id/steps export with markdown format', async () => {
    const mockDb = createMockDb();
    mockDb.query.collateralItem.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        type: 'email',
        title: 'Automation *saves* time',
        body: 'Multi\nline\nbody',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = createWorkflowRouter(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'export', target: 'markdown' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.export.content).toContain('## Automation \\*saves\\* time');
  });

  it('POST /workflows/:id/steps export with csv format handles newlines and quotes', async () => {
    const mockDb = createMockDb();
    mockDb.query.collateralItem.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        type: 'email',
        title: 'Test with "quotes"',
        body: 'Body with\nnewlines\nand "quotes"',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = createWorkflowRouter(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'export', target: 'csv' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    const content = json.export.content;
    expect(content).toBeString();
    expect(content).toContain('Type,Title,Body');
  });

  it('POST /workflows/:id/steps export with json format', async () => {
    const mockDb = createMockDb();
    mockDb.query.collateralItem.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        type: 'email',
        title: 'Test',
        body: 'Body',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = createWorkflowRouter(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'export', target: 'json' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.export.content).toBeString();
    const parsed = JSON.parse(json.export.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe('email');
  });
});
