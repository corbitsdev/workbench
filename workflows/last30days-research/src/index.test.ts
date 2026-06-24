import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
} from '@workbench/agents';

import { workflow } from './index';

const SOURCE_STEP_IDS = [
  'hackernews',
  'github',
  'web',
  'reddit',
  'x',
  'youtube',
  'bluesky',
] as const;

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: { id: string; input: unknown }[];
} {
  const ran: { id: string; input: unknown }[] = [];
  const invoker: StepInvoker = async ({ agent, input }) => {
    ran.push({ id: agent.id, input });
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

describe('last30days-research native workflow', () => {
  test('gates on intake, fans out sources, briefs, writes, then persists', async () => {
    const { invoker, ran } = makeRecordingInvoker({
      'last30days-build-brief': { content: '{"topic":"AI coding tools"}' },
      'last30days-write-report': {
        reply: 'What I learned about AI coding tools:',
      },
      'last30days-persist-artifact': { artifactId: 'art_1' },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', {
      topic: 'AI coding tools',
      query: 'AI coding tools',
      days: 30,
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe('completed');

    const ranIds = ran.map((r) => r.id);
    for (const source of SOURCE_STEP_IDS) {
      expect(ranIds).toContain(`last30days-fetch-${source}`);
    }
    expect(ranIds).toContain('last30days-build-brief');
    expect(ranIds).toContain('last30days-write-report');
    expect(ranIds).toContain('last30days-persist-artifact');

    // Removed decorative/dead steps must not run.
    expect(ranIds).not.toContain('last30days-extract-entities');
    expect(ranIds).not.toContain('last30days-validate-report');

    for (const source of SOURCE_STEP_IDS) {
      expect(ranIds).toContain(`last30days-fetch-${source}`);
    }
    expect(ranIds.at(-1)).toBe('last30days-persist-artifact');
  });

  test('sources are deterministic tool steps chained serially after intake', () => {
    // Serial chain (CL-2314 mitigation): intake -> hackernews -> github -> ... -> bluesky.
    // The chain is load-bearing — a parallel fan-out races the retry scheduler
    // on the run event log's single-writer seq guard. Each source must depend on
    // exactly its predecessor so no two source bodies are ever in flight at once.
    const expectedPredecessor: Record<(typeof SOURCE_STEP_IDS)[number], string> = {
      hackernews: 'intake',
      github: 'hackernews',
      web: 'github',
      reddit: 'web',
      x: 'reddit',
      youtube: 'x',
      bluesky: 'youtube',
    };
    for (const source of SOURCE_STEP_IDS) {
      const step = workflow.steps[source];
      if (step === undefined || step.kind !== 'step') {
        throw new Error(`expected a step primitive for ${source}`);
      }
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(step.after).toEqual([expectedPredecessor[source]]);
    }
  });

  test('brief step pins last30days_workflow_brief with a canonical runtime name', () => {
    const brief = workflow.steps.brief;
    if (brief === undefined || brief.kind !== 'step') {
      throw new Error('expected a step primitive for brief');
    }
    expect(brief.agent.tags?.[STEP_TOOL_TAG]).toBe(
      '@workbench/tools-last30days/core:last30days_workflow_brief'
    );
  });

  test('write is an inline-inference step; persist is deterministic and gated on write', () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== 'step') {
      throw new Error('expected a step primitive for write');
    }
    expect(write.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(write.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(write.agent.systemPrompt.length).toBeGreaterThan(0);

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== 'step') {
      throw new Error('expected a step primitive for persist');
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain('write_artifact');
    expect(persist.after).toContain('write');
    expect(persist.after).not.toContain('validate');
  });
});
