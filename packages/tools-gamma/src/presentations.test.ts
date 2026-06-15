import { describe, expect, it } from 'bun:test';
import { createPresentationTools } from './presentations';
import type { GammaFetch } from './shared';

function makeFetcher(responses: Array<{ status: number; body: unknown }>): GammaFetch {
  let callIndex = 0;
  return async (_input, _init) => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];
    if (!response) throw new Error('no mock response configured');
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

const baseConfig = { apiKey: 'test-key' };

describe('gamma_duplicate_presentation', () => {
  it('polls until completed and returns gammaUrl and gammaId', async () => {
    const tools = createPresentationTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: 'gen_copy' } },
        {
          status: 200,
          body: {
            status: 'completed',
            gammaUrl: 'https://gamma.app/deck/copy-abc',
            gammaId: 'g_copy',
          },
        },
      ]),
    });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');

    const result = await tool.handler({ gammaId: 'g_orig' }, new AbortController().signal);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['gammaUrl']).toBe('https://gamma.app/deck/copy-abc');
    expect(parsed['gammaId']).toBe('g_copy');
  });

  it('throws when gammaId is missing', async () => {
    const tools = createPresentationTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 200, body: {} }]),
    });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');
    await expect(tool.handler({}, new AbortController().signal)).rejects.toThrow(
      'gammaId is required'
    );
  });

  it('uses default prompt when none is provided', async () => {
    const capturedBodies: string[] = [];
    const fetcher: GammaFetch = async (_input, init) => {
      capturedBodies.push(init.body as string);
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({ generationId: 'gen_d' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          gammaUrl: 'https://gamma.app/deck/d',
          gammaId: 'g_d',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const tools = createPresentationTools({ ...baseConfig, fetcher });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');
    await tool.handler({ gammaId: 'g_orig' }, new AbortController().signal);
    const body = JSON.parse(capturedBodies[0] ?? '{}') as Record<string, unknown>;
    expect(typeof body['prompt']).toBe('string');
    expect((body['prompt'] as string).length).toBeGreaterThan(0);
  });

  it('includes optional title when provided and omits it when absent', async () => {
    const capturedBodies: string[] = [];
    const fetcher: GammaFetch = async (_input, init) => {
      capturedBodies.push(init.body as string);
      if (capturedBodies.length % 2 === 1) {
        return new Response(JSON.stringify({ generationId: `gen_${capturedBodies.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          gammaUrl: 'https://gamma.app/deck/x',
          gammaId: 'g_x',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const tools = createPresentationTools({ ...baseConfig, fetcher });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');

    await tool.handler({ gammaId: 'g_orig', title: 'Q3 Copy' }, new AbortController().signal);
    const withTitle = JSON.parse(capturedBodies[0] ?? '{}') as Record<string, unknown>;
    expect(withTitle['title']).toBe('Q3 Copy');

    await tool.handler({ gammaId: 'g_orig' }, new AbortController().signal);
    const withoutTitle = JSON.parse(capturedBodies[2] ?? '{}') as Record<string, unknown>;
    expect('title' in withoutTitle).toBe(false);
  });

  it('throws when generation fails', async () => {
    const tools = createPresentationTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: 'gen_fail' } },
        { status: 200, body: { status: 'failed' } },
      ]),
    });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');
    await expect(tool.handler({ gammaId: 'g_orig' }, new AbortController().signal)).rejects.toThrow(
      'Gamma generation failed'
    );
  });

  it('throws on non-2xx response', async () => {
    const tools = createPresentationTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 404, body: { error: 'Not Found' } }]),
    });
    const tool = tools.find((t) => t.definition.name === 'gamma_duplicate_presentation');
    if (!tool || tool.kind !== 'string') throw new Error('tool not found');
    await expect(
      tool.handler({ gammaId: 'g_missing' }, new AbortController().signal)
    ).rejects.toThrow('Gamma API error: 404');
  });
});
