import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as storageIsogitActual from '@intx/storage-isogit';

const sendMock = mock(async () => ({ reply: 'Refined output text' }));
const closeMock = mock(async () => {});
// biome-ignore lint/suspicious/noExplicitAny: mock needs flexible typing
const createAgentMock = mock(async (_opts: unknown) => ({
  send: sendMock,
  close: closeMock,
})) as any;
const defineAgentMock = mock((def: unknown) => def);
const createDefaultDirectorRegistryMock = mock(() => ({}));

let refineFeedbackWithLLM: (typeof import('./feedback'))['refineFeedbackWithLLM'];

beforeAll(async () => {
  mock.module('@intx/agent', () => ({
    createAgent: createAgentMock,
    defineAgent: defineAgentMock,
    createDefaultDirectorRegistry: createDefaultDirectorRegistryMock,
  }));

  // Spread the real module: mock.module is process-global in Bun and persists
  // past mock.restore(), so dropping unmocked exports (e.g. createDeployPack,
  // which hub-agent imports) breaks later suites order-dependently (CL-1825).
  mock.module('@intx/storage-isogit', () => ({
    ...storageIsogitActual,
    createIsogitStore: mock(async () => ({})),
  }));

  ({ refineFeedbackWithLLM } = await import('./feedback'));
});

afterAll(() => {
  mock.restore();
});

const TEST_SOURCE = {
  id: 'test-src',
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
};

describe('Feedback refinement', () => {
  beforeEach(() => {
    sendMock.mockClear();
    closeMock.mockClear();
    createAgentMock.mockClear();
  });

  afterEach(() => {});

  it('refineFeedbackWithLLM exists and is callable', () => {
    expect(typeof refineFeedbackWithLLM).toBe('function');
  });

  it('requires a source to be provided', () => {
    expect(() => refineFeedbackWithLLM('text', 'feedback', 'email', TEST_SOURCE)).not.toThrow();
  });

  it('routes refinement through the @intx/agent runtime', async () => {
    const result = await refineFeedbackWithLLM(
      'original',
      'make it punchier',
      'linkedin-post',
      TEST_SOURCE
    );

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('Refined output text');
  });

  it('throws when the agent returns an empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '   ' });

    await expect(
      refineFeedbackWithLLM('original', 'feedback', 'email', TEST_SOURCE)
    ).rejects.toThrow('empty response');
  });

  it('throws when the agent returns a genuinely empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '' });

    await expect(
      refineFeedbackWithLLM('original', 'feedback', 'email', TEST_SOURCE)
    ).rejects.toThrow('empty response');
  });

  it('throws when the agent reply field is missing (exercises the optional chain)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed response
    sendMock.mockResolvedValueOnce({} as any);

    await expect(
      refineFeedbackWithLLM('original', 'feedback', 'email', TEST_SOURCE)
    ).rejects.toThrow('empty response');
  });
});
