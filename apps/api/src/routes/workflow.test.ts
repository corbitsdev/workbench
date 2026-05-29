import { describe, expect, it, mock } from 'bun:test';
import { createWorkflowRouter } from './workflow';

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
          findMany: mock(() => []),
        },
        collateralItem: {
          findMany: mock(() => []),
          findFirst: mock(() => null),
        },
      },
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
});
