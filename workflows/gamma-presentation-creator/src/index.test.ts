import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
} from '@workbench/agents';

import { workflow } from './index';

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

describe('gamma-presentation-creator native workflow', () => {
  test('lists templates, gates on the template form, lists notes, gates on source selection, fetches the note, generates, gates on review, then renders', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'presentation-list-notes': {
        notes: [{ id: 'note_1', title: 'Acme call' }],
        hasMore: false,
      },
      'presentation-source': {
        id: 'note_1',
        title: 'Acme call',
        summary: 'Discovery',
      },
      'presentation-generate': { reply: 'Draft deck' },
      'presentation-brand-review': { reply: 'Build a deck', title: 'Acme' },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('template', { gammaId: 'tmpl_1', goal: 'Close' });
    await run.signal('source-selection', { noteId: 'note_1' });
    await run.signal('review-approval', { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran.map((r) => r.id)).toEqual([
      'presentation-list-templates',
      'presentation-list-notes',
      'presentation-source',
      'presentation-generate',
      'presentation-brand-review',
      'presentation-render',
    ]);
  });

  test('passes the source-selection signal payload as granola_get_note args', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'presentation-source': { id: 'note_42', summary: 'x' },
      'presentation-generate': { reply: 'draft' },
      'presentation-brand-review': { reply: 'p' },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('template', { gammaId: 'tmpl_1', goal: 'Close' });
    await run.signal('source-selection', { noteId: 'note_42' });
    await run.signal('review-approval', { approved: true });

    await run.complete;

    const sourceStep = ran.find((r) => r.id === 'presentation-source');
    expect(sourceStep?.input).toEqual({ noteId: 'note_42' });
  });

  test('feeds the template form and source note into the generate step', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'presentation-source': {
        id: 'note_1',
        title: 'Acme call',
        summary: 'Discovery',
      },
      'presentation-generate': { reply: 'draft' },
      'presentation-brand-review': { reply: 'p' },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('template', {
      gammaId: 'tmpl_1',
      audience: 'Investors',
      goal: 'Close',
    });
    await run.signal('source-selection', { noteId: 'note_1' });
    await run.signal('review-approval', { approved: true });

    await run.complete;

    const generateStep = ran.find((r) => r.id === 'presentation-generate');
    expect(generateStep?.input).toMatchObject({
      gammaId: 'tmpl_1',
      audience: 'Investors',
      goal: 'Close',
      summary: 'Discovery',
    });
  });

  test('feeds the template gammaId and reviewed draft into the render tool', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'presentation-source': { id: 'note_1', summary: 'x' },
      'presentation-generate': { reply: 'Draft deck about Acme' },
      'presentation-brand-review': {
        reply: 'Build a deck about Acme',
        title: 'Acme',
      },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('template', { gammaId: 'tmpl_99', goal: 'Close' });
    await run.signal('source-selection', { noteId: 'note_1' });
    await run.signal('review-approval', { approved: true });

    await run.complete;

    const renderStep = ran.find((r) => r.id === 'presentation-render');
    expect(renderStep?.input).toMatchObject({
      gammaId: 'tmpl_99',
      reply: 'Build a deck about Acme',
    });
  });

  test('generate is an inline-inference step with no vestigial tool capabilities', () => {
    const generate = workflow.steps.generate;
    if (generate === undefined || generate.kind !== 'step') {
      throw new Error('expected a step primitive for generate');
    }
    expect(generate.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(generate.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(generate.agent.capabilities).toEqual([]);
    expect(generate.agent.inference.sources).toEqual([]);
    expect(generate.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(generate.input).toEqual({
      merge: [{ from: 'steps.template.output' }, { from: 'steps.source.output' }],
    });
    expect(generate.after).toContain('source');
  });

  test('brand-review is an inline-inference step receiving the generate output', () => {
    const brandReview = workflow.steps['brand-review'];
    if (brandReview === undefined || brandReview.kind !== 'step') {
      throw new Error('expected a step primitive for brand-review');
    }
    expect(brandReview.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(brandReview.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(brandReview.agent.capabilities).toEqual([]);
    expect(brandReview.agent.inference.sources).toEqual([]);
    expect(brandReview.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(brandReview.input).toEqual({ from: 'steps.generate.output' });
    expect(brandReview.after).toContain('generate');
  });

  test('render is a deterministic tool step with an argMap, not an inference step', () => {
    const render = workflow.steps.render;
    if (render === undefined || render.kind !== 'step') {
      throw new Error('expected a step primitive for render');
    }
    expect(render.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(render.agent.tags?.[STEP_TOOL_TAG]).toContain('gamma_create_from_template');
    expect(render.agent.inference.sources).toEqual([]);
    const argMapTag = render.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error('expected an argMap tag');
    expect(JSON.parse(argMapTag)).toEqual({
      gammaId: { from: 'gammaId' },
      prompt: { from: 'reply' },
    });
  });
});
