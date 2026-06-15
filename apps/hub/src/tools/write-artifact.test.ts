import { describe, expect, it, mock } from 'bun:test';
import type { StringToolHandler } from '@intx/agent';
import { createWriteArtifactTool } from './write-artifact';

const SIGNAL = new AbortController().signal;

type InsertedVersion = {
  artifactId: string;
  version: number;
  title: string;
  content: string;
  authorId: string;
};

type InsertedArtifact = {
  tenantId: string;
  principalId: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  source: { citations: unknown[]; brief?: Record<string, unknown> };
};

/**
 * Build a mock DB that handles the two select patterns used in write-artifact:
 *   1. artifact lookup: .select({id}).from(artifact).where(...).limit(1) → [{id}] or []
 *   2. max version:     .select({maxVersion}).from(artifactVersion).where(...) → [{maxVersion}]
 *
 * We distinguish them by call order within a transaction: the first select is
 * always the artifact lookup, the second is always the max-version query.
 */
function makeMockDb(
  opts: {
    existingArtifactId?: string;
    prevMaxVersion?: number;
    captureVersionInserts?: InsertedVersion[];
    captureArtifactInserts?: InsertedArtifact[];
  } = {}
) {
  const {
    existingArtifactId,
    prevMaxVersion = 0,
    captureVersionInserts = [],
    captureArtifactInserts = [],
  } = opts;

  let selectCallCount = 0;

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const db: any = {};

  db.transaction = mock(async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
    selectCallCount = 0;
    return fn(db);
  });

  db.select = mock(() => {
    selectCallCount += 1;
    const callNum = selectCallCount;

    return {
      from: mock(() => ({
        where: mock(() => {
          if (callNum % 2 === 1) {
            // Odd calls: artifact lookup — needs .limit()
            return {
              limit: mock(() => {
                if (existingArtifactId) {
                  return Promise.resolve([{ id: existingArtifactId }]);
                }
                return Promise.resolve([]);
              }),
            };
          }
          // Even calls: max version query — returns direct array
          return Promise.resolve([{ maxVersion: prevMaxVersion }]);
        }),
      })),
    };
  });

  db.insert = mock((_table: unknown) => ({
    values: mock((vals: Record<string, unknown>) => {
      if ('version' in vals && 'artifactId' in vals) {
        captureVersionInserts.push(vals as unknown as InsertedVersion);
        return { returning: mock(() => Promise.resolve([])) };
      }
      captureArtifactInserts.push(vals as unknown as InsertedArtifact);
      return {
        returning: mock(() => Promise.resolve([{ id: 'art-new-1' }])),
      };
    }),
  }));

  return db;
}

function getStringHandler(
  context: Parameters<typeof createWriteArtifactTool>[0]
): StringToolHandler {
  const tools = createWriteArtifactTool(context);
  const tool = tools[0];
  if (!tool) throw new Error('No tool created');
  if (tool.kind !== 'string') throw new Error('Expected string tool');
  return tool.handler;
}

describe('write_artifact tool', () => {
  it('tenantId: artifact insert includes tenantId from context', async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-42',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    await handler({ title: 'Report', body: 'Body', kind: 'research', citations: [] }, SIGNAL);

    expect(artifactInserts[0]?.tenantId).toBe('tnt-42');
  });

  it('round-trip: handler returns artifactId and version, matching inserted content', async () => {
    const versionInserts: InsertedVersion[] = [];
    const db = makeMockDb({ captureVersionInserts: versionInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    const resultJson = await handler(
      {
        title: 'My Report',
        body: 'Report body text',
        kind: 'report',
        citations: [{ url: 'https://example.com', source: 'web', retrievedAt: '2026-01-01' }],
      },
      SIGNAL
    );

    const result = JSON.parse(resultJson);
    expect(result.artifactId).toBe('art-new-1');
    expect(result.version).toBe(1);
    expect(result.title).toBe('My Report');
    expect(versionInserts.length).toBe(1);
    expect(versionInserts[0]?.content).toBe('Report body text');
  });

  it('versioning: two calls with same title and kind produce v1 then v2', async () => {
    const versionInserts: InsertedVersion[] = [];

    let transactionCount = 0;

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db: any = {};

    db.transaction = mock(async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      return fn(db);
    });

    let selectCallCount = 0;
    db.select = mock(() => {
      selectCallCount += 1;
      const isArtifactLookup = selectCallCount % 2 === 1;

      return {
        from: mock(() => ({
          where: mock(() => {
            if (isArtifactLookup) {
              return {
                limit: mock(() => {
                  if (transactionCount === 1) {
                    return Promise.resolve([]);
                  }
                  return Promise.resolve([{ id: 'art-new-1' }]);
                }),
              };
            }
            const maxVer = transactionCount === 1 ? 0 : 1;
            return Promise.resolve([{ maxVersion: maxVer }]);
          }),
        })),
      };
    });

    db.insert = mock((_table: unknown) => ({
      values: mock((vals: Record<string, unknown>) => {
        if ('version' in vals && 'artifactId' in vals) {
          versionInserts.push(vals as unknown as InsertedVersion);
          return { returning: mock(() => Promise.resolve([])) };
        }
        return { returning: mock(() => Promise.resolve([{ id: 'art-new-1' }])) };
      }),
    }));

    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    const result1Json = await handler(
      {
        title: 'My Report',
        body: 'Version one body',
        kind: 'report',
        citations: [],
      },
      SIGNAL
    );

    const result2Json = await handler(
      {
        title: 'My Report',
        body: 'Version two body',
        kind: 'report',
        citations: [],
      },
      SIGNAL
    );

    const r1 = JSON.parse(result1Json);
    const r2 = JSON.parse(result2Json);

    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(versionInserts[0]?.content).toBe('Version one body');
    expect(versionInserts[1]?.content).toBe('Version two body');
  });

  it('author: authorId on inserted version equals provided principalId', async () => {
    const versionInserts: InsertedVersion[] = [];
    const db = makeMockDb({ captureVersionInserts: versionInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-author-42',
      sessionId: 'sess-1',
    });

    await handler({ title: 'T', body: 'B', kind: 'report', citations: [] }, SIGNAL);
    expect(versionInserts[0]?.authorId).toBe('prn-author-42');
  });

  it('data: structured brief is persisted under source.brief', async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    const brief = { topic: 'AI', clusters: [], bestTakes: [] };
    await handler(
      { title: 'Brief', body: 'Body', kind: 'research', citations: [], data: brief },
      SIGNAL
    );

    expect(artifactInserts[0]?.source.brief).toEqual(brief);
  });

  it('data: omitted leaves source without a brief key', async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    await handler({ title: 'Plain', body: 'Body', kind: 'report', citations: [] }, SIGNAL);

    expect('brief' in (artifactInserts[0]?.source ?? {})).toBe(false);
  });

  it('missing title: throws before any DB write', async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: 'tnt-1',
      principalId: 'prn-1',
      sessionId: 'sess-1',
    });

    await expect(
      handler({ title: '', body: 'B', kind: 'report', citations: [] }, SIGNAL)
    ).rejects.toThrow('title is required');

    expect(artifactInserts.length).toBe(0);
  });
});
