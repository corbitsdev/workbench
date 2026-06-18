import { describe, expect, it, mock } from 'bun:test';
import type { InferenceSource } from '@intx/types/runtime';

let sendImpl: () => Promise<{ reply: string }> = async () => ({ reply: 'default' });
let closed = false;

mock.module('@intx/storage-isogit', () => ({
  createIsogitStore: async () => ({}),
}));

// Stub isAnnotatedPluginFactory so @intx/tool-packaging (which imports it
// transitively via @intx/hub-sessions) doesn't crash in combined test runs.
mock.module('@intx/agent', () => ({
  isAnnotatedPluginFactory: (_value: unknown): _value is never => false,
  defineAgent: () => ({}),
  createDefaultDirectorRegistry: () => ({}),
  createAgent: async () => ({
    send: () => sendImpl(),
    // eslint-disable-next-line require-yield
    async *stream() {
      return;
    },
    close: async () => {
      closed = true;
    },
  }),
}));

const { runSingleTurnAgent } = await import('./inference');

const source = { provider: 'openai', model: 'test-model' } as unknown as InferenceSource;

describe('runSingleTurnAgent', () => {
  it('returns the reply when inference resolves in time', async () => {
    closed = false;
    sendImpl = async () => ({ reply: 'hello world' });
    const reply = await runSingleTurnAgent(source, 'sys', 'user', 'test-ctx', undefined, 1000);
    expect(reply).toBe('hello world');
    expect(closed).toBe(true);
  });

  it('propagates a normal inference error and still closes the agent', async () => {
    closed = false;
    sendImpl = async () => {
      throw new Error('provider 500');
    };
    const error = await runSingleTurnAgent(source, 'sys', 'user', 'test-ctx', undefined, 1000)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('provider 500');
    expect(closed).toBe(true);
  });

  it('rejects with a timeout error when inference hangs, and still closes the agent', async () => {
    closed = false;
    sendImpl = () => new Promise<{ reply: string }>(() => {});
    const error = await runSingleTurnAgent(source, 'sys', 'user', 'test-ctx', undefined, 50)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Inference timed out after 50ms');
    expect(closed).toBe(true);
  });
});
