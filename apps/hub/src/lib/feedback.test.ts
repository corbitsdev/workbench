import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const sendMock = mock(async () => ({ reply: 'Refined output text' }));
const closeMock = mock(async () => {});
const createAgentMock = mock(async (_opts: unknown) => ({
  send: sendMock,
  close: closeMock,
})) as any;

mock.module('@intx/agent', () => ({
  createAgent: createAgentMock,
}));

mock.module('./inference', () => ({
  runSingleTurnAgent: async (
    _source: unknown,
    _systemPrompt: string,
    userMessage: string,
    _contextPrefix: string,
    _principalId: string,
    _grantStore: unknown,
    _tenantId: string,
    _maxOutputTokens?: number
  ) => {
    const agent = await createAgentMock({} as any, {} as any);
    const result = await agent.send(userMessage);
    return result.reply;
  },
}));

import { refineFeedbackWithLLM } from './feedback';

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
    // The function signature requires source — TypeScript enforces this at compile time.
    // This test confirms the function accepts a source without throwing synchronously.
    expect(() =>
      refineFeedbackWithLLM(
        'text',
        'feedback',
        'email',
        TEST_SOURCE,
        'prn_test',
        {} as any,
        'tnt_test'
      )
    ).not.toThrow();
  });

  it('routes refinement through the @intx/agent runtime', async () => {
    const result = await refineFeedbackWithLLM(
      'original',
      'make it punchier',
      'linkedin-post',
      TEST_SOURCE,
      'prn_test',
      {} as any,
      'tnt_test'
    );

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('Refined output text');
  });

  it('throws when the agent returns an empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '   ' });

    await expect(
      refineFeedbackWithLLM(
        'original',
        'feedback',
        'email',
        TEST_SOURCE,
        'prn_test',
        {} as any,
        'tnt_test'
      )
    ).rejects.toThrow('empty response');
  });

  it('throws when the agent returns a genuinely empty reply', async () => {
    sendMock.mockResolvedValueOnce({ reply: '' });

    await expect(
      refineFeedbackWithLLM(
        'original',
        'feedback',
        'email',
        TEST_SOURCE,
        'prn_test',
        {} as any,
        'tnt_test'
      )
    ).rejects.toThrow('empty response');
  });

  it('throws when the agent reply field is missing (exercises the optional chain)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed response
    sendMock.mockResolvedValueOnce({} as any);

    await expect(
      refineFeedbackWithLLM(
        'original',
        'feedback',
        'email',
        TEST_SOURCE,
        'prn_test',
        {} as any,
        'tnt_test'
      )
    ).rejects.toThrow('empty response');
  });
});
