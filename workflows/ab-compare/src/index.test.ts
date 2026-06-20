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

describe('ab-compare native workflow', () => {
  test('gates on input, runs execute → compare, gates on comparison-review, then persists', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('input', { content: 'hello', prompt: 'rewrite it' });
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
});
