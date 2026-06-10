import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const sendMock = mock(async (_msg: string) => ({ reply: 'agent reply' }));
const closeMock = mock(async () => {});
const createAgentMock = mock(async () => ({ send: sendMock, close: closeMock }));
const defineAgentMock = mock((def: unknown) => def);
const createDefaultDirectorRegistryMock = mock(() => ({}));

mock.module('@intx/agent', () => ({
  createAgent: createAgentMock,
  defineAgent: defineAgentMock,
  createDefaultDirectorRegistry: createDefaultDirectorRegistryMock,
}));

mock.module('@intx/storage-isogit', () => ({
  createIsogitStore: mock(async () => ({})),
}));

import { runSingleTurnAgent } from './inference';

const TEST_SOURCE = {
  id: 'src-1',
  provider: 'openai-compatible' as const,
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
};

beforeEach(() => {
  sendMock.mockClear();
  closeMock.mockClear();
  createAgentMock.mockClear();
  defineAgentMock.mockClear();
});

afterEach(() => {});

describe('runSingleTurnAgent', () => {
  it('returns the reply from the agent', async () => {
    const result = await runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test');
    expect(result).toBe('agent reply');
  });

  it('calls agent.close() after send', async () => {
    await runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('calls agent.close() even when send throws', async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new Error('send failed');
    });
    await expect(runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test')).rejects.toThrow(
      'send failed'
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('applies maxOutputTokens to the source defaults when provided', async () => {
    await runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test', 512);
    // biome-ignore lint/suspicious/noExplicitAny: mock.calls is untyped
    const capturedEnv = (createAgentMock.mock.calls[0] as any)?.[1] as any;
    expect(capturedEnv?.source?.defaults?.maxTokens).toBe(512);
  });

  it('leaves source defaults unchanged when maxOutputTokens is not provided', async () => {
    await runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test');
    // biome-ignore lint/suspicious/noExplicitAny: mock.calls is untyped
    const capturedEnv = (createAgentMock.mock.calls[0] as any)?.[1] as any;
    expect(capturedEnv?.source?.defaults?.maxTokens).toBeUndefined();
  });

  it('passes a permissive authorize function (no tools)', async () => {
    await runSingleTurnAgent(TEST_SOURCE, 'system', 'hello', 'test');
    // biome-ignore lint/suspicious/noExplicitAny: mock.calls is untyped
    const capturedEnv = (createAgentMock.mock.calls[0] as any)?.[1] as any;
    const result = await capturedEnv?.authorize('any:resource', 'read');
    expect(result?.effect).toBe('allow');
  });
});
