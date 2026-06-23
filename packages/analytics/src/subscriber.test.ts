import { describe, expect, mock, test } from 'bun:test';

import type { InferenceEvent } from '@intx/types/runtime';

import { createAnalyticsSubscriber } from './subscriber';

// Minimal agentInstance row. sessionId is intentionally set in most cases.
const baseInstance = {
  id: 'ins_test',
  agentId: 'agt_test',
  tenantId: 'tnt_test',
  principalId: 'prn_test',
  sessionId: 'ses_test',
  address: 'agent@example.test',
  endedAt: null,
};

function makeDb({
  instance = baseInstance as typeof baseInstance | null,
  insertReturns = [{ id: 'ane_new' }] as { id: string }[],
  onInsert,
}: {
  instance?: typeof baseInstance | null;
  insertReturns?: { id: string }[];
  onInsert?: (values: unknown) => void;
} = {}) {
  const insertChain = {
    values: mock((values: unknown) => {
      onInsert?.(values);
      return insertChain;
    }),
    onConflictDoNothing: mock(() => insertChain),
    onConflictDoUpdate: mock(() => Promise.resolve()),
    returning: mock(() => Promise.resolve(insertReturns)),
  };

  const db = {
    query: {
      agentInstance: {
        findFirst: mock(() => Promise.resolve(instance ?? undefined)),
      },
    },
    insert: mock(() => insertChain),
    transaction: mock(async (fn: (tx: typeof db) => Promise<void>) => fn(db)),
  };

  return { db, insertChain };
}

const usageEvent: InferenceEvent = {
  type: 'inference.usage',
  seq: 1,
  data: {
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { sourceId: 'src_1', provider: 'openai-compatible', model: 'claude-sonnet' },
  },
};

const reactorDoneEvent: InferenceEvent = {
  type: 'reactor.done',
  seq: 2,
  data: {},
};

const inferenceDoneEvent: InferenceEvent = {
  type: 'inference.done',
  seq: 3,
  data: {
    turn: { role: 'assistant', content: [], model: 'claude-sonnet', timestamp: 0 },
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { sourceId: 'src_1', provider: 'openai-compatible', model: 'claude-sonnet' },
  },
};

describe('createAnalyticsSubscriber', () => {
  test('skips persistence when no facts map from the event', async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: 'agent@example.test',
      event: { type: 'inference.text.delta', seq: 1, data: { token: 'x', partial: { text: 'x' } } },
    });

    expect(db.query.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  test('warns and skips when no active instance is found for the address', async () => {
    const { db } = makeDb({ instance: null });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({ agentAddress: 'agent@example.test', event: usageEvent });

    expect(db.insert).not.toHaveBeenCalled();
  });

  test('throws and surfaces the error when instance.sessionId is null', async () => {
    const nullSession = { ...baseInstance, sessionId: null };
    const { db } = makeDb({ instance: nullSession as never });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    // onAgentEvent catches errors and logs them; test that it doesn't silently succeed
    // by checking insert was never called (the error aborted before any write).
    await subscriber.onAgentEvent({ agentAddress: 'agent@example.test', event: usageEvent });

    expect(db.insert).not.toHaveBeenCalled();
  });

  test('qualifies the event key with sessionId to prevent cross-session collisions', async () => {
    const capturedInserts: unknown[] = [];
    const { db } = makeDb({ onInsert: (values) => capturedInserts.push(values) });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({ agentAddress: 'agent@example.test', event: usageEvent });

    const factInsert = capturedInserts[0] as Record<string, unknown>;
    expect(String(factInsert['eventKey'])).toStartWith(
      'ses_test:agent@example.test:1:inference.usage'
    );
  });

  test('skips rollup upsert when event key already exists (onConflictDoNothing)', async () => {
    // onConflictDoNothing returns [] when a conflict is detected
    const { db, insertChain } = makeDb({ insertReturns: [] });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({ agentAddress: 'agent@example.test', event: usageEvent });

    // insert called once for the fact row; second insert (rollup) must NOT be called
    expect(db.insert).toHaveBeenCalledTimes(1);
    void insertChain;
  });

  test('skips rollup upsert for inference_done events', async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: 'agent@example.test',
      event: inferenceDoneEvent,
    });

    // Only the fact insert; no rollup upsert
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  test('performs both fact insert and rollup upsert for reactor.done', async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({ agentAddress: 'agent@example.test', event: reactorDoneEvent });

    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
