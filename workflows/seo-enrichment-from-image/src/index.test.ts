import { describe, expect, test } from 'bun:test';
import type { StepInvoker } from '@intx/workflow/runtime';
import { runLocal } from '@intx/workflow/runlocal';
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  DETERMINISTIC_TOOL_KIND,
} from '@workbench/agents';

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
  test('gates on intake signal, runs enrich, gates on row-selection, then persists', async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal('intake', {
      imageUrl: 'https://example.com/product.jpg',
      pageUrl: 'https://example.com/page',
    });
    await run.signal('row-selection', { selectedIds: ['title', 'meta_description'] });

    const result = await run.complete;

    expect(result.terminalStatus).toBe('completed');
    expect(ran).toEqual(['seo-enrich', 'seo-enrich-persist']);

    const signalNames = result.events.flatMap((e) =>
      e.kind === 'SignalReceived' ? [e.signalName] : []
    );
    expect(signalNames).toContain('intake');
    expect(signalNames).toContain('row-selection');
  });

  test('persist is a deterministic artifact_create step with an argMap', () => {
    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== 'step') {
      throw new Error('expected a step primitive for persist');
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain('artifact_create');
    expect(persist.agent.inference.sources).toEqual([]);
    expect(persist.input).toEqual({ from: 'steps.review.output' });
    const argMapTag = persist.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error('expected an argMap tag');
    expect(JSON.parse(argMapTag)).toEqual({
      content: { from: 'selectedIds' },
      title: { literal: 'SEO Enrichment Results' },
      kind: { literal: 'document' },
    });
  });
});
