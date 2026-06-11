import { describe, expect, it } from 'bun:test';
import { deriveAgentPhase } from './agent-phase';

describe('deriveAgentPhase', () => {
  it('is typing while answer text streams, even if reasoning is attached', () => {
    expect(
      deriveAgentPhase({
        activity: { type: 'inferring' },
        streamingText: 'partial answer',
        reasoningText: 'still reasoning',
      })
    ).toBe('typing');
  });

  it('is thinking while reasoning streams and no answer yet', () => {
    expect(
      deriveAgentPhase({ activity: { type: 'inferring' }, streamingText: '', reasoningText: 'hmm' })
    ).toBe('thinking');
  });

  it('is thinking for a non-null activity with no text (e.g. tool use)', () => {
    expect(
      deriveAgentPhase({
        activity: { type: 'tool_running', name: 'granola_get_note' },
        streamingText: '',
        reasoningText: '',
      })
    ).toBe('thinking');
  });

  it('is idle when nothing is in flight', () => {
    expect(deriveAgentPhase({ activity: null, streamingText: '', reasoningText: '' })).toBe('idle');
  });
});
