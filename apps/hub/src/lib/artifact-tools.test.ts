import { describe, expect, it, mock } from 'bun:test';
import type { DB } from '@intx/db';
import {
  ARTIFACT_HUB_TOOLS,
  ARTIFACT_LINK_FILE_DEFINITION,
  createArtifactTools,
} from './artifact-tools';

type InsertedRow = Record<string, unknown>;

function makeContext(opts: { createdId?: string | null } = {}) {
  const createdId = opts.createdId === undefined ? 'art_123' : opts.createdId;
  const artifactInsertValues: InsertedRow[] = [];
  const versionInsertValues: InsertedRow[] = [];

  const tx = {
    insert: mock(() => {
      return {
        values: mock((values: InsertedRow) => {
          // Version rows carry authorId; artifact rows carry status.
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
    context: {
      db,
      tenantId: 'tnt_1',
      principalId: 'prn_1',
      agentId: 'agt_1',
      sessionId: 'ses_1',
    },
    artifactInsertValues,
    versionInsertValues,
  };
}

type LinkFileArgs = { title?: string; kind?: string; path?: string; preview?: string };

function getHandler(context: ReturnType<typeof makeContext>['context']) {
  const tools = createArtifactTools(context);
  const handler = tools[0]?.handler;
  if (!handler) throw new Error('expected a handler');
  return (args: LinkFileArgs): Promise<unknown> =>
    Promise.resolve(
      (handler as (a: Record<string, unknown>) => Promise<unknown>)(
        args as Record<string, unknown>
      )
    );
}

describe('ARTIFACT_LINK_FILE_DEFINITION', () => {
  it('requires title, kind, and path', () => {
    expect(ARTIFACT_LINK_FILE_DEFINITION.inputSchema.required).toEqual(['title', 'kind', 'path']);
  });

  it('is registered under its tool name in ARTIFACT_HUB_TOOLS', () => {
    expect(ARTIFACT_HUB_TOOLS.artifact_link_file.definition).toBe(ARTIFACT_LINK_FILE_DEFINITION);
    expect(ARTIFACT_HUB_TOOLS.artifact_link_file.createTools).toBe(createArtifactTools);
  });
});

describe('artifact_link_file handler', () => {
  it('creates an artifact and version row, returning the artifact id', async () => {
    const { context, artifactInsertValues, versionInsertValues } = makeContext();
    const handler = getHandler(context);

    const raw = await handler(
      { title: '  My Doc  ', kind: 'document', path: 'notes/doc.md', preview: ' summary ' }
    );

    const result = JSON.parse(raw as string);
    expect(result).toEqual({
      artifactId: 'art_123',
      title: 'My Doc',
      kind: 'document',
      path: 'notes/doc.md',
    });

    const inserted = artifactInsertValues[0];
    expect(inserted?.title).toBe('My Doc');
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
    expect(versionInsertValues[0]?.version).toBe(1);
  });

  it('falls back to a linked-file content string when no preview is given', async () => {
    const { context, artifactInsertValues } = makeContext();
    const handler = getHandler(context);

    await handler({ title: 'Doc', kind: 'document', path: 'a/b.md' });

    expect(artifactInsertValues[0]?.content).toBe('Linked file: a/b.md');
  });

  it('throws when title is missing or blank', async () => {
    const { context } = makeContext();
    const handler = getHandler(context);

    await expect(handler({ kind: 'document', path: 'a.md' })).rejects.toThrow(
      /title is required/
    );
    await expect(
      handler({ title: '   ', kind: 'document', path: 'a.md' })
    ).rejects.toThrow(/title is required/);
  });

  it('throws when kind is missing', async () => {
    const { context } = makeContext();
    const handler = getHandler(context);

    await expect(handler({ title: 'T', path: 'a.md' })).rejects.toThrow(
      /kind is required/
    );
  });

  it('throws when path is missing', async () => {
    const { context } = makeContext();
    const handler = getHandler(context);

    await expect(handler({ title: 'T', kind: 'document' })).rejects.toThrow(
      /path is required/
    );
  });

  it('throws when the artifact insert returns no row', async () => {
    const { context } = makeContext({ createdId: null });
    const handler = getHandler(context);

    await expect(
      handler({ title: 'T', kind: 'document', path: 'a.md' })
    ).rejects.toThrow(/Failed to create artifact/);
  });
});
