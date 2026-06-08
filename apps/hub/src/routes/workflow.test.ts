import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createWorkflowRouter } from './workflow';

import * as intxDb from '@intx/db';
import type { HubDb } from '../db';

mock.module('@intx/db', () => ({
  ...intxDb,
  resolveCredentialRequirement: mock(async () => ({
    id: 'cred-1',
    providerId: 'prov-1',
    secret: 'enc:v1:test',
    tenantId: 'tenant-personal',
    principalId: null,
    name: 'Workflow LLM',
  })),
  resolveCredentialById: mock(async (_db: unknown, _tenantId: string, id: string) => ({
    id,
    providerId: 'prov-1',
    secret: 'enc:v1:test',
    tenantId: 'tenant-personal',
    principalId: null,
    name: id,
  })),
  resolveInstanceSources: mock(async () => [
    {
      id: 'agent-source-1',
      provider: 'openai',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'enc:v1:agent',
      model: 'agent-model',
    },
  ]),
}));

mock.module('@workbench/hub-crypto', () => ({
  decryptSecret: mock(() => 'sk-test-key'),
  parseEncryptionKeys: mock(() => ({})),
}));

mock.module('../config', () => ({
  getConfig: mock(() => ({
    credentialKeys: {},
  })),
  loadConfig: mock(() => {}),
}));

const extractionSources: Array<{ model?: string } | undefined> = [];

mock.module('../lib/extraction', () => ({
  extractPainPoints: mock(
    (_id: unknown, _content: unknown, _feedback: unknown, source?: { model?: string }) => {
      extractionSources.push(source);
      return Promise.resolve({
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
      });
    }
  ),
}));

const PERSONAL_TENANT = { id: 'tenant-personal', slug: 'user-test-user' };
const PERSONAL_PRINCIPAL = {
  id: 'prn-personal',
  tenantId: 'tenant-personal',
  kind: 'user',
  refId: 'test-user',
};
const WORKSPACE_PRINCIPAL = {
  id: 'prn-workbench',
  tenantId: 'tenant-workbench',
  kind: 'user',
  refId: 'test-user',
};

describe('Workflow router', () => {
  type PrincipalRow = typeof PERSONAL_PRINCIPAL;
  type WorkflowRunListRow = {
    id: string;
    status: string;
    input: { companyName: string };
    tenantId: string;
    principalId: string;
    kind: string;
  };

  function createPrincipalSequence(...rows: Array<PrincipalRow | null>) {
    let index = 0;
    return mock(() => {
      const row = rows[index];
      index += 1;
      return row ?? null;
    });
  }

  function createMockDb(
    options: { onInsertValues?: (values: unknown) => void; providerNameQueue?: string[] } = {}
  ) {
    let insertCount = 0;
    const providerNameQueue = [...(options.providerNameQueue ?? [])];

    return {
      query: {
        tenant: {
          findFirst: mock(() => PERSONAL_TENANT),
        },
        principal: {
          findFirst: mock<() => PrincipalRow | null>(() => PERSONAL_PRINCIPAL),
        },
        workflowRun: {
          findFirst: mock<
            () =>
              | {
                  id: string;
                  status: string;
                  principalId: string;
                  input: { companyName: string; transcriptId: string };
                }
              | null
              | undefined
          >(() => ({
            id: 'wf-1',
            status: 'pending',
            principalId: PERSONAL_PRINCIPAL.id,
            input: { companyName: 'Test Corp', transcriptId: 'tx-1' },
          })),
          findMany: mock<() => WorkflowRunListRow[]>(() => []),
        },
        transcript: {
          findFirst: mock(() => ({ content: 'Test transcript content' })),
        },
        painPoint: {
          findMany: mock<() => unknown[]>(() => []),
        },
        artifact: {
          findMany: mock<() => unknown[]>(() => []),
          findFirst: mock(() => null),
        },
        agentInstance: {
          findMany: mock<() => unknown[]>(() => []),
          findFirst: mock(() => ({
            id: 'inst-oat',
            agentId: 'agent-oat',
            tenantId: 'tenant-personal',
            sessionId: null,
          })),
        },
        enabledWorkflow: {
          findFirst: mock(() => ({
            id: 'ew-1',
            tenantId: 'tenant-personal',
            kind: 'collateral-generation',
            enabledAt: new Date().toISOString(),
          })),
        },
        provider: {
          findFirst: mock(() => ({
            id: 'prov-1',
            plugin: 'openai',
            name: providerNameQueue.length > 0 ? providerNameQueue.shift() : 'openai-compatible',
            metadata: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
          })),
        },
      },
      delete: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
      insert: mock(() => ({
        values: mock((values: unknown) => {
          options.onInsertValues?.(values);
          insertCount += 1;
          const row =
            insertCount === 1
              ? { id: 'tx-1', status: 'created', kind: 'transcript' }
              : { id: 'wf-1', status: 'analyzing', kind: 'collateral-generation' };
          return {
            returning: mock(() => [row]),
            onConflictDoUpdate: mock(() => ({
              returning: mock(() => [
                {
                  id: 'ew-1',
                  tenantId: 'tenant-personal',
                  kind: 'collateral-generation',
                  enabledAt: new Date().toISOString(),
                },
              ]),
            })),
          };
        }),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => []),
        })),
      })),
    };
  }

  function buildApp(db: ReturnType<typeof createMockDb>, userId = 'test-user') {
    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use('*', async (c, next) => {
      c.set('userId', userId);
      await next();
    });
    parent.route('/', createWorkflowRouter(db as unknown as HubDb));
    return parent;
  }

  it('POST /workflows creates a workflow', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'Hello world',
        source: 'paste',
        workflowKind: 'collateral-generation',
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.id).toBeString();
    expect(json.status).toBe('analyzing');
    expect(json.steps.intake.completed).toBe(true);
  });

  it('POST /workflows stores a workflow under the requested workbench tenant', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = createMockDb({ onInsertValues: (values) => insertedValues.push(values) });
    mockDb.query.principal.findFirst = createPrincipalSequence(
      PERSONAL_PRINCIPAL,
      WORKSPACE_PRINCIPAL
    );

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'Hello workbench world',
        source: 'paste',
        workflowKind: 'collateral-generation',
        tenantId: 'tenant-workbench',
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(201);
    expect(insertedValues[1]).toMatchObject({
      tenantId: 'tenant-workbench',
      principalId: 'prn-workbench',
    });
  });

  it('GET /workflows/:id returns workflow state', async () => {
    const router = buildApp(createMockDb());
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

  it('GET /artifacts returns the user artifacts enriched with session info', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findMany = mock(() => [
      {
        id: 'wf-1',
        status: 'done',
        input: { companyName: 'Acme Corp' },
        tenantId: 't-1',
        principalId: 'p-1',
        kind: 'collateral-generation',
      },
    ]);
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'a-1',
        sessionId: 'wf-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Sales automation ROI',
        content: 'body',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/artifacts', { method: 'GET' });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe('a-1');
    expect(json[0].sessionName).toBe('Acme Corp');
    expect(json[0].sessionStatus).toBe('done');
  });

  it('GET /artifacts checks membership before returning workbench-scoped artifacts', async () => {
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(
      PERSONAL_PRINCIPAL,
      WORKSPACE_PRINCIPAL
    );
    mockDb.query.workflowRun.findMany = mock(() => [
      {
        id: 'wf-workbench',
        status: 'done',
        input: { companyName: 'Workbench Corp' },
        tenantId: 'tenant-workbench',
        principalId: 'prn-workbench',
        kind: 'collateral-generation',
      },
    ]);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/artifacts?tenantId=tenant-workbench', {
      method: 'GET',
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    expect(mockDb.query.principal.findFirst).toHaveBeenCalledTimes(2);
  });

  it('GET /artifacts returns 403 when the requested tenant is inaccessible', async () => {
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(PERSONAL_PRINCIPAL, null);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/artifacts?tenantId=tenant-other', {
      method: 'GET',
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(403);
  });

  it('GET /artifacts returns 403 when the requesting user is deactivated in the workbench', async () => {
    // DB returns null because the status='active' filter excludes the row
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(PERSONAL_PRINCIPAL, null);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/artifacts?tenantId=tenant-workbench', {
      method: 'GET',
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(403);
  });

  it('POST /workflows returns 403 when the requesting user is deactivated in the workbench', async () => {
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(PERSONAL_PRINCIPAL, null);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'Hello',
        source: 'paste',
        workflowKind: 'collateral-generation',
        tenantId: 'tenant-workbench',
      }),
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(403);
  });

  it('GET /artifacts returns an empty array when the user has no sessions', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findMany = mock(() => []);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/artifacts', { method: 'GET' });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toEqual([]);
  });

  it('POST /workflows/:id/steps generate returns 404 when workflow belongs to another user', async () => {
    const mockDb = createMockDb();
    // Simulate no matching workflow for this user's principalId
    mockDb.query.workflowRun.findFirst = mock(() => null);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-other/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'generate' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(404);
  });

  it('POST /workflows/:id/steps runs analyze step', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
  });

  it('POST /workflows/:id/steps analyze runs via the assigned agent inference source', async () => {
    extractionSources.length = 0;
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(() => ({
      id: 'wf-1',
      status: 'pending',
      principalId: PERSONAL_PRINCIPAL.id,
      input: {
        companyName: 'Test Corp',
        transcriptId: 'tx-1',
        stepConfig: { analyze: { agentId: 'inst-oat' } },
      },
    })) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    // The agent's own inference source (model 'agent-model') must drive the step,
    // not the step's inline workflow credential.
    expect(extractionSources.at(-1)?.model).toBe('agent-model');
  });

  it('POST /workflows/:id/steps analyze fails when the assigned agent has no inference source', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(() => ({
      id: 'wf-1',
      status: 'pending',
      principalId: PERSONAL_PRINCIPAL.id,
      input: {
        companyName: 'Test Corp',
        transcriptId: 'tx-1',
        stepConfig: { analyze: { agentId: 'inst-oat' } },
      },
    })) as typeof mockDb.query.workflowRun.findFirst;
    (intxDb.resolveInstanceSources as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('agent');
  });

  it('DELETE /workflows/:id removes the workflow', async () => {
    const deleteWheres: unknown[] = [];
    const mockDb = createMockDb();
    mockDb.delete = mock(() => ({
      where: mock((arg: unknown) => {
        deleteWheres.push(arg);
        return Promise.resolve();
      }),
    })) as typeof mockDb.delete;

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1', { method: 'DELETE' });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; deleted: boolean };
    expect(body).toEqual({ id: 'wf-1', deleted: true });
    expect(deleteWheres.length).toBe(1);
  });

  it('DELETE /workflows/:id returns 404 when the workflow belongs to another user', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(() => null);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-other', { method: 'DELETE' });

    const res = await router.fetch(req);
    expect(res.status).toBe(404);
  });

  it('POST /workflows/:id/steps analyze accepts feedback', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze', feedback: 'focus on automation pain' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.status).toBe('running');
    expect(json.steps.analyze.completed).toBe(true);
  });

  it('POST /workflows/:id/steps analyze is idempotent (re-run replaces pain points)', async () => {
    const deletedWhere: unknown[] = [];
    const mockDb = createMockDb();
    mockDb.delete = mock(() => ({
      where: mock(() => {
        deletedWhere.push(true);
        return Promise.resolve();
      }),
    }));

    const router = buildApp(mockDb);
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
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Sales automation ROI',
        content: 'Automating workflows saves 10 hours/week',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = buildApp(mockDb);
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
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Test',
        content: 'Test body',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = buildApp(mockDb);
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
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Automation *saves* time',
        content: 'Multi\nline\nbody',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = buildApp(mockDb);
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
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Test with "quotes"',
        content: 'Body with\nnewlines\nand "quotes"',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = buildApp(mockDb);
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
    expect(content).toContain('Kind,Title,Content');
  });

  it('POST /workflows/:id/steps export with json format', async () => {
    const mockDb = createMockDb();
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'c-1',
        painPointId: 'p-1',
        kind: 'email',
        title: 'Test',
        content: 'Body',
        status: 'approved',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockDb.query.painPoint.findMany = mock(() => [{ id: 'p-1' }]);

    const router = buildApp(mockDb);
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
    expect(parsed[0].kind).toBe('email');
  });

  it('POST /workflows/enabled rejects an unknown workflow kind', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'not-a-real-kind' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBeString();
  });

  const VALID_COLLATERAL_ASSIGNMENTS = {
    intake: { credentialIds: ['granola-cred'], toolIds: ['granola_list_notes'] },
    analyze: { credentialIds: ['llm-cred'], toolIds: [] },
    generate: { credentialIds: ['llm-cred'], toolIds: [] },
    improve: { credentialIds: ['llm-cred'], toolIds: [] },
  };
  // provider.findFirst is called once per assigned credential, in step order:
  // intake (granola), then analyze/generate/improve (openai-compatible).
  const COLLATERAL_PROVIDER_QUEUE = [
    'granola',
    'openai-compatible',
    'openai-compatible',
    'openai-compatible',
  ];

  it('POST /workflows/enabled stores valid assignments and is idempotent', async () => {
    const makeReq = () =>
      new Request('http://localhost:4000/workflows/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'collateral-generation',
          assignments: VALID_COLLATERAL_ASSIGNMENTS,
        }),
      });

    const res1 = await buildApp(
      createMockDb({ providerNameQueue: [...COLLATERAL_PROVIDER_QUEUE] })
    ).fetch(makeReq());
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.assignments.intake.credentialIds).toEqual(['granola-cred']);

    const res2 = await buildApp(
      createMockDb({ providerNameQueue: [...COLLATERAL_PROVIDER_QUEUE] })
    ).fetch(makeReq());
    expect(res2.status).toBe(200);
  });

  it('POST /workflows/enabled rejects install when a required credential is missing', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'collateral-generation', assignments: {} }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('granola');
  });

  it('POST /workflows/enabled rejects an unknown tool', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'collateral-generation',
        assignments: { intake: { credentialIds: [], toolIds: ['not-a-tool'] } },
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Unknown tool');
  });

  it('GET /workflows/catalog exposes per-step requirements', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(new Request('http://localhost:4000/workflows/catalog'));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    const collateral = parsed.find((w: { kind: string }) => w.kind === 'collateral-generation');
    expect(collateral.steps.length).toBeGreaterThan(0);
    const intake = collateral.steps.find((s: { name: string }) => s.name === 'intake');
    expect(intake.credentialRequirements[0].providerName).toBe('granola');
  });

  it('GET /workflows/tools returns tool metadata', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(new Request('http://localhost:4000/workflows/tools'));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    const granola = parsed.find((t: { name: string }) => t.name === 'granola_list_notes');
    expect(granola.providerName).toBe('granola');
  });

  it('POST /workflows returns 400 when workflowKind is missing', async () => {
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'Hello world', source: 'paste' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBeString();
  });

  it('POST /workflows returns 400 when the kind is not enabled for the tenant', async () => {
    const mockDb = createMockDb();
    // Override findFirst to simulate the workflow kind not being enabled for this tenant
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.query.enabledWorkflow.findFirst = mock(() => null) as any;

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'Hello world',
        source: 'paste',
        workflowKind: 'collateral-generation',
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBeString();
  });
});
