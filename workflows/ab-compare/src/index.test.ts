import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  DETERMINISTIC_TOOL_KIND,
} from '@workbench/agents';

import { workflow } from './index';

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: string[];
} {
  const ran: string[] = [];
  const invoker: StepInvoker = async ({ agent }) => {
    ran.push(agent.id);
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

describe('ab-compare native workflow', () => {
  test('gates on input, runs execute → compare, gates on comparison-review, then persists', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    // Input payload: { prompt } only — no `content` field.
    await run.signal('input', { prompt: 'rewrite it' });
    await run.signal('comparison-review', { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual(['blind-ab-execute', 'blind-ab-compare', 'blind-ab-persist']);

    const signalNames = result.events
      .filter((e) => e.kind === 'SignalReceived')
      .map((e) => ('signalName' in e ? e.signalName : undefined));
    expect(signalNames).toContain('input');
    expect(signalNames).toContain('comparison-review');
  });

  test('persist is a deterministic artifact_create step with an argMap, not inference', () => {
    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== 'step') {
      throw new Error('expected a step primitive for persist');
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain('artifact_create');
    expect(persist.agent.inference.sources).toEqual([]);
    expect(persist.input).toEqual({ from: 'steps.compare.output' });
    const argMapTag = persist.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error('expected an argMap tag');
    expect(JSON.parse(argMapTag)).toEqual({
      content: { from: 'reply' },
      title: { literal: 'A/B Comparison Results' },
      kind: { literal: 'document' },
    });
  });

  test('execute step receives input from the input signal output', () => {
    const execute = workflow.steps.execute;
    if (execute === undefined || execute.kind !== 'step') {
      throw new Error('expected a step primitive for execute');
    }
    expect(execute.input).toEqual({ from: 'steps.input.output' });
    expect(execute.after).toContain('input');
  });

  test('compare step receives input from the execute step output', () => {
    const compare = workflow.steps.compare;
    if (compare === undefined || compare.kind !== 'step') {
      throw new Error('expected a step primitive for compare');
    }
    expect(compare.input).toEqual({ from: 'steps.execute.output' });
    expect(compare.after).toContain('execute');
  });

  test('review signal gates between compare and persist', () => {
    const review = workflow.steps.review;
    if (review === undefined || review.kind !== 'awaitSignal') {
      throw new Error('expected an awaitSignal primitive for review');
    }
    expect(review.name).toBe('comparison-review');
    expect(review.after).toContain('compare');

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== 'step') {
      throw new Error('expected a step primitive for persist');
    }
    expect(persist.after).toContain('review');
  });
});
