import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const sendMock = mock(async () => ({ reply: 'Refined output text' }));
const closeMock = mock(async () => {});
const createAgentMock = mock(async () => ({ send: sendMock, close: closeMock }));

mock.module('@intx/agent', () => ({
  createAgent: createAgentMock,
}));

// Mock inference module so tests can control whether the source is available
// without relying on env-var side effects after module load.
let inferenceSourceImpl: () => unknown = () => ({
  id: 'test-src',
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
});

mock.module('./inference', () => ({
  buildInferenceSource: (_prefix: string) => inferenceSourceImpl(),
  runSingleTurnAgent: async (
    _source: unknown,
    _systemPrompt: string,
    userMessage: string,
    _contextPrefix: string
  ) => {
    const agent = await createAgentMock({} as any);
    const result = await agent.send(userMessage);
    return result.reply;
  },
}));

import { refineFeedbackWithLLM } from './feedback';

describe('Feedback refinement', () => {
  beforeEach(() => {
    sendMock.mockClear();
    closeMock.mockClear();
    createAgentMock.mockClear();
    inferenceSourceImpl = () => ({
      id: 'test-src',
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
  });

  afterEach(() => {});

  it('refineFeedbackWithLLM exists and is callable', () => {
    expect(typeof refineFeedbackWithLLM).toBe('function');
  });

  it('throws when LLM API key is not configured', async () => {
    inferenceSourceImpl = () => {
      throw new Error('Missing required environment variable: OPENAI_COMPATIBLE_API_KEY');
    };

    await expect(refineFeedbackWithLLM('text', 'feedback', 'email')).rejects.toThrow(
      'OPENAI_COMPATIBLE_API_KEY'
    );
  });

  it('routes refinement through the @intx/agent runtime', async () => {
    const result = await refineFeedbackWithLLM('original', 'make it punchier', 'linkedin');

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('Refined output text');
  });

  it('throws when the agent returns an empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '   ' });

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
  });

  it('throws when the agent returns a genuinely empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '' });

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
  });

  it('throws when the agent reply field is missing (exercises the optional chain)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed response
    sendMock.mockResolvedValueOnce({} as any);

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
  });
});
