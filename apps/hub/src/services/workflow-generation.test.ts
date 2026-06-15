import { describe, expect, it, mock, beforeAll } from 'bun:test';
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

import { runAnalyze, runGenerate } from './workflow-generation';

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
