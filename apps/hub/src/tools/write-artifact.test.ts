import { describe, expect, it, mock } from "bun:test";
import type { StringToolHandler } from "@intx/agent";
import { createWriteArtifactTool } from "./write-artifact";

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
  source: {
    origin: string;
    citations: unknown[];
    brief?: Record<string, unknown>;
    jobLabel?: string;
  };
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
    captureArtifactUpdates?: Record<string, unknown>[];
  } = {},
) {
  const {
    existingArtifactId,
    prevMaxVersion = 0,
    captureVersionInserts = [],
    captureArtifactInserts = [],
    captureArtifactUpdates = [],
  } = opts;

  let selectCallCount = 0;

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const db: any = {};

  db.transaction = mock(
    async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
      selectCallCount = 0;
      return fn(db);
    },
  );

  db.select = mock(() => {
    selectCallCount += 1;
    const callNum = selectCallCount;

    return {
      from: mock(() => ({
        where: mock(() => {
          if (callNum % 2 === 1) {
            // Odd calls: artifact lookup — needs .limit().for('update')
            const lookupResult = existingArtifactId
              ? Promise.resolve([{ id: existingArtifactId }])
              : Promise.resolve([]);
            return {
              limit: mock(() => ({ for: mock(() => lookupResult) })),
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
      if ("version" in vals && "artifactId" in vals) {
        captureVersionInserts.push(vals as unknown as InsertedVersion);
        return { returning: mock(() => Promise.resolve([])) };
      }
      captureArtifactInserts.push(vals as unknown as InsertedArtifact);
      return {
        returning: mock(() => Promise.resolve([{ id: "art-new-1" }])),
      };
    }),
  }));

  db.update = mock((_table: unknown) => ({
    set: mock((vals: Record<string, unknown>) => ({
      where: mock(() => {
        captureArtifactUpdates.push(vals);
        return Promise.resolve([]);
      }),
    })),
  }));

  return db;
}

function getStringHandler(
  context: Parameters<typeof createWriteArtifactTool>[0],
): StringToolHandler {
  const tools = createWriteArtifactTool(context);
  const tool = tools[0];
  if (!tool) throw new Error("No tool created");
  if (tool.kind !== "string") throw new Error("Expected string tool");
  return tool.handler;
}

describe("write_artifact tool", () => {
  it("tenantId: artifact insert includes tenantId from context", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-42",
      principalId: "prn-1",
    });

    await handler(
      { title: "Report", body: "Body", kind: "research", citations: [] },
      SIGNAL,
    );

    expect(artifactInserts[0]?.tenantId).toBe("tnt-42");
  });

  it("stores a provided jobLabel under source.jobLabel; omits it otherwise", async () => {
    const withLabel: InsertedArtifact[] = [];
    const dbA = makeMockDb({ captureArtifactInserts: withLabel });
    await getStringHandler({ db: dbA, tenantId: "t", principalId: "p" })(
      {
        title: "Anthropic",
        body: "Body",
        kind: "research",
        citations: [],
        jobLabel: "Last 30 days research",
      },
      SIGNAL,
    );
    expect(withLabel[0]?.source.jobLabel).toBe("Last 30 days research");

    const noLabel: InsertedArtifact[] = [];
    const dbB = makeMockDb({ captureArtifactInserts: noLabel });
    await getStringHandler({ db: dbB, tenantId: "t", principalId: "p" })(
      { title: "Anthropic", body: "Body", kind: "research", citations: [] },
      SIGNAL,
    );
    expect(noLabel[0]?.source.jobLabel).toBeUndefined();
    // Provenance is required at the creation path (CL-2432).
    expect(withLabel[0]?.source.origin).toBe("workflow");
    expect(noLabel[0]?.source.origin).toBe("workflow");
  });

  it("round-trip: handler returns artifactId and version, matching inserted content", async () => {
    const versionInserts: InsertedVersion[] = [];
    const db = makeMockDb({ captureVersionInserts: versionInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    const resultJson = await handler(
      {
        title: "My Report",
        body: "Report body text",
        kind: "report",
        citations: [
          {
            url: "https://example.com",
            source: "web",
            retrievedAt: "2026-01-01",
          },
        ],
      },
      SIGNAL,
    );

    const result = JSON.parse(resultJson);
    expect(result.artifactId).toBe("art-new-1");
    expect(result.version).toBe(1);
    expect(result.title).toBe("My Report");
    expect(versionInserts.length).toBe(1);
    expect(versionInserts[0]?.content).toBe("Report body text");
  });

  it("versioning: two calls with same title and kind produce v1 then v2", async () => {
    const versionInserts: InsertedVersion[] = [];

    let transactionCount = 0;

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db: any = {};

    db.transaction = mock(
      async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
        transactionCount += 1;
        return fn(db);
      },
    );

    let selectCallCount = 0;
    db.select = mock(() => {
      selectCallCount += 1;
      const isArtifactLookup = selectCallCount % 2 === 1;

      return {
        from: mock(() => ({
          where: mock(() => {
            if (isArtifactLookup) {
              const lookupResult =
                transactionCount === 1
                  ? Promise.resolve([])
                  : Promise.resolve([{ id: "art-new-1" }]);
              return {
                limit: mock(() => ({ for: mock(() => lookupResult) })),
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
        if ("version" in vals && "artifactId" in vals) {
          versionInserts.push(vals as unknown as InsertedVersion);
          return { returning: mock(() => Promise.resolve([])) };
        }
        return {
          returning: mock(() => Promise.resolve([{ id: "art-new-1" }])),
        };
      }),
    }));

    db.update = mock((_table: unknown) => ({
      set: mock(() => ({ where: mock(() => Promise.resolve([])) })),
    }));

    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    const result1Json = await handler(
      {
        title: "My Report",
        body: "Version one body",
        kind: "report",
        citations: [],
      },
      SIGNAL,
    );

    const result2Json = await handler(
      {
        title: "My Report",
        body: "Version two body",
        kind: "report",
        citations: [],
      },
      SIGNAL,
    );

    const r1 = JSON.parse(result1Json);
    const r2 = JSON.parse(result2Json);

    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(versionInserts[0]?.content).toBe("Version one body");
    expect(versionInserts[1]?.content).toBe("Version two body");
  });

  it("author: authorId on inserted version equals provided principalId", async () => {
    const versionInserts: InsertedVersion[] = [];
    const db = makeMockDb({ captureVersionInserts: versionInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-author-42",
    });

    await handler(
      { title: "T", body: "B", kind: "report", citations: [] },
      SIGNAL,
    );
    expect(versionInserts[0]?.authorId).toBe("prn-author-42");
  });

  it("data: structured brief is persisted under source.brief", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    const brief = { topic: "AI", clusters: [], bestTakes: [] };
    await handler(
      {
        title: "Brief",
        body: "Body",
        kind: "research",
        citations: [],
        data: brief,
      },
      SIGNAL,
    );

    expect(artifactInserts[0]?.source.brief).toEqual(brief);
  });

  it("data: omitted leaves source without a brief key", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    await handler(
      { title: "Plain", body: "Body", kind: "report", citations: [] },
      SIGNAL,
    );

    expect("brief" in (artifactInserts[0]?.source ?? {})).toBe(false);
  });

  it("content: parses last30days brief JSON into source.brief and citations", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    const briefPayload = {
      topic: "GTM agents",
      days: 30,
      stats: { sourceCount: 1, itemCount: 1 },
      clusters: [],
      bestTakes: [],
      items: [],
      citations: [
        {
          url: "https://example.com/a",
          source: "web",
          retrievedAt: "2026-03-23T00:00:00.000Z",
          title: "Example",
        },
      ],
      generatedAt: "2026-03-23T00:00:00.000Z",
    };

    await handler(
      {
        title: "Brief",
        body: "Body",
        kind: "research",
        content: JSON.stringify(briefPayload),
      },
      SIGNAL,
    );

    expect(artifactInserts[0]?.source.brief).toMatchObject({
      topic: "GTM agents",
    });
    expect(artifactInserts[0]?.source.citations).toHaveLength(1);
  });

  it("content: non-JSON brief content is ignored, leaving source without a brief", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    await handler(
      {
        title: "Brief",
        body: "Body",
        kind: "research",
        citations: [
          { url: "https://kept.com", source: "web", retrievedAt: "2026-01-01" },
        ],
        content: "xAI API error: 429 Too Many Requests",
      },
      SIGNAL,
    );

    const source = artifactInserts[0]?.source;
    expect("brief" in (source ?? {})).toBe(false);
    expect(source?.citations).toHaveLength(1);
  });

  it("content: valid JSON that is not a Report is ignored, leaving source without a brief", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    await handler(
      {
        title: "Brief",
        body: "Body",
        kind: "research",
        citations: [],
        content: JSON.stringify({ not: "a report" }),
      },
      SIGNAL,
    );

    expect("brief" in (artifactInserts[0]?.source ?? {})).toBe(false);
  });

  it("update path: refreshes the parent row content, source, and version", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = makeMockDb({
      existingArtifactId: "art-existing",
      prevMaxVersion: 2,
      captureArtifactUpdates: updates,
    });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    const brief = { topic: "AI", clusters: [], bestTakes: [] };
    await handler(
      {
        title: "Brief",
        body: "fresh body",
        kind: "research",
        citations: [],
        data: brief,
      },
      SIGNAL,
    );

    expect(updates).toHaveLength(1);
    const update = updates[0];
    if (!update) throw new Error("expected a parent-row update");
    expect(update.content).toBe("fresh body");
    expect(update.version).toBe(3);
    expect((update.source as { brief?: unknown }).brief).toEqual(brief);
  });

  it("create path: does not issue a parent-row update", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = makeMockDb({ captureArtifactUpdates: updates });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    await handler(
      { title: "New", body: "b", kind: "research", citations: [] },
      SIGNAL,
    );
    expect(updates).toHaveLength(0);
  });

  it("missing title: throws before any DB write", async () => {
    const artifactInserts: InsertedArtifact[] = [];
    const db = makeMockDb({ captureArtifactInserts: artifactInserts });
    const handler = getStringHandler({
      db,
      tenantId: "tnt-1",
      principalId: "prn-1",
    });

    await expect(
      handler({ title: "", body: "B", kind: "report", citations: [] }, SIGNAL),
    ).rejects.toThrow("title is required");

    expect(artifactInserts.length).toBe(0);
  });
});
