import { describe, expect, it, mock } from 'bun:test';
import * as realInference from '@intx/inference';
import type { ImageBlock, InferenceSource } from '@intx/types/runtime';

// Controls what the mocked runInference yields (or how it hangs) per test.
let inferenceImpl: (opts: { signal?: AbortSignal }) => AsyncIterable<unknown>;
let capturedOpts: Record<string, unknown> | undefined;

// Spread the real module so @intx/agent's own imports (createDefaultDirector,
// etc.) survive; only runInference + createDefaultDependencies are stubbed.
mock.module('@intx/inference', () => ({
  ...realInference,
  createDefaultDependencies: mock(() => ({ fetch: mock(), scheduler: { now: () => 0 } })),
  runInference: (opts: Record<string, unknown>) => {
    capturedOpts = opts;
    return inferenceImpl(opts as { signal?: AbortSignal });
  },
}));

const { runSingleTurnAgentWithImage } = await import('./inference');

const SOURCE = {
  provider: 'openai',
  model: 'gpt-4o',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
} as unknown as InferenceSource;

const IMAGE: ImageBlock = {
  type: 'image',
  source: { kind: 'base64', mimeType: 'image/png', data: 'aGVsbG8=' },
};

async function* yieldEvents(events: unknown[]) {
  for (const event of events) yield event;
}

describe('runSingleTurnAgentWithImage', () => {
  it('sends a multimodal turn and returns the accumulated reply text', async () => {
    inferenceImpl = () =>
      yieldEvents([
        { type: 'inference.done', data: { turn: { content: [{ type: 'text', text: 'hello ' }] } } },
        { type: 'inference.done', data: { turn: { content: [{ type: 'text', text: 'world' }] } } },
      ]);

    const reply = await runSingleTurnAgentWithImage(SOURCE, 'system', 'describe', IMAGE, 4096);
    expect(reply).toBe('hello world');

    const turns = capturedOpts?.turns as Array<{ role: string; content: unknown[] }>;
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.content).toContainEqual(IMAGE);
    const opts = capturedOpts?.inferenceOptions as { systemPrompt: string; maxTokens: number };
    expect(opts.systemPrompt).toBe('system');
    expect(opts.maxTokens).toBe(4096);
  });

  it('throws on an inference.error event', async () => {
    inferenceImpl = () =>
      yieldEvents([{ type: 'inference.error', data: { error: { message: 'boom' } } }]);
    await expect(runSingleTurnAgentWithImage(SOURCE, 's', 'u', IMAGE)).rejects.toThrow();
  });

  it('throws when the model refuses', async () => {
    inferenceImpl = () => yieldEvents([{ type: 'inference.refusal.delta', data: {} }]);
    await expect(runSingleTurnAgentWithImage(SOURCE, 's', 'u', IMAGE)).rejects.toThrow(/refus/i);
  });

  it('aborts and throws when the call exceeds the timeout', async () => {
    // A never-yielding async iterator whose next() rejects when the abort
    // signal fires — models a hung provider the helper must bound.
    inferenceImpl = (opts) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<unknown>>((_, reject) => {
              opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        };
      },
    });
    await expect(
      runSingleTurnAgentWithImage(SOURCE, 's', 'u', IMAGE, undefined, 20)
    ).rejects.toThrow(/timed out/i);
  });
});
