import { describe, expect, it } from 'bun:test';
import { EPHEMERAL_COMPACT_THRESHOLD_TOKENS } from './budget';
import { compactEphemeralChatInput } from './payload';
import { estimateTextTokens } from './tokens';

const SYSTEM = 'You are Myra.';

function bigTurn(role: 'user' | 'assistant', chars: number): { role: 'user' | 'assistant'; content: string } {
  return { role, content: 'x'.repeat(chars) };
}

describe('compactEphemeralChatInput', () => {
  it('returns payload unchanged when under the compact threshold', () => {
    const input = {
      message: 'hello',
      history: [{ role: 'user' as const, content: 'prior' }],
    };
    const out = compactEphemeralChatInput(input, SYSTEM);
    expect(out.payload.message).toBe('hello');
    expect(out.payload.history).toEqual(input.history);
    expect(out.compaction).toBeUndefined();
    expect('compaction' in out.payload).toBe(false);
  });

  it('drops oldest turns and adds a summary when over threshold', () => {
    const history = [
      bigTurn('user', 40_000),
      bigTurn('assistant', 40_000),
      bigTurn('user', 40_000),
      bigTurn('assistant', 40_000),
      bigTurn('user', 40_000),
      bigTurn('assistant', 40_000),
    ];
    const input = { message: 'next', history };
    const estimated = estimateTextTokens(SYSTEM) + estimateTextTokens(JSON.stringify(input));
    expect(estimated).toBeGreaterThanOrEqual(EPHEMERAL_COMPACT_THRESHOLD_TOKENS);

    const out = compactEphemeralChatInput(input, SYSTEM);
    expect(out.compaction).toBeDefined();
    expect(out.compaction!.droppedTurns).toBeGreaterThan(0);
    expect(out.payload.history[0]?.content).toContain('Earlier conversation compacted');
    expect(out.compaction!.estimatedTokensAfter).toBeLessThan(out.compaction!.estimatedTokensBefore);
    expect('compaction' in out.payload).toBe(false);
  });

  it('truncates an oversized lone message when history is empty', () => {
    const message = 'y'.repeat(250_000);
    const out = compactEphemeralChatInput({ message, history: [] }, SYSTEM);
    expect(out.compaction).toBeDefined();
    expect(out.payload.message.length).toBeLessThan(message.length);
    expect('compaction' in out.payload).toBe(false);
  });

  it('throws on invalid input', () => {
    expect(() => compactEphemeralChatInput({ message: 1, history: [] }, SYSTEM)).toThrow(
      /invalid step input/
    );
  });
});