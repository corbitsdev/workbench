import { describe, expect, test } from 'bun:test';
import { defineAgent } from '@intx/agent';
import { defineWorkflow, step, awaitSignal } from '@intx/workflow';
import { runLocal } from '@intx/workflow/runlocal';
import type { StepInvoker } from '@intx/workflow/runtime';

import { collateralGenerationWorkflowNative } from './workflow-native';

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

describe('collateral-generation native workflow', () => {
  test('executes intake → analyze → generate in order then awaits approval signal', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(collateralGenerationWorkflowNative, { invokeStep: invoker });

    await run.signal('artifact-approval', { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual(['collateral-intake', 'collateral-analyze', 'collateral-generate']);

    const signalReceived = result.events.find((e) => e.kind === 'SignalReceived');
    expect(signalReceived).toBeDefined();
  });

  test('workflow is blocked at approval until signal arrives', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(collateralGenerationWorkflowNative, { invokeStep: invoker });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.length === 3) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    let completed = false;
    void run.complete.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await run.signal('artifact-approval', { approved: true });
    const result = await run.complete;
    expect(result.terminalStatus).toBe('completed');
  });

  test('approval signal timeout fails the workflow', async () => {
    const { invoker } = makeRecordingInvoker();

    const shortTimeoutDef = defineWorkflow({
      id: 'collateral-generation-timeout-test',
      trigger: { type: 'manual' },
      steps: {
        intake: step({
          agent: defineAgent({
            id: 'stub-intake',
            systemPrompt: 'stub',
            tools: [],
            capabilities: [],
            inference: { sources: [{ provider: 'fake', model: 'fake' }] },
          }),
        }),
        approval: awaitSignal({ name: 'artifact-approval', timeout: 10, after: ['intake'] }),
      },
    });

    const result = await runLocal(shortTimeoutDef, { invokeStep: invoker }).complete;
    expect(result.terminalStatus).toBe('failed');
    const stepFailed = result.events.find(
      (e) => e.kind === 'StepFailed' && e.stepId === 'approval',
    );
    expect(stepFailed).toBeDefined();
  });

});
