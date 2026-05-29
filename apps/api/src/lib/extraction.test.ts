import { describe, expect, it } from 'bun:test';
import { extractPainPointsWithLLM } from './extraction';

describe('extractPainPointsWithLLM', () => {
  it('throws when LLM API key is not configured', async () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;

    try {
      await extractPainPointsWithLLM('wf-1', 'Test transcript', undefined);
      throw new Error('Expected error when API key is missing');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      if (err instanceof Error) {
        expect(err.message).toContain('OPENAI_COMPATIBLE_API_KEY');
      }
    } finally {
      if (originalKey) process.env.OPENAI_COMPATIBLE_API_KEY = originalKey;
    }
  });
});
