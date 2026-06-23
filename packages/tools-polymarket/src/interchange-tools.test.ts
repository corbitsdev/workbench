import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { polymarket } from './interchange-tools';

const env = {} as BaseEnv;

describe('tools-polymarket interchange.tools entry', () => {
  test('exports a namespaced keyless AnnotatedToolFactory', () => {
    expect(typeof polymarket).toBe('function');
    expect(polymarket.id).toBe('@workbench/tools-polymarket/polymarket');
    expect(polymarket.requires).toEqual([]);
  });

  test('the bundle exposes the polymarket tool and upholds the dispatch contract', async () => {
    const bundle = polymarket(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
    const result = await bundle.run(
      { id: 'c1', name: 'not_a_tool', arguments: {} },
      AbortSignal.timeout(1000)
    );
    expect(result.isError).toBe(true);
  });
});
