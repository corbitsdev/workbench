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

describe('seo-enrichment native workflow', () => {
  test('gates on the intake signal, runs only the enrich agent, then gates on row-selection', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', { rows: [{ id: 'r1', name: 'Widget' }] });
    await run.signal('row-selection', { selections: [] });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual(['seo-enrich']);

    const signalNames = result.events.flatMap((e) =>
      e.kind === 'SignalReceived' ? [e.signalName] : [],
    );
    expect(signalNames).toContain('intake');
    expect(signalNames).toContain('row-selection');
  });
});
