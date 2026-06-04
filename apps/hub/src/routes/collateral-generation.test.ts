import { describe, expect, it, mock } from 'bun:test';
import { createCollateralGenerationRouter } from './collateral-generation';

mock.module('../lib/generation', () => ({
  generateCollateralWithLLM: mock(() =>
    Promise.resolve({ title: 'Generated Title', body: 'Generated body content' })
  ),
}));

describe('Collateral generation router', () => {
  function createMockDb() {
    const artifactRows = [
      {
        id: 'art-1',
        kind: 'case-study',
        title: 'Generated Title',
        content: 'Generated body content',
        status: 'approved',
        workflowId: 'wf-1',
        sessionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    return {
      query: {
        collateralGenerationWorkflow: {
          findFirst: mock(() => ({
            id: 'wf-1',
            userId: 'user-1',
            status: 'pending',
            inputArtifactIds: ['input-1'],
            outputTypes: ['case-study'],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })),
        },
        artifact: {
          findMany: mock(() => artifactRows),
        },
      },
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => [{ id: 'wf-1', status: 'pending' }]),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => Promise.resolve()),
        })),
      })),
    };
  }

  it('POST /collateral-generation creates a workflow', async () => {
    const router = createCollateralGenerationRouter(createMockDb());
    const req = new Request('http://localhost:4000/collateral-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'collateral-generation',
        inputArtifactIds: ['input-1'],
        outputTypes: ['case-study', 'one-pager'],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.id).toBeString();
    expect(json.status).toBe('pending');
  });

  it('POST /collateral-generation rejects empty inputArtifactIds', async () => {
    const router = createCollateralGenerationRouter(createMockDb());
    const req = new Request('http://localhost:4000/collateral-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'collateral-generation',
        inputArtifactIds: [],
        outputTypes: ['case-study'],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
  });

  it('POST /collateral-generation rejects empty outputTypes', async () => {
    const router = createCollateralGenerationRouter(createMockDb());
    const req = new Request('http://localhost:4000/collateral-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'collateral-generation',
        inputArtifactIds: ['input-1'],
        outputTypes: [],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
  });

  it('POST /collateral-generation rejects invalid outputType', async () => {
    const router = createCollateralGenerationRouter(createMockDb());
    const req = new Request('http://localhost:4000/collateral-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'collateral-generation',
        inputArtifactIds: ['input-1'],
        outputTypes: ['invalid-type'],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
  });

  it('GET /collateral-generation/:id returns workflow state', async () => {
    const router = createCollateralGenerationRouter(createMockDb());
    const req = new Request('http://localhost:4000/collateral-generation/wf-1', {
      method: 'GET',
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe('wf-1');
    expect(json.status).toBeString();
    expect(json.outputs).toBeObject();
  });

  it('GET /collateral-generation/:id returns 404 for unknown id', async () => {
    const mockDb = createMockDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb.query.collateralGenerationWorkflow as any).findFirst = mock(() => undefined);

    const router = createCollateralGenerationRouter(mockDb);
    const req = new Request('http://localhost:4000/collateral-generation/unknown', {
      method: 'GET',
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(404);
  });
});
