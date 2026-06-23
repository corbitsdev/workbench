import { describe, expect, test } from 'bun:test';
import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { runLocal } from '@intx/workflow/runlocal';
import type { StepInvoker } from '@intx/workflow/runtime';
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from '@workbench/agents';

import { workflow } from './index';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: { id: string; input: unknown }[];
} {
  const ran: { id: string; input: unknown }[] = [];
  const invoker: StepInvoker = async ({ agent, input }) => {
    ran.push({ id: agent.id, input });
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== 'step') {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? 'undefined'}`
    );
  }
  return primitive;
}

function mapPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== 'map') {
    throw new Error(`expected map primitive for "${id}", got ${primitive?.kind ?? 'undefined'}`);
  }
  return primitive;
}

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

describe('pain-point-collateral native workflow', () => {
  // -------------------------------------------------------------------------
  // Full happy-path run
  // -------------------------------------------------------------------------
  test('executes full 8-step flow: intake → select → fetch → context → analyze → ppSelection → fmtSelection → generate → review → persist', async () => {
    const analyzeReply = JSON.stringify({
      painPoints: [
        { id: 'pp1', title: 'Slow onboarding', detail: 'Takes weeks.' },
        { id: 'pp2', title: 'No ROI visibility', detail: 'No clear metric.' },
      ],
    });
    const generateReply = JSON.stringify({ format: 'Email', title: 'Email', content: 'Hi...' });

    const { invoker, ran } = makeRecordingInvoker({
      'pain-point-collateral-intake': { notes: [{ id: 'note_1', title: 'Acme call' }] },
      'pain-point-collateral-fetch': { id: 'note_1', title: 'Acme call', summary: 'Discovery' },
      'pain-point-collateral-analyze': AGENT_REPLY(analyzeReply),
      'pain-point-collateral-generate': AGENT_REPLY(generateReply),
      'pain-point-collateral-persist': { artifactId: 'art_1' },
    });

    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('note-selection', { noteId: 'note_1' });
    await run.signal('context', { context: 'Focus on onboarding' });
    await run.signal('pain-point-selection', { selectedIds: ['pp1'] });
    await run.signal('format-selection', {
      items: [
        {
          format: 'Email',
          painPointId: 'pp1',
          painPointTitle: 'Test pain point',
          painPointDetail: 'Detail here',
          severity: 'high',
        },
      ],
    });
    await run.signal('review', {
      decisions: [{ format: 'Email', title: 'Email', content: 'Hi...', approved: true }],
      approvedPieces: [{ format: 'Email', title: 'Email', content: 'Hi...' }],
    });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');

    // Deterministic steps + inference steps (generate runs once per format item)
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain('pain-point-collateral-intake');
    expect(ranIds).toContain('pain-point-collateral-fetch');
    expect(ranIds).toContain('pain-point-collateral-analyze');
    expect(ranIds).toContain('pain-point-collateral-generate');
    expect(ranIds).toContain('pain-point-collateral-persist');
  });

  // -------------------------------------------------------------------------
  // Deterministic step structure
  // -------------------------------------------------------------------------
  test('intake and fetch are deterministic tool steps, not inference steps', () => {
    const intake = stepPrimitive('intake');
    const fetch = stepPrimitive('fetch');

    expect(intake.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain('granola_list_notes');
    expect(intake.agent.inference.sources).toEqual([]);

    expect(fetch.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetch.agent.tags?.[STEP_TOOL_TAG]).toContain('granola_get_note');
    expect(fetch.agent.inference.sources).toEqual([]);
  });

  test('analyze is an inline-inference step (no per-step session) with a real prompt', () => {
    const analyze = stepPrimitive('analyze');
    // Inline single-turn inference (CL-2251): marker tag set, no deterministic
    // tool tag, real reasoning prompt, and no source declared on the definition
    // (the source is pinned at deploy time / resolved by the sidecar).
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(analyze.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(analyze.agent.capabilities).toEqual([]);
    expect(analyze.agent.inference.sources).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Selector wiring
  // -------------------------------------------------------------------------
  test('fetch step input reads from the note-selection signal output', () => {
    expect(stepPrimitive('fetch').input).toEqual({ from: 'steps.select.output' });
  });

  test('analyze step input merges fetch output and context signal output', () => {
    const analyze = stepPrimitive('analyze');
    expect(analyze.input).toEqual({
      merge: [{ from: 'steps.fetch.output' }, { from: 'steps.context.output' }],
    });
  });

  test('generate map iterates over fmtSelection.output.items', () => {
    const gen = mapPrimitive('generate');
    expect(gen.over).toEqual({ from: 'steps.fmtSelection.output.items' });
  });

  test('generate inner step reads input from trigger.payload only', () => {
    const gen = mapPrimitive('generate');
    expect(gen.step.input).toEqual({ from: 'trigger.payload' });
  });

  test('persist map iterates over review.output.approvedPieces', () => {
    const persist = mapPrimitive('persist');
    expect(persist.over).toEqual({ from: 'steps.review.output.approvedPieces' });
  });

  // -------------------------------------------------------------------------
  // Persist step is deterministic with correct argMap
  // -------------------------------------------------------------------------
  test('persist inner step is a deterministic artifact_create with title/kind/content argMap', () => {
    const persist = mapPrimitive('persist');
    const inner = persist.step;
    expect(inner.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toContain('artifact_create');
    expect(inner.agent.inference.sources).toEqual([]);
    const argMapTag = inner.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error('expected argMap tag on persist inner step');
    expect(JSON.parse(argMapTag)).toEqual({
      title: { from: 'title' },
      kind: { from: 'format' },
      content: { from: 'content' },
    });
  });

  // -------------------------------------------------------------------------
  // Signal ordering — workflow blocks until each awaitSignal
  // -------------------------------------------------------------------------
  test('workflow is blocked at context signal after fetch completes', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'pain-point-collateral-intake': { notes: [] },
      'pain-point-collateral-fetch': { id: 'note_1', title: 'x', summary: '' },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('note-selection', { noteId: 'note_1' });

    // Poll for fetch to complete
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === 'pain-point-collateral-fetch')) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // Analyze should NOT have run yet — blocked on context signal
    expect(ran.some((r) => r.id === 'pain-point-collateral-analyze')).toBe(false);

    // Send context — workflow continues
    await run.signal('context', { context: '' });
    await run.signal('pain-point-selection', { selectedIds: [] });
    await run.signal('format-selection', { items: [] });
    await run.signal('review', { decisions: [], approvedPieces: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe('completed');
  });

  test('workflow is blocked at pain-point-selection after analyze completes', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'pain-point-collateral-intake': { notes: [] },
      'pain-point-collateral-fetch': { id: 'note_1', title: 'x' },
      'pain-point-collateral-analyze': AGENT_REPLY(
        JSON.stringify({ painPoints: [{ id: 'pp1', title: 'T', detail: 'D' }] })
      ),
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('note-selection', { noteId: 'note_1' });
    await run.signal('context', { context: '' });

    // Wait for analyze
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === 'pain-point-collateral-analyze')) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // generate should NOT have run — blocked on pain-point-selection
    expect(ran.some((r) => r.id === 'pain-point-collateral-generate')).toBe(false);

    await run.signal('pain-point-selection', { selectedIds: ['pp1'] });
    await run.signal('format-selection', { items: [] });
    await run.signal('review', { decisions: [], approvedPieces: [] });
    await run.complete;
  });

  // -------------------------------------------------------------------------
  // awaitSignal step structure
  // -------------------------------------------------------------------------
  test('select is an awaitSignal step with name note-selection', () => {
    const select = workflow.steps.select;
    if (!select || select.kind !== 'awaitSignal') throw new Error('expected awaitSignal');
    expect(select.name).toBe('note-selection');
  });

  test('context is an awaitSignal step with name context', () => {
    const ctx = workflow.steps.context;
    if (!ctx || ctx.kind !== 'awaitSignal') throw new Error('expected awaitSignal');
    expect(ctx.name).toBe('context');
  });

  test('ppSelection is an awaitSignal step with name pain-point-selection', () => {
    const pp = workflow.steps.ppSelection;
    if (!pp || pp.kind !== 'awaitSignal') throw new Error('expected awaitSignal');
    expect(pp.name).toBe('pain-point-selection');
  });

  test('fmtSelection is an awaitSignal step with name format-selection', () => {
    const fmt = workflow.steps.fmtSelection;
    if (!fmt || fmt.kind !== 'awaitSignal') throw new Error('expected awaitSignal');
    expect(fmt.name).toBe('format-selection');
  });

  test('review is an awaitSignal step with name review', () => {
    const rev = workflow.steps.review;
    if (!rev || rev.kind !== 'awaitSignal') throw new Error('expected awaitSignal');
    expect(rev.name).toBe('review');
  });

  // -------------------------------------------------------------------------
  // Timeout behaviour
  // -------------------------------------------------------------------------
  test('workflow with a short-timeout awaitSignal fails when signal does not arrive', async () => {
    const { invoker } = makeRecordingInvoker();

    const shortTimeoutDef = defineWorkflow({
      id: 'ppc-timeout-test',
      trigger: { type: 'manual' },
      steps: {
        analyze: step({
          agent: defineAgent({
            id: 'stub-analyze',
            systemPrompt: 'stub',
            tools: [],
            capabilities: [],
            inference: { sources: [{ provider: 'fake', model: 'fake' }] },
          }),
        }),
        review: awaitSignal({ name: 'review', timeout: 10, after: ['analyze'] }),
      },
    });

    const result = await runLocal(shortTimeoutDef, { invokeStep: invoker }).complete;
    expect(result.terminalStatus).toBe('failed');
    const stepFailed = result.events.find((e) => e.kind === 'StepFailed' && e.stepId === 'review');
    expect(stepFailed).toBeDefined();
  });
});
