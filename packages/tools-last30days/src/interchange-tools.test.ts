import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { last30days } from './interchange-tools';
import { createLast30daysTools } from './tools';

const env = {} as BaseEnv;

describe('tools-last30days interchange.tools entry', () => {
  test('exports a namespaced keyless AnnotatedToolFactory', () => {
    expect(typeof last30days).toBe('function');
    expect(last30days.id).toBe('@workbench/tools-last30days/core');
    expect(last30days.requires).toEqual([]);
  });

  test('exposes the core and workflow helper tools', () => {
    const bundle = last30days(env);
    expect(bundle.definitions.map((d) => d.name).sort()).toEqual([
      'last30days_core_extract',
      'last30days_core_report',
      'last30days_validate',
      'last30days_workflow_brief',
      'last30days_workflow_normalize_intake',
    ]);
  });

  test('extract returns entities for a topic', async () => {
    const tools = createLast30daysTools();
    const extract = tools.find((t) => t.definition.name === 'last30days_core_extract');
    if (extract?.kind !== 'string') throw new Error('expected a string tool');
    const out = await extract.handler({ topic: 'solana defi' }, AbortSignal.timeout(1000));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  test('workflow brief folds source step envelopes into a report', async () => {
    const tools = createLast30daysTools();
    const brief = tools.find((t) => t.definition.name === 'last30days_workflow_brief');
    if (brief?.kind !== 'string') throw new Error('expected a string tool');
    const out = await brief.handler(
      {
        intake: { output: { topic: 'AI coding tools', days: 30 } },
        hackernews: {
          output: {
            content: JSON.stringify([
              {
                url: 'https://news.ycombinator.com/item?id=1',
                title: 'AI coding tools discussion',
                publishedAt: new Date().toISOString(),
                source: 'hn',
                engagement: { upvotes: 10, comments: 2 },
              },
            ]),
          },
        },
      },
      AbortSignal.timeout(1000)
    );
    const parsed = JSON.parse(out) as { topic?: string; items?: unknown[] };
    expect(parsed.topic).toBe('AI coding tools');
    expect(parsed.items?.length).toBe(1);
  });
});
