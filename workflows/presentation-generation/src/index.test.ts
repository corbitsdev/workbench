import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';

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

describe('presentation-generation native workflow', () => {
  test('runs template → source → generate, gates on review-approval, then renders', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('review-approval', {});

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual([
      'presentation-template',
      'presentation-source',
      'presentation-generate',
      'presentation-render',
    ]);

    const signalReceived = result.events.find((e) => e.kind === 'SignalReceived');
    expect(signalReceived).toBeDefined();
  });
});
