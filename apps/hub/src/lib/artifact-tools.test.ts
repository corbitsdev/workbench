import { describe, expect, it, mock } from 'bun:test';
import type { DB } from '@intx/db';
import {
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_HUB_TOOLS,
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
  createArtifactTools,
} from './artifact-tools';

type InsertedRow = Record<string, unknown>;

const BASE_CONTEXT = {
  tenantId: 'tnt_1',
  principalId: 'prn_1',
  agentId: 'agt_1',
  sessionId: 'ses_1',
};

function makeContext(opts: { createdId?: string | null } = {}) {
  const createdId = opts.createdId === undefined ? 'art_123' : opts.createdId;
  const artifactInsertValues: InsertedRow[] = [];
  const versionInsertValues: InsertedRow[] = [];

  const tx = {
    insert: mock(() => {
      return {
        values: mock((values: InsertedRow) => {
          if ('authorId' in values) {
            versionInsertValues.push(values);
            return Promise.resolve();
          }
          artifactInsertValues.push(values);
          return {
            returning: mock(() =>
              Promise.resolve(createdId === null ? [] : [{ id: createdId, ...values }])
            ),
          };
        }),
      };
    }),
  };

  const db = {
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DB['db'];

  return {
    context: { db, ...BASE_CONTEXT },
    artifactInsertValues,
    versionInsertValues,
  };
}

/**
 * Fake db whose `select()` returns the next queued result set on each call and
 * whose `transaction()` exposes the captured update/insert payloads. Chain
 * methods resolve at `.limit()`; the chain records whether `where`/`orderBy`/
 * `for` ran and the `limit` argument so tests can assert the query was actually
 * shaped (a filter built, ordering applied, the clamped limit passed), not just
 * that canned rows came back. `select` is available on both `db` (read/list)
 * and the transaction `tx` (the locked read in artifact_write).
 */
function makeQueryContext(resultSets: unknown[][]) {
  let selectIndex = 0;
  const updateSets: InsertedRow[] = [];
  const versionInsertValues: InsertedRow[] = [];
  const calls = { whereCount: 0, orderByCount: 0, forUpdateCount: 0, limitArg: -1 };

  const makeChain = (rows: unknown[]) => {
    const chain = {
      from: () => chain,
      where: () => {
        calls.whereCount += 1;
        return chain;
      },
      orderBy: () => {
        calls.orderByCount += 1;
        return chain;
      },
      for: () => {
        calls.forUpdateCount += 1;
        return chain;
      },
      limit: (n: number) => {
        calls.limitArg = n;
        return Promise.resolve(rows);
      },
    };
    return chain;
  };

  const select = () => makeChain(resultSets[selectIndex++] ?? []);

  const tx = {
    select: mock(select),
    update: mock(() => ({
      set: mock((values: InsertedRow) => {
        updateSets.push(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
    insert: mock(() => ({
      values: mock((values: InsertedRow) => {
        versionInsertValues.push(values);
        return Promise.resolve();
      }),
    })),
  };

  const db = {
    select: mock(select),
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DB['db'];

  return { context: { db, ...BASE_CONTEXT }, updateSets, versionInsertValues, calls };
}

function handlerFor(context: { db: DB['db'] } & typeof BASE_CONTEXT, name: string) {
  const tool = createArtifactTools(context).find((t) => t.definition.name === name);
  if (!tool?.handler) throw new Error(`expected a handler for ${name}`);
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve((tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args));
}

describe('artifact tool registry', () => {
  it('registers every tool under its own name', () => {
    expect(ARTIFACT_HUB_TOOLS.artifact_link_file.definition).toBe(ARTIFACT_LINK_FILE_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_create.definition).toBe(ARTIFACT_CREATE_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_read.definition).toBe(ARTIFACT_READ_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_write.definition).toBe(ARTIFACT_WRITE_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_list.definition).toBe(ARTIFACT_LIST_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_link_presentation.definition).toBe(
      ARTIFACT_LINK_PRESENTATION_DEFINITION
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_find_by_title.definition).toBe(
      ARTIFACT_FIND_BY_TITLE_DEFINITION
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_create.createTools).toBe(createArtifactTools);
  });

  it('requires title, kind, and path for artifact_link_file', () => {
    expect(ARTIFACT_LINK_FILE_DEFINITION.inputSchema.required).toEqual(['title', 'kind', 'path']);
  });
});

describe('artifact_link_file handler', () => {
  it('creates an artifact and version row, returning the artifact id', async () => {
    const { context, artifactInsertValues, versionInsertValues } = makeContext();
    const handler = handlerFor(context, 'artifact_link_file');

    const raw = await handler({
      title: '  My Doc  ',
      kind: 'document',
      path: 'notes/doc.md',
      preview: ' summary ',
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: 'art_123',
      title: 'My Doc',
      kind: 'document',
      path: 'notes/doc.md',
    });

    const inserted = artifactInsertValues[0];
    expect(inserted?.content).toBe('summary');
    expect(inserted?.status).toBe('draft');
    expect(inserted?.version).toBe(1);
    expect(inserted?.source).toEqual({
      type: 'posix_file',
      path: 'notes/doc.md',
      agentId: 'agt_1',
      sessionId: 'ses_1',
    });
    expect(versionInsertValues[0]?.authorId).toBe('prn_1');
  });

  it('falls back to a linked-file content string when no preview is given', async () => {
    const { context, artifactInsertValues } = makeContext();
    const handler = handlerFor(context, 'artifact_link_file');

    await handler({ title: 'Doc', kind: 'document', path: 'a/b.md' });

    expect(artifactInsertValues[0]?.content).toBe('Linked file: a/b.md');
  });

  it('throws when required fields are missing or the insert returns no row', async () => {
    const missing = makeContext();
    const handler = handlerFor(missing.context, 'artifact_link_file');
    await expect(handler({ kind: 'document', path: 'a.md' })).rejects.toThrow(/title is required/);
    await expect(handler({ title: 'T', path: 'a.md' })).rejects.toThrow(/kind is required/);
    await expect(handler({ title: 'T', kind: 'document' })).rejects.toThrow(/path is required/);

    const noRow = makeContext({ createdId: null });
    const handler2 = handlerFor(noRow.context, 'artifact_link_file');
    await expect(handler2({ title: 'T', kind: 'document', path: 'a.md' })).rejects.toThrow(
      /Failed to create artifact/
    );
  });
});

describe('artifact_create handler', () => {
  it('persists inline content as version 1 and returns the id', async () => {
    const { context, artifactInsertValues, versionInsertValues } = makeContext();
    const handler = handlerFor(context, 'artifact_create');

    const raw = await handler({ title: 'Note', kind: 'note', content: 'Hello world' });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: 'art_123',
      title: 'Note',
      kind: 'note',
      version: 1,
    });
    expect(artifactInsertValues[0]?.content).toBe('Hello world');
    expect(artifactInsertValues[0]?.source).toEqual({
      type: 'inline',
      agentId: 'agt_1',
      sessionId: 'ses_1',
    });
    expect(versionInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.authorId).toBe('prn_1');
  });

  it('requires content', async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, 'artifact_create');
    await expect(handler({ title: 'T', kind: 'note' })).rejects.toThrow(/content is required/);
  });
});

describe('artifact_read handler', () => {
  it('returns the current row when no version is given', async () => {
    const { context } = makeQueryContext([
      [
        {
          id: 'art_1',
          title: 'Current',
          kind: 'note',
          status: 'draft',
          version: 3,
          content: 'latest body',
        },
      ],
    ]);
    const handler = handlerFor(context, 'artifact_read');

    expect(JSON.parse((await handler({ artifactId: 'art_1' })) as string)).toEqual({
      artifactId: 'art_1',
      title: 'Current',
      kind: 'note',
      status: 'draft',
      version: 3,
      content: 'latest body',
    });
  });

  it('returns a specific past version when version is given', async () => {
    const { context } = makeQueryContext([
      [{ id: 'art_1', title: 'Current', kind: 'note', status: 'draft', version: 3 }],
      [{ version: 1, title: 'First', content: 'original body' }],
    ]);
    const handler = handlerFor(context, 'artifact_read');

    expect(JSON.parse((await handler({ artifactId: 'art_1', version: 1 })) as string)).toEqual({
      artifactId: 'art_1',
      title: 'First',
      kind: 'note',
      status: 'draft',
      version: 1,
      content: 'original body',
    });
  });

  it('throws when the artifact or requested version is absent', async () => {
    const missingArtifact = makeQueryContext([[]]);
    await expect(
      handlerFor(missingArtifact.context, 'artifact_read')({ artifactId: 'nope' })
    ).rejects.toThrow(/Artifact not found/);

    const missingVersion = makeQueryContext([
      [{ id: 'art_1', title: 'Current', kind: 'note', status: 'draft', version: 3 }],
      [],
    ]);
    await expect(
      handlerFor(missingVersion.context, 'artifact_read')({ artifactId: 'art_1', version: 9 })
    ).rejects.toThrow(/Version 9 not found/);
  });
});

describe('artifact_write handler', () => {
  it('bumps the version under a locked read, updates the row, and appends an authored version', async () => {
    const { context, updateSets, versionInsertValues, calls } = makeQueryContext([
      [{ id: 'art_1', title: 'Old', kind: 'note', status: 'draft', version: 2, content: 'old' }],
    ]);
    const handler = handlerFor(context, 'artifact_write');

    const raw = await handler({ artifactId: 'art_1', content: 'new body' });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: 'art_1',
      version: 3,
      title: 'Old',
    });
    expect(updateSets[0]?.version).toBe(3);
    expect(updateSets[0]?.content).toBe('new body');
    expect(versionInsertValues[0]?.version).toBe(3);
    expect(versionInsertValues[0]?.content).toBe('new body');
    expect(versionInsertValues[0]?.authorId).toBe('prn_1');
    // The read that drives the version bump must be the locked (FOR UPDATE) read.
    expect(calls.forUpdateCount).toBe(1);
    expect(context.db.transaction).toHaveBeenCalledTimes(1);
  });

  it('keeps the current content when only the title changes', async () => {
    const { context, updateSets } = makeQueryContext([
      [{ id: 'art_1', title: 'Old', kind: 'note', status: 'draft', version: 1, content: 'keep' }],
    ]);
    const handler = handlerFor(context, 'artifact_write');

    await handler({ artifactId: 'art_1', title: 'Renamed' });

    expect(updateSets[0]?.title).toBe('Renamed');
    expect(updateSets[0]?.content).toBe('keep');
  });

  it('throws when no field is provided or the artifact is absent', async () => {
    const present = makeQueryContext([
      [{ id: 'art_1', title: 'Old', kind: 'note', status: 'draft', version: 1, content: 'x' }],
    ]);
    await expect(
      handlerFor(present.context, 'artifact_write')({ artifactId: 'art_1' })
    ).rejects.toThrow(/Provide content and\/or title/);

    const absent = makeQueryContext([[]]);
    await expect(
      handlerFor(absent.context, 'artifact_write')({ artifactId: 'gone', content: 'x' })
    ).rejects.toThrow(/Artifact not found/);
  });

  it('rejects a blank content/title instead of silently wiping the artifact', async () => {
    const blankContent = makeQueryContext([
      [{ id: 'art_1', title: 'Old', kind: 'note', status: 'draft', version: 1, content: 'keep' }],
    ]);
    await expect(
      handlerFor(blankContent.context, 'artifact_write')({ artifactId: 'art_1', content: '   ' })
    ).rejects.toThrow(/content must not be empty/);
    // Nothing was written.
    expect(blankContent.updateSets.length).toBe(0);

    const blankTitle = makeQueryContext([[]]);
    await expect(
      handlerFor(blankTitle.context, 'artifact_write')({ artifactId: 'art_1', title: '' })
    ).rejects.toThrow(/title must not be empty/);
  });
});

describe('artifact_list handler', () => {
  it('returns the summaries and applies a filtered, ordered, default-limited query', async () => {
    const rows = [
      { id: 'art_2', title: 'B', kind: 'note', status: 'draft', version: 1, updatedAt: 't2' },
      { id: 'art_1', title: 'A', kind: 'doc', status: 'approved', version: 4, updatedAt: 't1' },
    ];
    const { context, calls } = makeQueryContext([rows]);
    const handler = handlerFor(context, 'artifact_list');

    expect(JSON.parse((await handler({})) as string)).toEqual({ artifacts: rows });
    // A tenant filter was built, results ordered, and the default limit applied.
    expect(calls.whereCount).toBe(1);
    expect(calls.orderByCount).toBe(1);
    expect(calls.limitArg).toBe(20);
  });

  it('clamps an out-of-range limit and ignores a non-finite one', async () => {
    const high = makeQueryContext([[]]);
    await handlerFor(high.context, 'artifact_list')({ limit: 9999 });
    expect(high.calls.limitArg).toBe(100);

    const notFinite = makeQueryContext([[]]);
    await handlerFor(notFinite.context, 'artifact_list')({ limit: Number.NaN });
    expect(notFinite.calls.limitArg).toBe(20);
  });

  it('accepts a valid status filter and rejects an unknown one', async () => {
    const ok = makeQueryContext([[]]);
    await handlerFor(ok.context, 'artifact_list')({ status: 'approved' });

    const bad = makeQueryContext([[]]);
    await expect(handlerFor(bad.context, 'artifact_list')({ status: 'archived' })).rejects.toThrow(
      /status must be one of/
    );
  });
});

describe('artifact_link_presentation handler', () => {
  it('creates a new presentation artifact when no artifactId is given', async () => {
    const { context, artifactInsertValues, versionInsertValues } = makeContext();
    const handler = handlerFor(context, 'artifact_link_presentation');

    const raw = await handler({ url: 'https://gamma.app/docs/abc', title: 'My Deck' });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: 'art_123',
      version: 1,
      url: 'https://gamma.app/docs/abc',
    });
    expect(artifactInsertValues[0]?.kind).toBe('presentation');
    expect(artifactInsertValues[0]?.content).toBe('https://gamma.app/docs/abc');
    expect(artifactInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.content).toBe('https://gamma.app/docs/abc');
    expect(versionInsertValues[0]?.authorId).toBe('prn_1');
  });

  it('bumps the version when artifactId is given for an existing presentation', async () => {
    const { context, updateSets, versionInsertValues, calls } = makeQueryContext([
      [
        {
          id: 'art_1',
          kind: 'presentation',
          title: 'Old Deck',
          status: 'draft',
          version: 1,
          content: 'https://gamma.app/docs/old',
        },
      ],
    ]);
    const handler = handlerFor(context, 'artifact_link_presentation');

    const raw = await handler({
      url: 'https://gamma.app/docs/new',
      title: 'New Deck',
      artifactId: 'art_1',
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: 'art_1',
      version: 2,
      url: 'https://gamma.app/docs/new',
    });
    expect(updateSets[0]?.version).toBe(2);
    expect(updateSets[0]?.content).toBe('https://gamma.app/docs/new');
    expect(versionInsertValues[0]?.version).toBe(2);
    expect(versionInsertValues[0]?.authorId).toBe('prn_1');
    expect(calls.forUpdateCount).toBe(1);
  });

  it('rejects a version bump if the artifact is not kind=presentation', async () => {
    const { context } = makeQueryContext([
      [
        {
          id: 'art_1',
          kind: 'document',
          title: 'A Doc',
          status: 'draft',
          version: 1,
          content: 'some text',
        },
      ],
    ]);
    const handler = handlerFor(context, 'artifact_link_presentation');

    await expect(
      handler({ url: 'https://gamma.app/docs/abc', title: 'Deck', artifactId: 'art_1' })
    ).rejects.toThrow(/not a presentation artifact/);
  });

  it('rejects a version bump if the artifact is not found', async () => {
    const { context } = makeQueryContext([[]]);
    const handler = handlerFor(context, 'artifact_link_presentation');

    await expect(
      handler({ url: 'https://gamma.app/docs/abc', title: 'Deck', artifactId: 'gone' })
    ).rejects.toThrow(/Artifact not found/);
  });

  it('rejects a non-https url', async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, 'artifact_link_presentation');

    await expect(
      handler({ url: 'http://gamma.app/docs/abc', title: 'Deck' })
    ).rejects.toThrow(/must use HTTPS/);
  });

  it('rejects an invalid url', async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, 'artifact_link_presentation');

    await expect(handler({ url: 'not-a-url', title: 'Deck' })).rejects.toThrow(/valid URL/);
  });

  it('rejects an empty-string artifactId', async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, 'artifact_link_presentation');

    await expect(
      handler({ url: 'https://gamma.app/docs/abc', title: 'Deck', artifactId: '' })
    ).rejects.toThrow(/artifactId must not be empty/);
  });
});

describe('artifact_find_by_title handler', () => {
  it('returns artifactId and version when a match is found', async () => {
    const { context, calls } = makeQueryContext([[{ id: 'art_42', version: 3 }]]);
    const handler = handlerFor(context, 'artifact_find_by_title');

    const raw = await handler({ title: 'My Deck' });

    expect(JSON.parse(raw as string)).toEqual({ artifactId: 'art_42', version: 3 });
    expect(calls.whereCount).toBe(1);
    expect(calls.limitArg).toBe(1);
  });

  it('returns null when no matching artifact is found', async () => {
    const { context } = makeQueryContext([[]]);
    const handler = handlerFor(context, 'artifact_find_by_title');

    const raw = await handler({ title: 'Missing' });

    expect(JSON.parse(raw as string)).toBeNull();
  });

  it('applies orderBy to return the most recently updated match', async () => {
    const { context, calls } = makeQueryContext([[{ id: 'art_99', version: 5 }]]);
    const handler = handlerFor(context, 'artifact_find_by_title');

    await handler({ title: 'My Deck' });

    expect(calls.orderByCount).toBe(1);
  });
});
