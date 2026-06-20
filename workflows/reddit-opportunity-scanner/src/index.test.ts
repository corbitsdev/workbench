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
  test('gates on intake, runs analyze, gates on recommendation-review, then scans', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', { url: 'https://example.com' });
    await run.signal('recommendation-review', { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual(['reddit-opportunity-analyze', 'reddit-opportunity-scan']);

    const signalNames = result.events
      .filter((e) => e.kind === 'SignalReceived')
      .map((e) => (e as { signalName: string }).signalName);
    expect(signalNames).toContain('intake');
    expect(signalNames).toContain('recommendation-review');
  });
});
