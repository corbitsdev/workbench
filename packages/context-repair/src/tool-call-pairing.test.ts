import { describe, expect, it } from 'bun:test';
import type { ConversationTurn } from '@intx/types/runtime';

import { healTurns, repairToolCallPairing } from './context-repair';

function user(text: string): ConversationTurn {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function assistantToolCall(id: string, name = 'search'): ConversationTurn {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', id, name, arguments: { q: 'x' } }],
    timestamp: 2,
  };
}

function toolResult(callId: string): ConversationTurn {
  return {
    role: 'user',
    content: [{ type: 'tool_result', callId, content: [{ type: 'text', text: 'ok' }] }],
    timestamp: 3,
  };
}

describe('repairToolCallPairing', () => {
  it('synthesizes a tool_result for an orphaned tool_call', () => {
    // The reactor persists the assistant tool_call turn durably but holds the
    // matching tool_result in memory until the next commit. A teardown in that
    // window leaves the tool_call with no following tool_result — DeepSeek
    // rejects it with "'tool_calls' must be followed by tool messages".
    const turns: ConversationTurn[] = [user('look it up'), assistantToolCall('tc_1')];

    const result = repairToolCallPairing(turns);

    expect(result.synthesizedResults).toBe(1);
    expect(result.droppedResults).toBe(0);
    // synthesized result is inserted immediately after its assistant turn
    expect(result.turns).toHaveLength(3);
    const synthesized = result.turns[2];
    expect(synthesized?.role).toBe('user');
    const block = synthesized?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type === 'tool_result') {
      expect(block.callId).toBe('tc_1');
      expect(block.isError).toBe(true);
    }
  });

  it('leaves an already-answered tool_call untouched', () => {
    const turns: ConversationTurn[] = [
      user('look it up'),
      assistantToolCall('tc_1'),
      toolResult('tc_1'),
    ];

    const result = repairToolCallPairing(turns);

    expect(result.synthesizedResults).toBe(0);
    expect(result.droppedResults).toBe(0);
    expect(result.turns).toBe(turns);
  });

  it('answers only the missing call when an assistant turn is partially answered', () => {
    const turns: ConversationTurn[] = [
      user('two things'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'tc_1', name: 'a', arguments: {} },
          { type: 'tool_call', id: 'tc_2', name: 'b', arguments: {} },
        ],
        timestamp: 2,
      },
      toolResult('tc_1'),
    ];

    const result = repairToolCallPairing(turns);

    expect(result.synthesizedResults).toBe(1);
    const synthCallIds = result.turns
      .flatMap((t) => t.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? b.callId : ''));
    expect(synthCallIds).toContain('tc_1');
    expect(synthCallIds).toContain('tc_2');
  });

  it('drops a dangling tool_result whose tool_call is gone', () => {
    // Mirror case: a tool_result whose originating assistant tool_call no
    // longer exists (e.g. the assistant turn was stripped). The provider also
    // rejects a tool message with no preceding tool_call.
    const turns: ConversationTurn[] = [user('hi'), toolResult('tc_missing')];

    const result = repairToolCallPairing(turns);

    expect(result.droppedResults).toBe(1);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.role).toBe('user');
    expect(result.turns[0]?.content[0]?.type).toBe('text');
  });

  it('preserves sibling content when dropping a dangling tool_result block', () => {
    const turns: ConversationTurn[] = [
      user('hi'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', callId: 'tc_missing', content: [] },
          { type: 'text', text: 'keep me' },
        ],
        timestamp: 3,
      },
    ];

    const result = repairToolCallPairing(turns);

    expect(result.droppedResults).toBe(1);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[1]?.content).toHaveLength(1);
    expect(result.turns[1]?.content[0]?.type).toBe('text');
  });

  it('drops a dangling result AND synthesizes for an unanswered call in the same turn', () => {
    // A single turn carrying both a dangling tool_result and a live unanswered
    // tool_call must be fully healed — the dangler dropped and the live call
    // answered. The two repairs are independent.
    const turns: ConversationTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_result', callId: 'gone', content: [] },
          { type: 'tool_call', id: 'tc_live', name: 'navigate', arguments: {} },
        ],
        timestamp: 2,
      },
    ];

    const result = repairToolCallPairing(turns);

    expect(result.droppedResults).toBe(1);
    expect(result.synthesizedResults).toBe(1);
    const answered = result.turns
      .flatMap((t) => t.content)
      .some((b) => b.type === 'tool_result' && b.callId === 'tc_live');
    expect(answered).toBe(true);
  });

  it('returns the same array reference when pairing is already well-formed', () => {
    const turns: ConversationTurn[] = [user('hi')];
    expect(repairToolCallPairing(turns).turns).toBe(turns);
  });
});

describe('healTurns', () => {
  it('strips unsendable turns and repairs orphaned tool_calls together', () => {
    const turns: ConversationTurn[] = [
      user('hi'),
      // unsendable reasoning-only turn
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }], timestamp: 2 },
      // orphaned tool_call
      assistantToolCall('tc_1'),
    ];

    const result = healTurns(turns);

    expect(result.changed).toBe(true);
    expect(result.unsendableRemoved).toBe(1);
    expect(result.toolResultsSynthesized).toBe(1);
    // reasoning-only turn gone; tool_call + synthesized result remain
    const roles = result.turns.map((t) => t.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  it('drops a tool_result orphaned by stripping its assistant turn', () => {
    // The assistant turn carrying tc_1 is null-bodied and gets stripped; its
    // result then dangles and must be dropped so no tool message precedes
    // without a tool_call.
    const turns: ConversationTurn[] = [
      user('hi'),
      { role: 'assistant', content: [], timestamp: 2 },
      toolResult('tc_1'),
    ];

    const result = healTurns(turns);

    expect(result.unsendableRemoved).toBe(1);
    expect(result.danglingResultsDropped).toBe(1);
    expect(result.turns).toHaveLength(1);
  });

  it('reports no change for a well-formed transcript', () => {
    const turns: ConversationTurn[] = [
      user('look it up'),
      assistantToolCall('tc_1'),
      toolResult('tc_1'),
    ];

    const result = healTurns(turns);

    expect(result.changed).toBe(false);
    expect(result.turns).toBe(turns);
  });
});
