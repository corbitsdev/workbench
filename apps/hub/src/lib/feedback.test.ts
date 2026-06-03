import { describe, expect, it } from 'bun:test';
import { refineFeedbackWithLLM } from './feedback';

describe('Feedback refinement', () => {
  it('refineFeedbackWithLLM exists and is callable', async () => {
    expect(typeof refineFeedbackWithLLM).toBe('function');
  });
});
