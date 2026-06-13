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
    secret: 'sk-test-key',
    tenantId: 'tenant-personal',
    principalId: null,
    name: 'Workflow LLM',
  })),
  resolveCredentialById: mock(async (_db: unknown, _tenantId: string, id: string) => ({
    id,
    providerId: 'prov-1',
    secret: 'sk-test-key',
    tenantId: 'tenant-personal',
    principalId: null,
    name: id,
  })),
  resolveInstanceSources: mock(async () => [
    {
      id: 'agent-source-1',
      provider: 'openai',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-key',
      model: 'agent-model',
    },
  ]),
}));

mock.module('@intx/crypto-node', () => ({
  generateKeyPair: mock(async () => ({ publicKey: 'pk', privateKey: 'sk' })),
  createNodeCrypto: mock(() => ({ sign: mock(() => 'sig'), verify: mock(() => true) })),
}));

mock.module('@intx/hub-common', () => ({
  generateId: mock((prefix: string) => `${prefix}-test-id`),
}));

mock.module('../config', () => ({
  getConfig: mock(() => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  })),
  loadConfig: mock(() => {}),
}));

const extractionSources: Array<{ model?: string } | undefined> = [];
const extractionMaxTokens: Array<number | undefined> = [];
const generatedKinds: string[] = [];

mock.module('../lib/extraction', () => ({
  extractPainPoints: mock(
    (
      _id: unknown,
      _content: unknown,
      _feedback: unknown,
      source?: { model?: string },
      maxOutputTokens?: number
    ) => {
      extractionSources.push(source);
      extractionMaxTokens.push(maxOutputTokens);
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

const getRecentNotesMock = mock(() => Promise.resolve([{ id: 'n-1', title: 'Call' }]));
const getNoteWithTranscriptMock = mock(() =>
  Promise.resolve({ title: 'Granola call', summary: 'summary' })
);

mock.module('../lib/granola', () => ({
  getRecentNotes: getRecentNotesMock,
  getNoteWithTranscript: getNoteWithTranscriptMock,
  transcriptToText: mock(() => 'granola transcript text'),
}));

mock.module('../lib/generation', () => ({
  generateCollateralWithLLM: mock(
    (
      _id: string,
      _transcript: string,
      _point: unknown,
      kind: string,
      _source: unknown,
      _maxOutputTokens?: number
    ) => {
      generatedKinds.push(kind);
      return Promise.resolve({ title: `${kind} title`, body: `${kind} body` });
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
    options: {
      onInsertValues?: (values: unknown) => void;
      providerNameQueue?: string[];
      onSetUpdate?: (values: Record<string, unknown>) => void;
      updateReturning?: unknown[];
    } = {}
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
                  kind: string;
                  input: { companyName: string; transcriptId: string };
                }
              | null
              | undefined
          >(() => ({
            id: 'wf-1',
            status: 'pending',
            principalId: PERSONAL_PRINCIPAL.id,
            kind: 'collateral-generation',
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
            principalId: 'prn-personal',
            kind: 'collateral-generation',
            enabledAt: new Date().toISOString(),
            assignments: {
              analyze: { credentialIds: ['llm-cred'], toolIds: [] },
              generate: { credentialIds: ['llm-cred'], toolIds: [] },
            },
          })),
          findMany: mock<() => unknown[]>(() => []),
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
        set: mock((values: Record<string, unknown>) => {
          options.onSetUpdate?.(values);
          // where() is awaited directly by status-only updates and chained with
          // returning() by updates that need the modified row.
          return {
            where: mock(() => ({ returning: mock(() => options.updateReturning ?? []) })),
          };
        }),
      })),
      transaction: mock((fn: (trx: unknown) => unknown) =>
        fn({
          insert: mock(() => ({
            values: mock((values: unknown) => ({
              returning: mock(() =>
                Array.isArray(values)
                  ? values.map((value, index) => ({ id: `a-${index + 1}`, ...value }))
                  : [{ id: 'a-1', ...(values as object) }]
              ),
            })),
          })),
        })
      ),
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

  it('POST /workflows creates a transcript artifact linked to the call', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = createMockDb({ onInsertValues: (values) => insertedValues.push(values) });

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
    expect(res.status).toBe(201);

    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        sessionId: 'wf-1',
        kind: 'call-transcript',
        title: 'Transcript — Pasted transcript',
        content: 'Hello world',
        status: 'approved',
      })
    );
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

  it('resolves user context via the global tenant slug, not the user- slug (CL-1452)', async () => {
    // Collect every string/param value referenced in a drizzle where clause.
    function collectValues(node: unknown, out: string[], seen = new Set()): void {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      // biome-ignore lint/suspicious/noExplicitAny: drizzle SQL introspection
      const n = node as any;
      if (typeof n.value === 'string') out.push(n.value);
      const children = Array.isArray(n) ? n : (n.queryChunks ?? Object.values(n));
      for (const child of children) collectValues(child, out, seen);
    }

    const mockDb = createMockDb();
    const res = await buildApp(mockDb).fetch(
      new Request('http://localhost:4000/workflows/enabled', { method: 'GET' })
    );
    expect(res.status).toBe(200);

    // The first tenant lookup is getUserContext resolving the working tenant.
    // biome-ignore lint/suspicious/noExplicitAny: test mock introspection
    const where = (mockDb.query.tenant.findFirst as any).mock.calls[0][0].where;
    const values: string[] = [];
    collectValues(where, values);
    expect(values).toContain('global-org');
    expect(values).not.toContain('user-test-user');
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

  // Approval gate: PATCH artifact status drives the reviewing -> done transition.
  function buildReviewApp(opts: {
    workflowStatus: string;
    remainingArtifacts: Array<{ kind: string; status: string }>;
  }) {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const approvedRow = {
      id: 'a-1',
      sessionId: 'wf-1',
      kind: 'email',
      title: 'T',
      content: 'B',
      status: 'approved',
      version: 1,
      painPointId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const mockDb = createMockDb({
      onSetUpdate: (vals) => statusUpdates.push(vals),
      updateReturning: [approvedRow],
    });
    mockDb.query.workflowRun.findFirst = mock(() => ({
      id: 'wf-1',
      status: opts.workflowStatus,
      principalId: PERSONAL_PRINCIPAL.id,
      kind: 'collateral-generation',
      input: { companyName: 'Test Corp', transcriptId: 'tx-1' },
    }));
    mockDb.query.artifact.findMany = mock(() =>
      opts.remainingArtifacts.map((a, i) => ({ id: `a-${i + 1}`, sessionId: 'wf-1', ...a }))
    );

    return { app: buildApp(mockDb), statusUpdates };
  }

  async function patchArtifactStatus(app: ReturnType<typeof buildApp>, status: string) {
    return app.fetch(
      new Request('http://localhost:4000/workflows/wf-1/artifacts/a-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    );
  }

  it('PATCH artifact status flips a reviewing workflow to done when no drafts remain', async () => {
    const { app, statusUpdates } = buildReviewApp({
      workflowStatus: 'reviewing',
      remainingArtifacts: [{ kind: 'email', status: 'approved' }],
    });
    const res = await patchArtifactStatus(app, 'approved');
    expect(res.status).toBe(200);
    expect(statusUpdates).toContainEqual({ status: 'done' });
  });

  it('PATCH artifact status keeps the workflow reviewing while a draft remains', async () => {
    const { app, statusUpdates } = buildReviewApp({
      workflowStatus: 'reviewing',
      remainingArtifacts: [
        { kind: 'email', status: 'approved' },
        { kind: 'linkedin-post', status: 'draft' },
      ],
    });
    const res = await patchArtifactStatus(app, 'approved');
    expect(res.status).toBe(200);
    expect(statusUpdates).not.toContainEqual({ status: 'done' });
  });

  it('PATCH artifact status does not re-complete an already-done workflow', async () => {
    const { app, statusUpdates } = buildReviewApp({
      workflowStatus: 'done',
      remainingArtifacts: [{ kind: 'email', status: 'rejected' }],
    });
    const res = await patchArtifactStatus(app, 'rejected');
    expect(res.status).toBe(200);
    expect(statusUpdates).not.toContainEqual({ status: 'done' });
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

  it('GET /artifacts falls back to a real call title instead of Untitled job', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findMany = mock(() => [
      {
        id: 'wf-1',
        status: 'done',
        input: { companyName: '', callTitle: 'Demo with Globex' },
        tenantId: 'tenant-personal',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'collateral-generation',
      },
    ]);
    mockDb.query.artifact.findMany = mock(() => [
      {
        id: 'a-1',
        sessionId: 'wf-1',
        parentId: null,
        painPointId: null,
        kind: 'linkedin',
        title: 'Post',
        content: 'Body',
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
    expect(json[0].sessionName).toBe('Demo with Globex');
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
      kind: 'collateral-generation',
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
      kind: 'collateral-generation',
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

  it('POST /workflows/:id/steps analyze applies the default output-token cap', async () => {
    extractionMaxTokens.length = 0;
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    // Analyze default cap (reasoning models need headroom to emit JSON).
    expect(extractionMaxTokens.at(-1)).toBe(16384);
  });

  it('POST /workflows/:id/steps analyze honors a per-step maxOutputTokens override', async () => {
    extractionMaxTokens.length = 0;
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(() => ({
      id: 'wf-1',
      status: 'pending',
      principalId: PERSONAL_PRINCIPAL.id,
      kind: 'collateral-generation',
      input: {
        companyName: 'Test Corp',
        transcriptId: 'tx-1',
        stepConfig: { analyze: { maxOutputTokens: 32000 } },
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
    expect(extractionMaxTokens.at(-1)).toBe(32000);
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

  it('POST /workflows/:id/steps analyze creates pain points as a document artifact', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = createMockDb({ onInsertValues: (values) => insertedValues.push(values) });

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'analyze' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        sessionId: 'wf-1',
        kind: 'pain-points',
        title: 'Pain Points — Acme Corp',
        status: 'approved',
      })
    );
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
    // Analysis complete maps to the session status 'ready' (awaiting generate),
    // consistent with the GET endpoint.
    expect(json.status).toBe('ready');
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

  it('POST /workflows/:id/steps generate uses the selected collateral types', async () => {
    generatedKinds.length = 0;
    const mockDb = createMockDb();
    mockDb.query.painPoint.findMany = mock(() => [
      {
        id: 'p-1',
        sessionId: 'wf-1',
        severity: 'high',
        context: 'Manual data entry is painful',
        quote: 'We spend hours copying data between sheets',
        selected: true,
      },
    ]);

    const router = buildApp(mockDb);
    const req = new Request('http://localhost:4000/workflows/wf-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        step: 'generate',
        painPointIds: ['p-1'],
        collateralTypes: ['linkedin-post', 'blog'],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    expect(generatedKinds).toEqual(['linkedin-post', 'blog']);
    const json = await res.json();
    expect(json.steps.generate.artifacts).toHaveLength(2);
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
  };
  // provider.findFirst is called once per assigned credential, in step order:
  // intake (granola), then analyze/generate (openai-compatible).
  const COLLATERAL_PROVIDER_QUEUE = ['granola', 'openai-compatible', 'openai-compatible'];

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

  it('POST /workflows/enabled scopes the enablement row to the caller principal (CL-1450)', async () => {
    // Proof-of-fix: enablement is keyed per-principal, so member A's row carries
    // their principalId and cannot be a tenant-global row another member shares.
    const insertedValues: unknown[] = [];
    const mockDb = createMockDb({
      onInsertValues: (values) => insertedValues.push(values),
      providerNameQueue: [...COLLATERAL_PROVIDER_QUEUE],
    });
    const res = await buildApp(mockDb).fetch(
      new Request('http://localhost:4000/workflows/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'collateral-generation',
          assignments: VALID_COLLATERAL_ASSIGNMENTS,
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        tenantId: 'tenant-personal',
        principalId: 'prn-personal',
        kind: 'collateral-generation',
      })
    );
  });

  it('GET /workflows/enabled filters by the caller principal (CL-1450)', async () => {
    function referencesColumn(
      // biome-ignore lint/suspicious/noExplicitAny: where-clause introspection
      node: any,
      columnName: string,
      seen = new Set()
    ): boolean {
      if (!node || typeof node !== 'object' || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) => referencesColumn(child, columnName, seen));
    }

    const mockDb = createMockDb();
    const res = await buildApp(mockDb).fetch(
      new Request('http://localhost:4000/workflows/enabled', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test mock introspection
    const args = (mockDb.query.enabledWorkflow.findMany as any).mock.calls[0][0];
    expect(referencesColumn(args.where, 'principal_id')).toBe(true);
  });

  it('POST /workflows/enabled succeeds without an explicit granola credential assignment', async () => {
    // Tenant-sourced credentials (like granola) are resolved at runtime by Interchange,
    // not at install time. Install must not block on them being explicitly assigned.
    const router = buildApp(createMockDb());
    const req = new Request('http://localhost:4000/workflows/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'collateral-generation', assignments: {} }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);
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

  it('GET /workflows/types lists registered workflow types', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(new Request('http://localhost:4000/workflows/types'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ kind: string }>;
    expect(json.some((t) => t.kind === 'collateral-generation')).toBe(true);
  });

  it('GET /workflows returns an empty array when user context is missing', async () => {
    const mockDb = createMockDb();
    mockDb.query.tenant.findFirst = mock(
      () => null
    ) as unknown as typeof mockDb.query.tenant.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /workflows lists the user sessions with enriched previews', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findMany = mock(() => [
      {
        id: 'wf-1',
        status: 'done',
        input: { companyName: 'Acme', transcriptId: 'tx-1' },
        tenantId: 'tenant-personal',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'collateral-generation',
      },
    ]) as typeof mockDb.query.workflowRun.findMany;
    mockDb.query.transcript.findFirst = mock(() => ({
      content: 'A long transcript body here',
    })) as typeof mockDb.query.transcript.findFirst;
    mockDb.query.painPoint.findMany = mock(() => [
      { id: 'p-1', context: 'pain context' },
    ]) as typeof mockDb.query.painPoint.findMany;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<Record<string, unknown>>;
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({
      id: 'wf-1',
      status: 'done',
      transcriptId: 'tx-1',
      companyName: 'Acme',
      painPointCount: 1,
      firstPainPoint: 'pain context',
    });
  });

  it('GET /workflows returns 403 for an inaccessible requested tenant', async () => {
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(PERSONAL_PRINCIPAL, null);

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows?tenantId=tenant-other', { method: 'GET' })
    );
    expect(res.status).toBe(403);
  });

  it('GET /workflows/:id returns 404 when the workflow does not exist', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(
      () => null
    ) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/missing', { method: 'GET' })
    );
    expect(res.status).toBe(404);
  });

  it('POST /workflows returns 400 for an invalid workflow kind', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: 'Hi',
          source: 'paste',
          workflowKind: 'not-real',
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid workflow kind');
  });

  it('POST /workflows returns 400 for an invalid source', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: 'Hi',
          source: 'carrier-pigeon',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid source');
  });

  it('POST /workflows paste source requires a non-empty transcript', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: '   ',
          source: 'paste',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('transcript is required');
  });

  it('POST /workflows paste source rejects an oversized transcript', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: 'x'.repeat(500001),
          source: 'paste',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(413);
  });

  it('POST /workflows granola source requires a granolaId', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'granola', workflowKind: 'collateral-generation' }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('granolaId is required');
  });

  it('PATCH /workflows/:id/company updates the company name', async () => {
    const setValues: Array<Record<string, unknown>> = [];
    const mockDb = createMockDb({ onSetUpdate: (v) => setValues.push(v) });

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/company', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: '  Globex Inc  ' }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: 'wf-1', companyName: 'Globex Inc' });
    expect(setValues[0]).toMatchObject({
      input: expect.objectContaining({ companyName: 'Globex Inc' }),
    });
  });

  it('PATCH /workflows/:id/company returns 404 when the workflow is missing', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(
      () => null
    ) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/missing/company', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: 'X' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('PATCH /workflows/:id/step-config validates and persists a valid config', async () => {
    const setValues: Array<Record<string, unknown>> = [];
    const mockDb = createMockDb({ onSetUpdate: (v) => setValues.push(v) });
    mockDb.query.agentInstance.findMany = mock(() => [
      { id: 'inst-oat' },
    ]) as typeof mockDb.query.agentInstance.findMany;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stepConfig: { analyze: { agentId: 'inst-oat', maxOutputTokens: 2048, toolIds: [] } },
        }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stepConfig.analyze).toMatchObject({ agentId: 'inst-oat', maxOutputTokens: 2048 });
    expect(setValues[0]).toMatchObject({
      input: expect.objectContaining({
        stepConfig: expect.objectContaining({
          analyze: expect.objectContaining({ agentId: 'inst-oat' }),
        }),
      }),
    });
  });

  it('PATCH /workflows/:id/step-config rejects a missing stepConfig body', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('stepConfig object is required');
  });

  it('PATCH /workflows/:id/step-config rejects unknown step keys', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { intake: {} } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unknown step keys');
  });

  it('PATCH /workflows/:id/step-config rejects a non-object step entry', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: 'nope' } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('must be an object');
  });

  it('PATCH /workflows/:id/step-config rejects a non-string agentId', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: { agentId: 42 } } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('agentId must be a string');
  });

  it('PATCH /workflows/:id/step-config rejects non-string toolIds', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: { toolIds: [1, 2] } } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('toolIds must be an array of strings');
  });

  it('PATCH /workflows/:id/step-config rejects an out-of-range maxOutputTokens', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: { maxOutputTokens: 999999 } } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('maxOutputTokens must be an integer');
  });

  it('PATCH /workflows/:id/step-config returns 404 when the workflow is missing', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(
      () => null
    ) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/missing/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: {} } }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('PATCH /workflows/:id/step-config rejects an agentId not in the tenant', async () => {
    const mockDb = createMockDb();
    mockDb.query.agentInstance.findMany = mock(
      () => []
    ) as typeof mockDb.query.agentInstance.findMany;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/step-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepConfig: { analyze: { agentId: 'inst-foreign' } } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('agentIds not found');
  });

  it('PATCH artifact status rejects an invalid status value', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/artifacts/a-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'maybe' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('PATCH artifact status returns 404 when the workflow is missing', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(
      () => null
    ) as typeof mockDb.query.workflowRun.findFirst;
    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/missing/artifacts/a-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('PATCH artifact status returns 404 when the artifact is not found', async () => {
    const mockDb = createMockDb({ updateReturning: [] });
    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/artifacts/a-missing/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('POST /workflows/:id/steps returns 400 for an invalid step', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'nonsense' }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid step');
  });

  it('POST /workflows/:id/steps generate requires pain point selection', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'generate', painPointIds: [], collateralTypes: ['blog'] }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('pain point');
  });

  it('POST /workflows/:id/steps generate requires collateral type selection', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'generate', painPointIds: ['p-1'], collateralTypes: [] }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('collateral type');
  });

  it('POST /workflows/:id/steps generate returns 400 for unknown collateral types', async () => {
    const mockDb = createMockDb();
    mockDb.query.painPoint.findMany = mock(() => [
      { id: 'p-1', sessionId: 'wf-1', severity: 'high', context: 'c', quote: 'q', selected: true },
    ]) as typeof mockDb.query.painPoint.findMany;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: 'generate',
          painPointIds: ['p-1'],
          collateralTypes: ['not-a-collateral-type'],
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No valid collateral types');
  });

  it('POST /workflows/:id/steps inline step returns 400 when no LLM credential resolves', async () => {
    const mockDb = createMockDb();
    mockDb.query.enabledWorkflow.findMany = mock(
      () => []
    ) as typeof mockDb.query.enabledWorkflow.findMany;
    (intxDb.resolveCredentialRequirement as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'analyze' }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No LLM credential');
  });

  it('POST /workflows/:id/steps analyze returns 500 when extraction throws', async () => {
    (
      (await import('../lib/extraction')).extractPainPoints as ReturnType<typeof mock>
    ).mockRejectedValueOnce(new Error('llm down'));

    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'analyze' }),
      })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Analysis failed');
  });

  it('POST /workflows/:id/steps analyze returns 410 when the workflow vanishes mid-run', async () => {
    const mockDb = createMockDb();
    let call = 0;
    mockDb.query.workflowRun.findFirst = mock(() => {
      call += 1;
      if (call >= 3) return null;
      return {
        id: 'wf-1',
        status: 'pending',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'collateral-generation',
        input: { companyName: 'Test Corp', transcriptId: 'tx-1' },
      };
    }) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'analyze' }),
      })
    );
    expect(res.status).toBe(410);
  });

  it('GET /recent-calls returns 400 when no Granola credential is configured', async () => {
    const mockDb = createMockDb();
    (intxDb.resolveCredentialRequirement as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/recent-calls', { method: 'GET' })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Granola credential');
  });

  it('GET /recent-calls returns calls from Granola', async () => {
    getRecentNotesMock.mockResolvedValueOnce([{ id: 'n-1', title: 'Call' }]);

    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/recent-calls?limit=5', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { calls: unknown[] };
    expect(json.calls).toHaveLength(1);
  });

  it('GET /recent-calls returns 502 when Granola fetch fails', async () => {
    getRecentNotesMock.mockRejectedValueOnce(new Error('granola down'));

    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/recent-calls', { method: 'GET' })
    );
    expect(res.status).toBe(502);
  });

  it('POST /workflows granola source fetches the note and creates the workflow', async () => {
    getNoteWithTranscriptMock.mockResolvedValueOnce({
      title: 'Discovery call',
      summary: 's',
    } as never);

    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'granola',
          granolaId: 'note-1',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(201);
  });

  it('POST /workflows granola source returns 400 when the fetch throws', async () => {
    getNoteWithTranscriptMock.mockRejectedValueOnce(new Error('granola down'));

    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'granola',
          granolaId: 'note-1',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Failed to fetch from Granola');
  });

  it('POST /workflows returns 500 when the transcript row cannot be created', async () => {
    const mockDb = createMockDb();
    mockDb.insert = mock(() => ({
      values: mock(() => ({ returning: mock(() => []) })),
    })) as unknown as typeof mockDb.insert;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: 'Hello world',
          source: 'paste',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Failed to create transcript');
  });

  it('GET /workflows scopes the query to a requested workbench tenant', async () => {
    const mockDb = createMockDb();
    mockDb.query.principal.findFirst = createPrincipalSequence(
      PERSONAL_PRINCIPAL,
      WORKSPACE_PRINCIPAL
    );
    mockDb.query.workflowRun.findMany = mock(() => []) as typeof mockDb.query.workflowRun.findMany;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows?tenantId=tenant-workbench', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    expect(mockDb.query.workflowRun.findMany).toHaveBeenCalledTimes(1);
  });

  it('POST /workflows/enabled rejects an assignment referencing an unknown credential', async () => {
    const mockDb = createMockDb();
    (intxDb.resolveCredentialById as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'collateral-generation',
          assignments: { intake: { credentialIds: ['ghost-cred'], toolIds: [] } },
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Credential not found');
  });

  it('POST /workflows/enabled returns 400 when kind is missing', async () => {
    const router = buildApp(createMockDb());
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('kind is required');
  });

  it('POST /workflows/:id/steps generate marks the run failed when every generation fails', async () => {
    generatedKinds.length = 0;
    const mockDb = createMockDb({ updateReturning: [] });
    mockDb.query.painPoint.findMany = mock(() => [
      { id: 'p-1', sessionId: 'wf-1', severity: 'high', context: 'c', quote: 'q', selected: true },
    ]) as typeof mockDb.query.painPoint.findMany;
    (
      (await import('../lib/generation')).generateCollateralWithLLM as ReturnType<typeof mock>
    ).mockRejectedValueOnce(new Error('gen failed'));

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: 'generate',
          painPointIds: ['p-1'],
          collateralTypes: ['blog'],
        }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('failed');
  });

  it('POST /workflows returns 500 when the workflow row cannot be created', async () => {
    const mockDb = createMockDb();
    let inserts = 0;
    mockDb.insert = mock(() => ({
      values: mock(() => {
        inserts += 1;
        return {
          returning: mock(() => (inserts === 1 ? [{ id: 'tx-1' }] : [])),
        };
      }),
    })) as unknown as typeof mockDb.insert;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: 'Hello world',
          source: 'paste',
          workflowKind: 'collateral-generation',
        }),
      })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Failed to create workflow');
  });

  it('GET /workflows/:id maps a failed workflow to the intake step', async () => {
    const mockDb = createMockDb();
    mockDb.query.workflowRun.findFirst = mock(() => ({
      id: 'wf-1',
      status: 'failed',
      principalId: PERSONAL_PRINCIPAL.id,
      kind: 'collateral-generation',
      input: { companyName: 'Test Corp', transcriptId: 'tx-1' },
    })) as typeof mockDb.query.workflowRun.findFirst;

    const router = buildApp(mockDb);
    const res = await router.fetch(
      new Request('http://localhost:4000/workflows/wf-1', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('failed');
    expect(json.currentStep).toBe('intake');
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

  describe('presentation-generation workflow', () => {
    function buildPresentationApp(
      db: ReturnType<typeof createMockDb>,
      deps?: { sessionService?: { sendUserMessage: (...args: unknown[]) => Promise<void> } }
    ) {
      const parent = new Hono<{ Variables: { userId: string } }>();
      parent.use('*', async (c, next) => {
        c.set('userId', 'test-user');
        await next();
      });
      parent.route(
        '/',
        createWorkflowRouter(
          db as unknown as HubDb,
          deps as unknown as { sessionService?: import('./workflow').SessionServiceDep }
        )
      );
      return parent;
    }

    function createPresentationMockDb(options: Parameters<typeof createMockDb>[0] = {}) {
      const db = createMockDb(options);
      db.query.enabledWorkflow.findFirst = mock(() => ({
        id: 'ew-pres',
        tenantId: 'tenant-personal',
        principalId: 'prn-personal',
        kind: 'presentation-generation',
        enabledAt: new Date().toISOString(),
        assignments: {} as unknown as {
          analyze: { credentialIds: string[]; toolIds: never[] };
          generate: { credentialIds: string[]; toolIds: never[] };
        },
      }));
      db.query.workflowRun.findFirst = mock(() => ({
        id: 'wf-pres',
        status: 'pending',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'presentation-generation',
        input: {} as { companyName: string; transcriptId: string },
      }));
      db.insert = mock(() => ({
        values: mock((values: unknown) => {
          options.onInsertValues?.(values);
          return {
            returning: mock(() => [
              { id: 'wf-pres', status: 'pending', kind: 'presentation-generation' },
            ]),
            onConflictDoUpdate: mock(() => ({
              returning: mock(() => []),
            })),
          };
        }),
      }));
      return db;
    }

    it('GET /gamma/templates returns an array', async () => {
      const router = buildPresentationApp(createPresentationMockDb());
      const res = await router.fetch(new Request('http://localhost/gamma/templates'));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json)).toBe(true);
    });

    it('POST /workflows creates presentation-generation run without transcript', async () => {
      const router = buildPresentationApp(createPresentationMockDb());
      const res = await router.fetch(
        new Request('http://localhost/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowKind: 'presentation-generation' }),
        })
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.id).toBeString();
      expect(json.kind).toBe('presentation-generation');
    });

    it('POST /workflows/id/steps template step advances to analyzing', async () => {
      const updatedValues: unknown[] = [];
      const db = createPresentationMockDb({ onSetUpdate: (v) => updatedValues.push(v) });
      const router = buildPresentationApp(db);
      const res = await router.fetch(
        new Request('http://localhost/workflows/wf-pres/steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            step: 'template',
            templateId: 'tmpl-1',
            audience: 'Executives',
            tone: 'Formal',
            goal: 'Close deal',
          }),
        })
      );
      expect(res.status).toBe(200);
      expect(updatedValues).toContainEqual(expect.objectContaining({ status: 'analyzing' }));
    });

    it('POST /workflows/id/steps source step (paste) advances to running', async () => {
      const updatedValues: unknown[] = [];
      const db = createPresentationMockDb({ onSetUpdate: (v) => updatedValues.push(v) });
      db.query.workflowRun.findFirst = mock(() => ({
        id: 'wf-pres',
        status: 'analyzing',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'presentation-generation',
        input: { templateId: 'tmpl-1' } as unknown as { companyName: string; transcriptId: string },
      }));
      const router = buildPresentationApp(db);
      const res = await router.fetch(
        new Request('http://localhost/workflows/wf-pres/steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            step: 'source',
            transcriptSource: 'paste',
            transcript: 'Hello world content for the deck',
            callTitle: 'Test Call',
          }),
        })
      );
      expect(res.status).toBe(200);
      expect(updatedValues).toContainEqual(expect.objectContaining({ status: 'running' }));
    });

    it('POST /workflows/id/steps generate without agentInstanceId returns 400', async () => {
      const db = createPresentationMockDb();
      db.query.workflowRun.findFirst = mock(() => ({
        id: 'wf-pres',
        status: 'running',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'presentation-generation',
        input: {
          templateId: 'tmpl-1',
          transcriptSource: 'paste',
          transcriptId: 'tx-1',
        } as unknown as { companyName: string; transcriptId: string },
      }));
      const sendUserMessage = mock(() => Promise.resolve());
      const router = buildPresentationApp(db, { sessionService: { sendUserMessage } });
      const res = await router.fetch(
        new Request('http://localhost/workflows/wf-pres/steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'generate' }),
        })
      );
      expect(res.status).toBe(400);
    });

    it('POST /workflows/id/steps generate dispatches mail and advances to generating', async () => {
      const updatedValues: unknown[] = [];
      const db = createPresentationMockDb({ onSetUpdate: (v) => updatedValues.push(v) });
      db.query.workflowRun.findFirst = mock(() => ({
        id: 'wf-pres',
        status: 'running',
        principalId: PERSONAL_PRINCIPAL.id,
        kind: 'presentation-generation',
        input: {
          templateId: 'tmpl-1',
          transcriptSource: 'paste',
          transcriptId: 'tx-1',
          callTitle: 'Test Call',
        } as unknown as { companyName: string; transcriptId: string },
      }));
      db.query.agentInstance.findFirst = mock<
        () => { id: string; agentId: string; tenantId: string; address: string; sessionId: null }
      >(() => ({
        id: 'inst-geralt',
        agentId: 'agent-geralt',
        tenantId: 'tenant-personal',
        address: 'inst-geralt@global.example.com',
        sessionId: 'ses-geralt' as unknown as null,
      }));
      const sendUserMessage = mock(() => Promise.resolve());
      const router = buildPresentationApp(db, { sessionService: { sendUserMessage } });
      const res = await router.fetch(
        new Request('http://localhost/workflows/wf-pres/steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'generate', agentInstanceId: 'inst-geralt' }),
        })
      );
      expect(res.status).toBe(200);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(updatedValues).toContainEqual(expect.objectContaining({ status: 'generating' }));
    });
  });
});
