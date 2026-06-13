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
