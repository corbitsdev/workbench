import { describe, expect, it, mock } from 'bun:test';
import { deleteMyraThread, listMyraThreads, renameMyraThread } from './myra-threads';

describe('listMyraThreads', () => {
  it('maps rows and falls back to default labels by position', async () => {
    const rows = [
      {
        id: 'map-1',
        instanceId: 'inst-1',
        label: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'map-2',
        instanceId: 'inst-2',
        label: '  ',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: 'map-3',
        instanceId: 'inst-3',
        label: 'Pricing deep dive',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      query: { memberAgentInstance: { findMany: mock(() => Promise.resolve(rows)) } },
    };

    const threads = await listMyraThreads(db, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
    });

    expect(threads).toEqual([
      { id: 'map-1', instanceId: 'inst-1', label: 'Chat', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'map-2', instanceId: 'inst-2', label: 'Chat 2', createdAt: '2026-01-02T00:00:00.000Z' },
      {
        id: 'map-3',
        instanceId: 'inst-3',
        label: 'Pricing deep dive',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
  });
});

describe('renameMyraThread', () => {
  it('returns the mapped row when a row is updated', async () => {
    const returning = mock(() =>
      Promise.resolve([
        {
          id: 'map-1',
          instanceId: 'inst-1',
          label: 'New label',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ])
    );
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({ set: () => ({ where: () => ({ returning }) }) })),
    };

    const result = await renameMyraThread(db, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
      threadId: 'map-1',
      label: '  New label  ',
    });

    expect(result).toEqual({
      id: 'map-1',
      instanceId: 'inst-1',
      label: 'New label',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(returning).toHaveBeenCalled();
  });

  it('returns null when no row matched', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      })),
    };

    const result = await renameMyraThread(db, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
      threadId: 'map-x',
      label: 'New label',
    });

    expect(result).toBeNull();
  });

  it('returns null without touching the db when the label is empty', async () => {
    const update = mock(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { update };

    const result = await renameMyraThread(db, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
      threadId: 'map-1',
      label: '   ',
    });

    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('deleteMyraThread', () => {
  function buildDeleteDb(mappingRow: unknown, instanceRow: unknown, deleteSpy: () => void) {
    return {
      query: {
        memberAgentInstance: { findFirst: mock(() => Promise.resolve(mappingRow)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(instanceRow)) },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          delete: () => {
            deleteSpy();
            return { where: () => Promise.resolve(undefined) };
          },
        });
      }),
    };
  }

  it('ends the session, deletes the rows, and returns true', async () => {
    let deletes = 0;
    const db = buildDeleteDb(
      { id: 'map-1', instanceId: 'inst-1' },
      { id: 'inst-1', address: 'inst-1@myra.test' },
      () => {
        deletes += 1;
      }
    );
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
      threadId: 'map-1',
    });

    expect(result).toBe(true);
    expect(endSession).toHaveBeenCalledWith('inst-1@myra.test', 'myra_thread_deleted');
    expect(deletes).toBe(4);
  });

  it('returns false and skips teardown when the mapping is not found', async () => {
    const db = buildDeleteDb(undefined, undefined, () => {});
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: 'tn-global',
      memberPrincipalId: 'prn-member',
      threadId: 'map-x',
    });

    expect(result).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
