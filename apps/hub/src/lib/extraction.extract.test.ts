import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { InferenceSource } from '@intx/types/runtime';

const runSingleTurnAgentMock = mock(
  async (
    _source: InferenceSource,
    _systemPrompt: string,
    _userMessage: string,
    _contextPrefix: string,
    _maxOutputTokens?: number
  ): Promise<string> => ''
);

mock.module('./inference', () => ({
  runSingleTurnAgent: runSingleTurnAgentMock,
}));

const { extractPainPointsWithLLM, SINGLE_PASS_TRANSCRIPT_CHARS } = await import('./extraction');

const SOURCE = {
  id: 'src-1',
  provider: 'openai-compatible',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
} as unknown as InferenceSource;

function painPointResponse(extra?: { companyName?: string | null }) {
  return JSON.stringify({
    companyName: extra?.companyName ?? 'Acme Corp',
    painPoints: [
      { severity: 'high', context: 'Slow onboarding', quote: 'Onboarding takes weeks' },
      { severity: 'medium', context: 'Manual reporting', quote: 'We export to spreadsheets' },
    ],
  });
}

beforeEach(() => {
  runSingleTurnAgentMock.mockClear();
});

afterEach(() => {
  runSingleTurnAgentMock.mockReset();
});

describe('extractPainPointsWithLLM', () => {
  it('parses pain points and company name from a clean response', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => painPointResponse());

    const result = await extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE);

    expect(result.companyName).toBe('Acme Corp');
    expect(result.painPoints).toHaveLength(2);
    expect(result.painPoints[0]).toEqual({
      sessionId: 'wf-1',
      severity: 'high',
      context: 'Slow onboarding',
      quote: 'Onboarding takes weeks',
      selected: true,
    });
  });

  it('extracts JSON wrapped in surrounding prose via regex fallback', async () => {
    runSingleTurnAgentMock.mockImplementation(
      async () => `Here is the result:\n${painPointResponse()}\nThanks.`
    );

    const result = await extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE);

    expect(result.painPoints).toHaveLength(2);
  });

  it('returns null company name when LLM provides a blank string', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      painPointResponse({ companyName: '   ' })
    );

    const result = await extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE);

    expect(result.companyName).toBeNull();
  });

  it('returns null company name when LLM omits it', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ companyName: null, painPoints: [] })
    );

    const result = await extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE);

    expect(result.companyName).toBeNull();
    expect(result.painPoints).toEqual([]);
  });

  it('throws when the response contains no JSON', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => 'no json here');

    await expect(
      extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE)
    ).rejects.toThrow(/no JSON/);
  });

  it('throws when extracted JSON is malformed', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => 'prefix {"painPoints": [bad json} suffix');

    await expect(
      extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE)
    ).rejects.toThrow(/malformed JSON/);
  });

  it('throws when painPoints is not an array', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ companyName: 'Acme', painPoints: 'nope' })
    );

    await expect(
      extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE)
    ).rejects.toThrow(/missing painPoints array/);
  });

  it('throws on an unknown severity value', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({
        companyName: 'Acme',
        painPoints: [{ severity: 'catastrophic', context: 'c', quote: 'q' }],
      })
    );

    await expect(
      extractPainPointsWithLLM('wf-1', 'short transcript', undefined, SOURCE)
    ).rejects.toThrow(/unknown severity: catastrophic/);
  });

  it('processes multiple chunks and carries the first company name found', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({
        companyName: 'Discovered Inc',
        painPoints: [{ severity: 'high', context: 'c2', quote: 'q2' }],
      })
    );
    runSingleTurnAgentMock.mockImplementationOnce(async () =>
      JSON.stringify({
        companyName: null,
        painPoints: [{ severity: 'low', context: 'c1', quote: 'q1' }],
      })
    );

    const longTranscript = 'A'.repeat(SINGLE_PASS_TRANSCRIPT_CHARS + 1000);
    const result = await extractPainPointsWithLLM('wf-1', longTranscript, undefined, SOURCE);

    expect(runSingleTurnAgentMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.companyName).toBe('Discovered Inc');
  });

  it('forwards feedback into the user message and applies overhead to chunking', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => painPointResponse());

    await extractPainPointsWithLLM('wf-1', 'transcript', 'focus on pricing', SOURCE, 1024);

    const userMessage = runSingleTurnAgentMock.mock.calls[0]?.[2] as string;
    expect(userMessage).toContain('focus on pricing');
    expect(runSingleTurnAgentMock.mock.calls[0]?.[4]).toBe(1024);
  });
});
