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

describe('reddit-opportunity-scanner native workflow', () => {
  test('runs intake → analyze, gates on recommendation-review, then scans', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('recommendation-review', {});

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual([
      'reddit-opportunity-intake',
      'reddit-opportunity-analyze',
      'reddit-opportunity-scan',
    ]);

    const signalReceived = result.events.find((e) => e.kind === 'SignalReceived');
    expect(signalReceived).toBeDefined();
  });
});
