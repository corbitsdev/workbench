import { describe, expect, test } from 'bun:test';
import { defineAgent } from '@intx/agent';
import { defineWorkflow, step, awaitSignal } from '@intx/workflow';
import { runLocal } from '@intx/workflow/runlocal';
import type { StepInvoker } from '@intx/workflow/runtime';

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

const STEP_KIND_TAG = 'workbench.stepKind';
const STEP_TOOL_TAG = 'workbench.tool';
const DETERMINISTIC_TOOL_KIND = 'deterministic-tool';

describe('pain-point-collateral native workflow', () => {
  test('executes intake → select → fetch → analyze → generate then awaits approval', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('note-selection', { noteId: 'note_123' });
    await run.signal('artifact-approval', { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual([
      'pain-point-collateral-intake',
      'pain-point-collateral-fetch',
      'pain-point-collateral-analyze',
      'pain-point-collateral-generate',
    ]);

    const signalReceived = result.events.find((e) => e.kind === 'SignalReceived');
    expect(signalReceived).toBeDefined();
  });

  function stepPrimitive(id: string) {
    const primitive = workflow.steps[id];
    if (primitive === undefined || primitive.kind !== 'step') {
      throw new Error(`expected step primitive for ${id}`);
    }
    return primitive;
  }

  test('intake and fetch are deterministic tool steps, not inference steps', () => {
    const intake = stepPrimitive('intake');
    const fetchStep = stepPrimitive('fetch');
    const analyze = stepPrimitive('analyze');

    expect(intake.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain('granola_list_notes');
    expect(intake.agent.inference.sources).toEqual([]);

    expect(fetchStep.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetchStep.agent.tags?.[STEP_TOOL_TAG]).toContain('granola_get_note');
    expect(fetchStep.agent.inference.sources).toEqual([]);

    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.inference.sources.length).toBeGreaterThan(0);
  });

  test('fetch maps the selection-signal payload to granola_get_note args', () => {
    expect(stepPrimitive('fetch').input).toEqual({ from: 'steps.select.output' });
  });

  test('workflow is blocked at approval until signal arrives', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('note-selection', { noteId: 'note_123' });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.length === 4) {
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
      id: 'pain-point-collateral-timeout-test',
      trigger: { type: 'manual' },
      steps: {
        analyze: step({
          agent: defineAgent({
            id: 'stub-analyze',
            systemPrompt: 'stub',
            tools: [],
            capabilities: [],
            inference: { sources: [{ provider: 'fake', model: 'fake' }] },
          }),
        }),
        approval: awaitSignal({ name: 'artifact-approval', timeout: 10, after: ['analyze'] }),
      },
    });

    const result = await runLocal(shortTimeoutDef, { invokeStep: invoker }).complete;
    expect(result.terminalStatus).toBe('failed');
    const stepFailed = result.events.find(
      (e) => e.kind === 'StepFailed' && e.stepId === 'approval'
    );
    expect(stepFailed).toBeDefined();
  });
});
