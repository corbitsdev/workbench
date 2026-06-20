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

describe('resource-enrichment native workflow', () => {
  test('runs intake → enrich, gates on selection-approval, then exports', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('selection-approval', {});

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual([
      'resource-enrichment-intake',
      'resource-enrichment-enrich',
      'resource-enrichment-export',
    ]);

    const signalReceived = result.events.find((e) => e.kind === 'SignalReceived');
    expect(signalReceived).toBeDefined();
  });
});
