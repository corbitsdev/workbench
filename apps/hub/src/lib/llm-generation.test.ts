import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
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

let generateCollateralWithLLM: (typeof import('./generation'))['generateCollateralWithLLM'];

beforeAll(async () => {
  mock.module('./inference', () => ({
    runSingleTurnAgent: runSingleTurnAgentMock,
  }));
  ({ generateCollateralWithLLM } = await import('./generation'));
});

afterAll(() => {
  mock.restore();
});

const SOURCE = {
  id: 'src-1',
  provider: 'openai-compatible',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
} as unknown as InferenceSource;

const POINT = {
  id: 'pp-1',
  context: 'Manual deck creation slows follow-up',
  quote: 'We need the deck by Friday',
  severity: 'high',
};

beforeEach(() => {
  runSingleTurnAgentMock.mockClear();
});

afterEach(() => {
  runSingleTurnAgentMock.mockReset();
});

describe('generateCollateralWithLLM', () => {
  it('parses a clean JSON response into title and body', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ title: 'My Title', body: 'My Body' })
    );

    const result = await generateCollateralWithLLM(
      'wf-1',
      'transcript',
      POINT,
      'linkedin-post',
      SOURCE
    );

    expect(result).toEqual({ title: 'My Title', body: 'My Body' });
    expect(runSingleTurnAgentMock).toHaveBeenCalledTimes(1);
  });

  it('strips markdown code fences before parsing', async () => {
    runSingleTurnAgentMock.mockImplementation(
      async () => '```json\n{"title":"Fenced","body":"Body text"}\n```'
    );

    const result = await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE);

    expect(result.title).toBe('Fenced');
    expect(result.body).toBe('Body text');
  });

  it('truncates very long title and body', async () => {
    const longTitle = 'T'.repeat(600);
    const longBody = 'B'.repeat(11000);
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ title: longTitle, body: longBody })
    );

    const result = await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE);

    expect(result.title.length).toBe(500);
    expect(result.body.length).toBe(10000);
  });

  it('throws when the LLM returns empty content', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => '');

    await expect(
      generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE)
    ).rejects.toThrow(/empty content/);
  });

  it('retries once on invalid JSON and succeeds on the retry', async () => {
    runSingleTurnAgentMock
      .mockImplementationOnce(async () => 'not json at all')
      .mockImplementationOnce(async () => JSON.stringify({ title: 'Retry', body: 'Recovered' }));

    const result = await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE);

    expect(result).toEqual({ title: 'Retry', body: 'Recovered' });
    expect(runSingleTurnAgentMock).toHaveBeenCalledTimes(2);
  });

  it('appends a brevity hint on retry for short-form kinds', async () => {
    runSingleTurnAgentMock
      .mockImplementationOnce(async () => 'broken')
      .mockImplementationOnce(async () => JSON.stringify({ title: 'T', body: 'B' }));

    await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE);

    const retryMessage = runSingleTurnAgentMock.mock.calls[1]?.[2] as string;
    expect(retryMessage).toContain('400 words or fewer');
  });

  it('appends a JSON-only hint on retry for long-form kinds', async () => {
    runSingleTurnAgentMock
      .mockImplementationOnce(async () => 'broken')
      .mockImplementationOnce(async () => JSON.stringify({ title: 'T', body: 'B' }));

    await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'blog', SOURCE);

    const retryMessage = runSingleTurnAgentMock.mock.calls[1]?.[2] as string;
    expect(retryMessage).toContain('not valid JSON');
  });

  it('uses a higher token ceiling for long-form kinds when no override given', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ title: 'T', body: 'B' })
    );

    await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'case-study', SOURCE);

    expect(runSingleTurnAgentMock.mock.calls[0]?.[4]).toBe(16384);
  });

  it('leaves max tokens undefined for short-form kinds when no override given', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ title: 'T', body: 'B' })
    );

    await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE);

    expect(runSingleTurnAgentMock.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('honors an explicit maxOutputTokens override', async () => {
    runSingleTurnAgentMock.mockImplementation(async () =>
      JSON.stringify({ title: 'T', body: 'B' })
    );

    await generateCollateralWithLLM('wf-1', 'transcript', POINT, 'blog', SOURCE, 2048);

    expect(runSingleTurnAgentMock.mock.calls[0]?.[4]).toBe(2048);
  });

  it('throws when retry returns empty content', async () => {
    runSingleTurnAgentMock
      .mockImplementationOnce(async () => 'broken')
      .mockImplementationOnce(async () => '');

    await expect(
      generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE)
    ).rejects.toThrow(/empty content on retry/);
  });

  it('throws when response JSON is missing the body field', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => JSON.stringify({ title: 'Only title' }));

    await expect(
      generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE)
    ).rejects.toThrow(/missing title or body/);
  });

  it('throws when retry also returns invalid JSON', async () => {
    runSingleTurnAgentMock.mockImplementation(async () => 'still broken');

    await expect(
      generateCollateralWithLLM('wf-1', 'transcript', POINT, 'email', SOURCE)
    ).rejects.toThrow(/invalid JSON/);
    expect(runSingleTurnAgentMock).toHaveBeenCalledTimes(2);
  });
});
