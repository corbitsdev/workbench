import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { WorkflowDefinition } from '@intx/workflow';
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from '@workbench/agents';
import type { HubDb } from '../db';
import type { AgentRepoStore } from '@intx/hub-sessions';
import type { RunState } from '../workflow-executor/executor';

// Override only getAncestorChain (the route walks the tenant chain); preserve
// every other @intx/db export so sibling suites in the same process keep theirs.
const realDb = await import('@intx/db');
let ancestorChain: readonly string[] = ['tn-1'];
mock.module('@intx/db', () => ({
  ...realDb,
  getAncestorChain: async () => [...ancestorChain],
}));

// Injected (not module-mocked) so this suite never leaks a fixed user context
// into sibling route suites running in the same bun-test process.
const resolveContext = async () => ({
  context: { tenantId: 'tn-1', principalId: 'prn-1' },
  forbidden: false,
});

// The deployed pain-point-collateral definition, shaped like the read-back
// JSON. Gates between every reasoning/tool cluster, ending in a persist map.
function painPointDefinition(): WorkflowDefinition {
  return {
    id: 'pain-point-collateral',
    triggers: [],
    stepOrder: [
      'intake',
      'select',
      'fetch',
      'context',
      'analyze',
      'ppSelection',
      'fmtSelection',
      'generate',
      'review',
      'persist',
    ],
    steps: {
      intake: {
        kind: 'step',
        id: 'intake',
        agent: {
          id: 'intake',
          tags: { [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND, [STEP_TOOL_TAG]: 'granola_list_notes' },
          inference: { sources: [] },
        },
        input: { literal: {} },
      },
      select: { kind: 'awaitSignal', id: 'select', name: 'note-selection', after: ['intake'] },
      fetch: {
        kind: 'step',
        id: 'fetch',
        agent: {
          id: 'fetch',
          tags: { [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND, [STEP_TOOL_TAG]: 'granola_get_note' },
          inference: { sources: [] },
        },
        input: { from: 'steps.select.output' },
        after: ['select'],
      },
      context: { kind: 'awaitSignal', id: 'context', name: 'context', after: ['fetch'] },
      analyze: {
        kind: 'step',
        id: 'analyze',
        agent: {
          id: 'analyze',
          systemPrompt: 'extract',
          tags: { credentialName: 'opencode-zen' },
          inference: { sources: [{ provider: 'openai-compatible', model: 'm' }] },
        },
        input: { merge: [{ from: 'steps.fetch.output' }, { from: 'steps.context.output' }] },
        after: ['context'],
      },
      ppSelection: {
        kind: 'awaitSignal',
        id: 'ppSelection',
        name: 'pain-point-selection',
        after: ['analyze'],
      },
      fmtSelection: {
        kind: 'awaitSignal',
        id: 'fmtSelection',
        name: 'format-selection',
        after: ['ppSelection'],
      },
      generate: {
        kind: 'map',
        id: 'generate',
        over: { from: 'steps.fmtSelection.output.formats' },
        step: {
          kind: 'step',
          id: 'generate.child',
          agent: {
            id: 'generate',
            systemPrompt: 'gen',
            tags: { credentialName: 'opencode-zen' },
            inference: { sources: [{ provider: 'openai-compatible', model: 'm' }] },
          },
          input: { from: 'trigger.payload' },
        },
        after: ['fmtSelection'],
      },
      review: { kind: 'awaitSignal', id: 'review', name: 'review', after: ['generate'] },
      persist: {
        kind: 'map',
        id: 'persist',
        over: { from: 'steps.review.output.decisions' },
        step: {
          kind: 'step',
          id: 'persist.child',
          agent: {
            id: 'persist',
            tags: {
              [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND,
              [STEP_TOOL_TAG]: 'artifact_create',
              [STEP_ARGMAP_TAG]: JSON.stringify({
                title: { from: 'title' },
                kind: { literal: 'document' },
                content: { from: 'content' },
              }),
            },
            inference: { sources: [] },
          },
          input: { from: 'trigger.payload' },
        },
        after: ['review'],
      },
    } as unknown as WorkflowDefinition['steps'],
  };
}

// Hub-side runners: the real executor calls these. We stub them at the runner
// module boundary so the test exercises the full router + projection + executor
// + run-store seam without a live DB credential or LLM. The tool runner returns
// the pre-substrate `{content}` envelope; reasoning returns `{reply}`.
const toolCalls: Array<{ tool: string; input: unknown }> = [];
const reasoningCalls: Array<{ stepId: string; input: unknown }> = [];
mock.module('../workflow-executor/hub-runners', () => ({
  createHubToolRunner: () => ({
    run: async ({ tool, input }: { tool: string; input: unknown }) => {
      toolCalls.push({ tool, input });
      if (tool === 'granola_list_notes') {
        return { content: JSON.stringify({ notes: [{ id: 'n1', title: 'Acme call' }] }) };
      }
      if (tool === 'granola_get_note') {
        return { content: JSON.stringify({ transcript: 'we struggle with X' }) };
      }
      return { content: JSON.stringify({ artifactId: `art-${toolCalls.length}` }) };
    },
  }),
  createHubReasoningRunner: () => ({
    run: async ({ stepId, input }: { stepId: string; input: unknown }) => {
      reasoningCalls.push({ stepId, input });
      return { reply: JSON.stringify({ reasoned: stepId }) };
    },
  }),
}));

// In-memory run-store: persists run state to a Map keyed by runId. insert
// creates, save updates, load reads — exactly the durable record contract the
// route relies on, so resume reads back what start persisted.
const runs = new Map<string, RunState>();
mock.module('../workflow-executor/run-store', () => ({
  createRunStore: () => ({
    save: async (state: RunState) => {
      runs.set(state.runId, structuredClone(state));
    },
  }),
  insertRunRecord: async (
    _db: unknown,
    args: { runId: string; kind: string; tenantId: string; principalId: string; input: unknown }
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
    };
    runs.set(state.runId, structuredClone(state));
    return state;
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    return found ? structuredClone(found) : null;
  },
  listRunRecords: async () =>
    [...runs.values()].map((r) => ({
      runId: r.runId,
      kind: r.kind,
      status: r.status,
      createdAt: new Date(),
    })),
}));

const { createWorkflowRunRecordsRouter } = await import('./workflow-run-records');

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;
function makeDb(): HubDb {
  const db: MockDb = {
    query: {
      workflowRun: {
        // one deployed pain-point-collateral deployment in tn-1
        findMany: async () => [
          {
            deploymentId: 'ses_dep1',
            tenantId: 'tn-1',
            kind: 'pain-point-collateral',
            createdAt: new Date(),
          },
        ],
      },
    },
  };
  return db as HubDb;
}

function app(): Hono<{ Variables: { userId: string } }> {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route(
    '/',
    createWorkflowRunRecordsRouter({
      db: makeDb(),
      repoStore: {} as AgentRepoStore,
      readDefinition: async () => painPointDefinition(),
      resolveContext,
    })
  );
  return a;
}

// Build an app whose resolveContext returns a specific (tenant, principal),
// to exercise the ownership/tenancy gate as a different caller.
function appAs(ctx: { tenantId: string; principalId: string }): Hono<{
  Variables: { userId: string };
}> {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-x');
    await next();
  });
  a.route(
    '/',
    createWorkflowRunRecordsRouter({
      db: makeDb(),
      repoStore: {} as AgentRepoStore,
      readDefinition: async () => painPointDefinition(),
      resolveContext: async () => ({ context: ctx, forbidden: false }),
    })
  );
  return a;
}

type AppHono = Hono<{ Variables: { userId: string } }>;

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

async function get(a: AppHono, path: string): Promise<{ status: number; json: any }> {
  const res = await a.request(path);
  return { status: res.status, json: await res.json() };
}

describe('pain-point-collateral via the thin executor (end-to-end seam)', () => {
  test('start runs intake then parks at the note-selection gate', async () => {
    runs.clear();
    toolCalls.length = 0;
    const a = app();
    const { status, json } = await post(a, '/workflow-exec/pain-point-collateral/start', {
      input: {},
    });

    expect(status).toBe(200);
    expect(json.status).toBe('awaiting');
    expect(json.currentStepId).toBe('select');
    // intake ran; the note list is in outputs immediately (no event-log replay)
    expect(toolCalls.map((c) => c.tool)).toEqual(['granola_list_notes']);
    const intake = JSON.parse(json.outputs.intake.content);
    expect(intake.notes[0].id).toBe('n1');
  });

  test('full happy path: every gate resumed → completed with persisted artifacts', async () => {
    runs.clear();
    toolCalls.length = 0;
    reasoningCalls.length = 0;
    const a = app();

    const start = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;

    // select transcript -> fetches the note, parks at context gate
    let r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'note-selection',
      payload: { noteId: 'n1' },
    });
    expect(r.json.currentStepId).toBe('context');
    expect(toolCalls.find((c) => c.tool === 'granola_get_note')?.input).toEqual({ noteId: 'n1' });

    // add context -> runs analyze (reasoning), parks at pain-point-selection
    r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'context',
      payload: { context: 'enterprise buyer' },
    });
    expect(r.json.currentStepId).toBe('ppSelection');
    // analyze input = merge(fetch envelope, context gate payload). The fetch
    // tool output is the `{content}` envelope; the context payload merges over it.
    expect(reasoningCalls.find((c) => c.stepId === 'analyze')?.input).toEqual({
      content: JSON.stringify({ transcript: 'we struggle with X' }),
      context: 'enterprise buyer',
    });

    // select pain points -> parks at format-selection
    r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'pain-point-selection',
      payload: { selectedIds: ['pp1'] },
    });
    expect(r.json.currentStepId).toBe('fmtSelection');

    // select formats -> generate map fans out, parks at review
    r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'format-selection',
      payload: { formats: [{ format: 'email' }, { format: 'linkedin' }] },
    });
    expect(r.json.currentStepId).toBe('review');
    expect(r.json.outputs.generate).toHaveLength(2);
    expect(reasoningCalls.filter((c) => c.stepId === 'generate.child')).toHaveLength(2);

    // approve -> persist map creates one artifact per approved decision, completes
    r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'review',
      payload: { decisions: [{ title: 'Email', content: 'body', format: 'email' }] },
    });
    expect(r.json.status).toBe('completed');
    expect(r.json.outputs.persist).toHaveLength(1);
    const persistCalls = toolCalls.filter((c) => c.tool === 'artifact_create');
    expect(persistCalls).toHaveLength(1);
    // argMap reshaped trigger.payload -> tool args
    expect(persistCalls[0]?.input).toEqual({ title: 'Email', kind: 'document', content: 'body' });
  });

  test('GET run state is a single record read (no replay) and matches resume result', async () => {
    runs.clear();
    const a = app();
    const start = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;

    const read = await get(a, `/workflow-exec/records/${runId}`);
    expect(read.status).toBe(200);
    expect(read.json.runId).toBe(runId);
    expect(read.json.status).toBe('awaiting');
    expect(read.json.currentStepId).toBe('select');
  });

  test('restart mid-gate: a fresh router instance resumes from the persisted record', async () => {
    runs.clear();
    const a1 = app();
    const start = await post(a1, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;
    expect(start.json.status).toBe('awaiting');

    // Simulate a hub restart: a brand-new router (fresh projection cache, fresh
    // executor) over the SAME persisted run store. Resume must continue.
    const a2 = app();
    const r = await post(a2, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'note-selection',
      payload: { noteId: 'n1' },
    });
    expect(r.status).toBe(200);
    expect(r.json.currentStepId).toBe('context');
  });

  test('resume with a wrong signal name is rejected 400', async () => {
    runs.clear();
    const a = app();
    const start = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const r = await post(a, `/workflow-exec/records/${start.json.runId}/resume`, {
      signalName: 'not-the-gate',
      payload: {},
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/awaits signal/);
  });

  test('cross-user GET /records/:runId is forbidden 403', async () => {
    runs.clear();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;

    // A different user (same tenant chain, different principal) reads the run.
    const intruder = appAs({ tenantId: 'tn-1', principalId: 'prn-other' });
    const read = await get(intruder, `/workflow-exec/records/${runId}`);
    expect(read.status).toBe(403);
    expect(read.json.error).toBe('Forbidden');
  });

  test('cross-user resume is forbidden 403', async () => {
    runs.clear();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;

    const intruder = appAs({ tenantId: 'tn-1', principalId: 'prn-other' });
    const r = await post(intruder, `/workflow-exec/records/${runId}/resume`, {
      signalName: 'note-selection',
      payload: { noteId: 'n1' },
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('Forbidden');
  });

  test('a run in a tenant outside the callers chain reads as 404', async () => {
    runs.clear();
    const owner = app();
    const start = await post(owner, '/workflow-exec/pain-point-collateral/start', { input: {} });
    const runId = start.json.runId;

    // The run lives in tn-1; this caller's chain excludes tn-1, so the record
    // does not exist for them.
    ancestorChain = ['tn-9'];
    try {
      const read = await get(
        appAs({ tenantId: 'tn-9', principalId: 'prn-9' }),
        `/workflow-exec/records/${runId}`
      );
      expect(read.status).toBe(404);
    } finally {
      ancestorChain = ['tn-1'];
    }
  });

  test('start with no deployed kind returns 404', async () => {
    const a = new Hono<{ Variables: { userId: string } }>();
    a.use('*', async (c, next) => {
      c.set('userId', 'u');
      await next();
    });
    const db = { query: { workflowRun: { findMany: async () => [] } } } as unknown as HubDb;
    a.route(
      '/',
      createWorkflowRunRecordsRouter({
        db,
        repoStore: {} as AgentRepoStore,
        readDefinition: async () => painPointDefinition(),
        resolveContext,
      })
    );
    const r = await post(a, '/workflow-exec/pain-point-collateral/start', { input: {} });
    expect(r.status).toBe(404);
  });
});
