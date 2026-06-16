import { describe, expect, it, mock, beforeAll, afterEach } from 'bun:test';
import { workflowRegistry } from '@workbench/workflow-core';
import {
  collateralGenerationWorkflow,
  presentationGenerationWorkflow,
} from '@workbench/gtm-workflows';
import type { HubDb } from '../db';
import type { InferenceSource } from '@intx/types/runtime';
import type { UserContext } from '@workbench/workflow-core';

mock.module('../lib/extraction', () => ({
  extractPainPoints: mock(() =>
    Promise.resolve({
      companyName: 'Acme Corp',
      painPoints: [
        {
          sessionId: 'wf-1',
          severity: 'high' as const,
          context: 'Manual data entry is painful',
          quote: 'We spend hours copying data',
          selected: true,
        },
      ],
    })
  ),
}));

const { appendVariantSuffix } = await import('@workbench/gtm-workflows');

mock.module('../lib/generation', () => ({
  generateCollateralWithLLM: mock(
    (_id: string, _tx: string, _p: unknown, kind: string, _s, _m, variantIndex: number) =>
      Promise.resolve(
        appendVariantSuffix({ title: `${kind} title`, body: `${kind} body` }, kind, variantIndex)
      )
  ),
}));

const mockRunSingleTurnAgent = mock(
  (
    _src: unknown,
    _sys: string,
    _user: string,
    _prefix: string,
    _maxTokens?: number
  ): Promise<string> => Promise.resolve('generated slide content')
);

mock.module('../lib/inference', () => ({
  runSingleTurnAgent: mockRunSingleTurnAgent,
}));

const mockResolveCredentialRequirement = mock(() =>
  Promise.resolve({ id: 'cred-1', secret: 'gamma-key-test' })
);

mock.module('@intx/db', () => ({
  resolveCredentialRequirement: mockResolveCredentialRequirement,
}));

const mockGenerateFromTemplate = mock(() =>
  Promise.resolve({ gammaUrl: 'https://gamma.app/deck/test-123', gammaId: 'gid-test-123' })
);

mock.module('@workbench/tools-gamma', () => ({
  generateFromTemplate: mockGenerateFromTemplate,
}));

import { runAnalyze, runGenerate, runPresentationGenerate } from './workflow-generation';

const SOURCE: InferenceSource = {
  id: 'src-1',
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
};

const USER_CONTEXT: UserContext = { tenantId: 'tenant-1', principalId: 'prn-1' };

function createMockDb(
  options: {
    workflowRow?: Record<string, unknown> | null;
    painPoints?: unknown[];
    onSetUpdate?: (values: Record<string, unknown>) => void;
    onInsertArtifacts?: (values: Array<Record<string, unknown>>) => void;
  } = {}
) {
  const workflowRow =
    options.workflowRow === undefined
      ? {
          id: 'wf-1',
          status: 'pending',
          tenantId: 'tenant-1',
          principalId: 'prn-1',
          kind: 'collateral-generation',
          input: { transcriptId: 'tx-1' },
        }
      : options.workflowRow;

  return {
    query: {
      workflowRun: {
        findFirst: mock(() => workflowRow),
      },
      transcript: {
        findFirst: mock(() => ({ content: 'Test transcript content' })),
      },
      painPoint: {
        findMany: mock(() => options.painPoints ?? []),
      },
    },
    delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    insert: mock(() => ({
      values: mock((values: unknown) => ({
        returning: mock(() =>
          Array.isArray(values)
            ? values.map((v, i) => ({ id: `pp-${i + 1}`, ...v }))
            : [{ id: 'row-1', ...(values as object) }]
        ),
      })),
    })),
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => {
        options.onSetUpdate?.(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
    transaction: mock((fn: (trx: unknown) => unknown) =>
      fn({
        insert: mock(() => ({
          values: mock((values: unknown) => {
            if (Array.isArray(values)) {
              options.onInsertArtifacts?.(values as Array<Record<string, unknown>>);
            }
            return {
              returning: mock(() =>
                Array.isArray(values)
                  ? values.map((v, i) => ({ id: `a-${i + 1}`, ...v }))
                  : [{ id: 'a-1', ...(values as object) }]
              ),
            };
          }),
        })),
      })
    ),
  };
}

beforeAll(() => {
  workflowRegistry.register(collateralGenerationWorkflow);
  workflowRegistry.register(presentationGenerationWorkflow);
});

describe('runAnalyze', () => {
  it('extracts and persists pain points, returning the ready ("running") state', async () => {
    const db = createMockDb();
    const res = await runAnalyze(db as unknown as HubDb, 'wf-1', USER_CONTEXT, SOURCE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      currentStep: string;
      steps: { analyze: { completed: boolean; painPoints: Array<{ context: string }> } };
    };
    expect(body.status).toBe('ready');
    expect(body.currentStep).toBe('generate');
    expect(body.steps.analyze.completed).toBe(true);
    expect(body.steps.analyze.painPoints[0]?.context).toBe('Manual data entry is painful');
  });

  it('returns 404 when the workflow does not exist', async () => {
    const db = createMockDb({ workflowRow: null });
    const res = await runAnalyze(db as unknown as HubDb, 'wf-missing', USER_CONTEXT, SOURCE);
    expect(res.status).toBe(404);
  });

  it('replaces pain points on auto-analyze (delete-then-insert, idempotent) (CL-1950)', async () => {
    const db = createMockDb();
    const deleteSpy = mock(() => ({ where: mock(() => Promise.resolve()) }));
    db.delete = deleteSpy;
    const res = await runAnalyze(db as unknown as HubDb, 'wf-1', USER_CONTEXT, SOURCE);
    expect(res.status).toBe(200);
    expect(deleteSpy).toHaveBeenCalled();
  });

  it('replaces pain points on an explicit re-analyze with feedback (CL-1950)', async () => {
    const db = createMockDb();
    const deleteSpy = mock(() => ({ where: mock(() => Promise.resolve()) }));
    db.delete = deleteSpy;
    const res = await runAnalyze(
      db as unknown as HubDb,
      'wf-1',
      USER_CONTEXT,
      SOURCE,
      'redo with more detail'
    );
    expect(res.status).toBe(200);
    expect(deleteSpy).toHaveBeenCalled();
  });

  it('does not duplicate pain points across two auto-analyze runs (CL-1950)', async () => {
    // Each run must delete-then-insert: the inserted set replaces, never adds to,
    // the prior set. With a single extracted point, two runs must each insert one
    // point and each must have issued a delete first.
    let insertCount = 0;
    const deleteSpy = mock(() => ({ where: mock(() => Promise.resolve()) }));
    const db = createMockDb();
    db.delete = deleteSpy;
    const baseInsert = db.insert;
    db.insert = mock((...args: unknown[]) => {
      insertCount += 1;
      return (baseInsert as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.insert;

    const first = await runAnalyze(db as unknown as HubDb, 'wf-1', USER_CONTEXT, SOURCE);
    const second = await runAnalyze(db as unknown as HubDb, 'wf-1', USER_CONTEXT, SOURCE);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(deleteSpy.mock.calls.length).toBe(2);
    expect(insertCount).toBeGreaterThanOrEqual(2);
  });
});

describe('runGenerate', () => {
  it('generates artifacts and moves to reviewing on success', async () => {
    const statusUpdates: string[] = [];
    const db = createMockDb({
      painPoints: [{ id: 'pp-1', sessionId: 'wf-1', context: 'c', quote: 'q', severity: 'high' }],
      onSetUpdate: (v) => {
        if (typeof v.status === 'string') statusUpdates.push(v.status);
      },
    });
    const res = await runGenerate(
      db as unknown as HubDb,
      'wf-1',
      ['pp-1'],
      ['one-pager'],
      'prn-1',
      SOURCE
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      steps: { generate: { artifacts: unknown[] } };
    };
    expect(body.status).toBe('reviewing');
    expect(body.steps.generate.artifacts.length).toBeGreaterThan(0);
  });

  it('stores a linkedin-daily selection as linkedin-post artifacts with Draft N titles', async () => {
    const insertedArtifacts: Array<Record<string, unknown>> = [];
    const db = createMockDb({
      painPoints: [{ id: 'pp-1', sessionId: 'wf-1', context: 'c', quote: 'q', severity: 'high' }],
      onInsertArtifacts: (values) => {
        insertedArtifacts.push(...values);
      },
    });
    const res = await runGenerate(
      db as unknown as HubDb,
      'wf-1',
      ['pp-1'],
      ['linkedin-daily'],
      'prn-1',
      SOURCE
    );
    expect(res.status).toBe(200);

    const collateral = insertedArtifacts.filter((a) => a.kind === 'linkedin-post');
    expect(collateral.length).toBe(3);
    expect(insertedArtifacts.some((a) => a.kind === 'linkedin-daily')).toBe(false);
    const titles = collateral.map((a) => a.title);
    expect(titles).toContain('linkedin-daily title — Draft 1');
    expect(titles).toContain('linkedin-daily title — Draft 2');
    expect(titles).toContain('linkedin-daily title — Draft 3');
  });

  it('writes "running" (not "ready") and returns 400 for invalid collateral types', async () => {
    const statusUpdates: string[] = [];
    const db = createMockDb({
      painPoints: [{ id: 'pp-1', sessionId: 'wf-1', context: 'c', quote: 'q', severity: 'high' }],
      onSetUpdate: (v) => {
        if (typeof v.status === 'string') statusUpdates.push(v.status);
      },
    });
    const res = await runGenerate(
      db as unknown as HubDb,
      'wf-1',
      ['pp-1'],
      ['not-a-real-type'],
      'prn-1',
      SOURCE
    );
    expect(res.status).toBe(400);
    // The restore must write the DB status 'running', never the session-only
    // 'ready', which is not a valid DB status.
    expect(statusUpdates).toContain('running');
    expect(statusUpdates).not.toContain('ready');
  });
});

const PRESENTATION_WORKFLOW_ROW = {
  id: 'wf-pres-1',
  status: 'ready',
  tenantId: 'tenant-1',
  principalId: 'prn-1',
  kind: 'presentation-generation',
  input: {
    transcriptId: 'tx-1',
    templateId: 'tmpl-abc',
    callTitle: 'Acme Discovery Call',
    audience: 'Sales',
    tone: 'confident',
    goal: 'Close deal',
  },
};

function createPresentationMockDb(
  options: {
    workflowRow?: Record<string, unknown> | null;
    onSetUpdate?: (values: Record<string, unknown>) => void;
  } = {}
) {
  const workflowRow =
    options.workflowRow === undefined ? PRESENTATION_WORKFLOW_ROW : options.workflowRow;

  return {
    query: {
      workflowRun: {
        findFirst: mock(() => workflowRow),
      },
      transcript: {
        findFirst: mock(() => ({ content: 'Test transcript content for presentation' })),
      },
      artifact: {
        findFirst: mock(() => null),
      },
    },
    delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    insert: mock(() => ({
      values: mock((values: unknown) => ({
        returning: mock(() => [{ id: 'art-1', ...(values as object) }]),
      })),
    })),
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => {
        options.onSetUpdate?.(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
    transaction: mock((fn: (trx: unknown) => unknown) => fn({})),
  };
}

describe('runPresentationGenerate', () => {
  afterEach(() => {
    mockRunSingleTurnAgent.mockClear();
    mockGenerateFromTemplate.mockClear();
    mockResolveCredentialRequirement.mockClear();
  });

  it('calls runSingleTurnAgent with PRESENTATION_MAX_OUTPUT_TOKENS for both generate and review', async () => {
    let callCount = 0;
    const capturedMaxTokens: Array<number | undefined> = [];
    mockRunSingleTurnAgent.mockImplementation(
      (_src: unknown, _sys: string, _user: string, _prefix: string, maxTokens?: number) => {
        callCount += 1;
        capturedMaxTokens.push(maxTokens);
        return Promise.resolve('slide content from generate round');
      }
    );

    const db = createPresentationMockDb();
    await runPresentationGenerate(db as unknown as HubDb, 'wf-pres-1', 'tenant-1', SOURCE);

    expect(callCount).toBe(2);
    expect(capturedMaxTokens[0]).toBe(16384);
    expect(capturedMaxTokens[1]).toBe(16384);
  });

  it('sets status to failed without calling review when generate returns empty content', async () => {
    let callCount = 0;
    mockRunSingleTurnAgent.mockImplementation(() => {
      callCount += 1;
      return Promise.resolve('');
    });

    const statusUpdates: string[] = [];
    const setValues: Array<Record<string, unknown>> = [];
    const db = createPresentationMockDb({
      onSetUpdate: (v) => {
        setValues.push(v);
        if (typeof v.status === 'string') statusUpdates.push(v.status);
      },
    });

    await runPresentationGenerate(db as unknown as HubDb, 'wf-pres-1', 'tenant-1', SOURCE);

    expect(callCount).toBe(1);
    expect(statusUpdates).toContain('failed');
    expect(statusUpdates).not.toContain('reviewing');
    const failedUpdate = setValues.find((v) => v.status === 'failed');
    expect(failedUpdate).toBeDefined();
    const output = failedUpdate?.output as Record<string, unknown> | undefined;
    const errorMsg = output?.errorMessage;
    expect(typeof errorMsg).toBe('string');
    expect(errorMsg as string).toContain('Generation produced no content');
  });

  it('persists a user-friendly errorMessage in output when the pipeline throws', async () => {
    mockRunSingleTurnAgent.mockImplementation(
      (_src: unknown, _sys: string, _user: string, prefix: string) => {
        if (prefix === 'presentation-review') {
          return Promise.reject(new Error('LLM timeout'));
        }
        return Promise.resolve('generated slide content');
      }
    );

    const setValues: Array<Record<string, unknown>> = [];
    const db = createPresentationMockDb({
      onSetUpdate: (v) => setValues.push(v),
    });

    await runPresentationGenerate(db as unknown as HubDb, 'wf-pres-1', 'tenant-1', SOURCE);

    const failedUpdate = setValues.find((v) => v.status === 'failed');
    expect(failedUpdate).toBeDefined();
    const output = failedUpdate?.output as Record<string, unknown> | undefined;
    const errorMsg = output?.errorMessage;
    expect(typeof errorMsg).toBe('string');
    expect(errorMsg as string).toContain('unexpected error');
  });

  it('sets status to done and writes gammaUrl on successful pipeline', async () => {
    mockRunSingleTurnAgent.mockImplementation(() => Promise.resolve('reviewed slide content'));

    const statusUpdates: string[] = [];
    const setValues: Array<Record<string, unknown>> = [];
    const db = createPresentationMockDb({
      onSetUpdate: (v) => {
        setValues.push(v);
        if (typeof v.status === 'string') statusUpdates.push(v.status);
      },
    });

    await runPresentationGenerate(db as unknown as HubDb, 'wf-pres-1', 'tenant-1', SOURCE);

    expect(statusUpdates).toContain('done');
    const doneUpdate = setValues.find((v) => v.status === 'done');
    expect(doneUpdate).toBeDefined();
    const input = doneUpdate?.input as Record<string, unknown> | undefined;
    expect(input?.gammaUrl).toBe('https://gamma.app/deck/test-123');
  });
});
