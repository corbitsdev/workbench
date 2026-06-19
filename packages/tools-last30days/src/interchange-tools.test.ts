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

  test('exposes the three core tools', () => {
    const bundle = last30days(env);
    expect(bundle.definitions.map((d) => d.name).sort()).toEqual([
      'last30days_core_extract',
      'last30days_core_report',
      'last30days_validate',
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
});
