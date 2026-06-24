import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';

import { EPHEMERAL_CHAT_TAG, INLINE_INFERENCE_KIND, STEP_KIND_TAG } from '@workbench/agents';

import { kind, workflow } from './index';

describe('myra-ephemeral-spike workflow', () => {
  test('runs the single inline chat step on trigger payload', async () => {
    const invoker: StepInvoker = async ({ agent, input }) => {
      expect(agent.id).toBe('myra-ephemeral-spike-chat');
      return { output: { reply: `echo:${JSON.stringify(input)}` } };
    };

    const run = runLocal(workflow, { invokeStep: invoker });
    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
  });

  test('chat step is inline inference (no per-step deploy session)', () => {
    const chat = workflow.steps.chat;
    if (chat === undefined || chat.kind !== 'step') {
      throw new Error('expected a step primitive for chat');
    }
    expect(chat.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(chat.agent.tags?.[EPHEMERAL_CHAT_TAG]).toBe('v1');
    expect(chat.input).toEqual({ from: 'trigger.payload' });
  });

  test('kind matches package convention', () => {
    expect(kind).toBe('myra-ephemeral-spike');
  });
});