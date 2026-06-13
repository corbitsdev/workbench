import { describe, expect, it, mock } from 'bun:test';
import type { ConversationTurn } from '@intx/types/runtime';

import { healContextStore } from './default-harness';

function makeStore(turns: ConversationTurn[]) {
  const written: ConversationTurn[][] = [];
  const commits: string[] = [];
  return {
    written,
    commits,
    store: {
      load: mock(async () => ({
        turns,
        pendingOperations: [],
        tokenUsage: {},
        connectorState: null,
      })),
      writeTurns: mock(async (next: ConversationTurn[]) => {
        written.push(next);
      }),
      commit: mock(async (opts: { message: string }) => {
        commits.push(opts.message);
        return {};
      }),
    } as never,
  };
}

const poisoned: ConversationTurn = {
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'aborted' }],
  timestamp: 2,
};

describe('healContextStore', () => {
  it('rewrites and commits the durable history when a poisoned turn is present', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      poisoned,
    ];
    const { store, written, commits } = makeStore(turns);

    await healContextStore(store, 'myra@abklabs.com');

    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(1);
    expect(written[0]?.[0]?.role).toBe('user');
    expect(commits).toHaveLength(1);
  });

  it('synthesizes a tool_result for an orphaned tool_call so the provider accepts it', async () => {
    // The reactor strands the assistant tool_call in the durable store when a
    // teardown lands before the tool_result commits; without healing this
    // replays as a DeepSeek 400 on every launch.
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'browse' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'tc_1', name: 'navigate', arguments: {} }],
        timestamp: 2,
      },
    ];
    const { store, written, commits } = makeStore(turns);

    await healContextStore(store, 'bobby@abklabs.com');

    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(3);
    const synthesized = written[0]?.[2];
    expect(synthesized?.role).toBe('user');
    expect(synthesized?.content[0]?.type).toBe('tool_result');
    expect(commits).toHaveLength(1);
  });

  it('does not touch the store when there is nothing to heal', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    ];
    const { store, written, commits } = makeStore(turns);

    await healContextStore(store, 'myra@abklabs.com');

    expect(written).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });
});
