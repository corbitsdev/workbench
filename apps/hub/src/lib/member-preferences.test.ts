import { describe, expect, it, mock } from 'bun:test';
import type { HubDb } from '../db';
import { readMemberPreferences, mergeMemberPreferences } from './member-preferences';

function makeDb(opts: {
  stored?: unknown;
  onConflictDoUpdate?: ReturnType<typeof mock>;
  values?: ReturnType<typeof mock>;
}): HubDb {
  const onConflictDoUpdate = opts.onConflictDoUpdate ?? mock(() => Promise.resolve());
  const values = opts.values ?? mock(() => ({ onConflictDoUpdate }));
  return {
    query: {
      memberPreferences: {
        findFirst: mock(async () =>
          opts.stored === undefined ? undefined : { preferences: opts.stored }
        ),
      },
    },
    insert: mock(() => ({ values })),
  } as unknown as HubDb;
}

describe('readMemberPreferences', () => {
  it('returns an empty object when no row exists', async () => {
    const db = makeDb({ stored: undefined });
    expect(await readMemberPreferences(db, 'ten-1', 'pri-1')).toEqual({});
  });

  it('returns the parsed stored preferences', async () => {
    const db = makeDb({ stored: { theme: 'notion', compactToolActivity: true } });
    expect(await readMemberPreferences(db, 'ten-1', 'pri-1')).toEqual({
      theme: 'notion',
      compactToolActivity: true,
    });
  });

  it('tolerates a stored blob that fails validation and returns empty', async () => {
    // compactToolActivity must be boolean — a string is invalid.
    const db = makeDb({ stored: { compactToolActivity: 'yes' } });
    expect(await readMemberPreferences(db, 'ten-1', 'pri-1')).toEqual({});
  });
});

describe('mergeMemberPreferences', () => {
  it('merges the patch over existing preferences and upserts the result', async () => {
    const onConflictDoUpdate = mock(() => Promise.resolve());
    const values = mock(() => ({ onConflictDoUpdate }));
    const db = makeDb({ stored: { theme: 'notion', compactToolActivity: false }, values });

    const merged = await mergeMemberPreferences(db, 'ten-1', 'pri-1', {
      compactToolActivity: true,
      toolSummaryStyle: 'mixed',
    });

    expect(merged).toEqual({
      theme: 'notion',
      compactToolActivity: true,
      toolSummaryStyle: 'mixed',
    });
    // The merged blob (not just the patch) is what gets written.
    const insertedRow = (values.mock.calls[0] as unknown[])[0] as { preferences: unknown };
    expect(insertedRow.preferences).toEqual(merged);
    const conflictArg = (onConflictDoUpdate.mock.calls[0] as unknown[])[0] as {
      set: { preferences: unknown };
    };
    expect(conflictArg.set.preferences).toEqual(merged);
  });

  it('writes the patch as-is when there are no existing preferences', async () => {
    const db = makeDb({ stored: undefined });
    const merged = await mergeMemberPreferences(db, 'ten-1', 'pri-1', { theme: 'tkww' });
    expect(merged).toEqual({ theme: 'tkww' });
  });
});
