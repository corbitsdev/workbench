import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
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

const INTAKE_PAYLOAD = { subreddits: ['devops'], keywords: ['observability'] };
const REVIEW_PAYLOAD = {
  selected: [
    {
      id: 'opp-1',
      title: 'Anyone using X for tracing?',
      subreddit: 'devops',
      signal: 'buying-signal' as const,
      detail: 'Active buying-intent thread.',
    },
  ],
};

describe('reddit-opportunity-scanner native workflow', () => {
  test('gates on intake, runs scan, gates on recommendation-review, then persists via map', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', INTAKE_PAYLOAD);
    await run.signal('recommendation-review', REVIEW_PAYLOAD);

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    // scan + one persist-item step from the map (index 0)
    expect(ran[0]).toBe('reddit-opportunity-scan');
    expect(ran[1]).toBe('reddit-opp-persist-item');

    const signalNames = result.events
      .filter((e) => e.kind === 'SignalReceived')
      .map((e) => (e as { signalName: string }).signalName);
    expect(signalNames).toContain('intake');
    expect(signalNames).toContain('recommendation-review');
  });

  test('persist is a map of deterministicToolStep artifact_create steps', () => {
    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== 'map') {
      throw new Error('expected a map primitive for persist');
    }
    expect(persist.over).toEqual({ from: 'steps.review.output.selected' });
    const inner = persist.step;
    expect(inner.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toContain('artifact_create');
    expect(inner.agent.inference.sources).toEqual([]);

    const argMapTag = inner.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error('expected an argMap tag on persist inner step');
    expect(JSON.parse(argMapTag)).toEqual({
      title: { from: 'title' },
      kind: { literal: 'document' },
      content: { from: 'detail' },
    });
  });

  test('intake signal carries subreddits and keywords', async () => {
    const { invoker } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', INTAKE_PAYLOAD);
    await run.signal('recommendation-review', REVIEW_PAYLOAD);
    const result = await run.complete;

    const intakeEvent = result.events.find(
      (e) => e.kind === 'SignalReceived' && 'signalName' in e && e.signalName === 'intake'
    );
    expect(intakeEvent).toBeDefined();
    if (intakeEvent === undefined || !('payload' in intakeEvent)) {
      throw new Error('intake event missing payload');
    }
    const payload = intakeEvent.payload as typeof INTAKE_PAYLOAD;
    expect(payload.subreddits).toEqual(['devops']);
    expect(payload.keywords).toEqual(['observability']);
  });

  test('scan step receives intake output as input', () => {
    const scan = workflow.steps.scan;
    if (scan === undefined || scan.kind !== 'step') {
      throw new Error('expected a step primitive for scan');
    }
    expect(scan.input).toEqual({ from: 'steps.intake.output' });
    expect(scan.after).toContain('intake');
  });

  test('review awaitSignal fires after scan', () => {
    const review = workflow.steps.review;
    if (review === undefined || review.kind !== 'awaitSignal') {
      throw new Error('expected an awaitSignal primitive for review');
    }
    expect(review.name).toBe('recommendation-review');
    expect(review.after).toContain('scan');
  });
});
