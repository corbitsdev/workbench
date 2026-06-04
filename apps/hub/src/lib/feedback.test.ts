import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const sendMock = mock(async () => ({ reply: 'Refined output text' }));
const closeMock = mock(async () => {});
const createAgentMock = mock(async () => ({ send: sendMock, close: closeMock }));

mock.module('@intx/agent', () => ({
  createAgent: createAgentMock,
}));

import { refineFeedbackWithLLM } from './feedback';

describe('Feedback refinement', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OPENAI_COMPATIBLE_API_KEY;
    sendMock.mockClear();
    closeMock.mockClear();
    createAgentMock.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_API_KEY = originalKey;
    }
  });

  it('refineFeedbackWithLLM exists and is callable', () => {
    expect(typeof refineFeedbackWithLLM).toBe('function');
  });

  it('throws when LLM API key is not configured', async () => {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;

    await expect(refineFeedbackWithLLM('text', 'feedback', 'email')).rejects.toThrow(
      'OPENAI_COMPATIBLE_API_KEY'
    );
  });

  it('routes refinement through the @intx/agent runtime', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';

    const result = await refineFeedbackWithLLM('original', 'make it punchier', 'linkedin');

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('Refined output text');
  });

  it('throws when the agent returns an empty reply', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
    sendMock.mockResolvedValueOnce({ reply: '   ' });

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the agent returns a genuinely empty reply', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
    sendMock.mockResolvedValueOnce({ reply: '' });

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the agent reply field is missing (exercises the optional chain)', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
    // @ts-expect-error deliberately returning a malformed response with no reply field
    sendMock.mockResolvedValueOnce({});

    await expect(refineFeedbackWithLLM('original', 'feedback', 'email')).rejects.toThrow(
      'empty response'
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
