import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";
import {
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_HUB_TOOLS,
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  ARTIFACT_READ_CHUNK_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
  createArtifactTools,
} from "./artifact-tools";
import { MAX_UPLOAD_BYTES } from "../db/schema";

type InsertedRow = Record<string, unknown>;

// Flatten a drizzle SQL predicate into the literal strings (including column
// names like "archived_at") it carries, so a test can assert which columns
// reached the query without rendering a dialect.
function flattenStrings(node: unknown, seen = new Set<unknown>()): string[] {
  if (node == null || seen.has(node)) return [];
  if (typeof node === "string") return [node];
  if (typeof node !== "object") return [];
  seen.add(node);
  const out: string[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    out.push(...flattenStrings(value, seen));
  }
  return out;
}

const BASE_CONTEXT = {
  tenantId: "tnt_1",
  principalId: "prn_1",
  agentId: "agt_1",
  sessionId: "ses_1",
};

function makeContext(opts: { createdId?: string | null } = {}) {
  const createdId = opts.createdId === undefined ? "art_123" : opts.createdId;
  const artifactInsertValues: InsertedRow[] = [];
  const versionInsertValues: InsertedRow[] = [];
  const uploadInsertValues: InsertedRow[] = [];

  const tx = {
    insert: mock(() => {
      return {
        values: mock((values: InsertedRow) => {
          if ("authorId" in values) {
            versionInsertValues.push(values);
            return Promise.resolve();
          }
          if ("size" in values) {
            uploadInsertValues.push(values);
            return {
              returning: mock(() =>
                Promise.resolve([{ id: "upl_123", ...values }]),
              ),
            };
          }
          artifactInsertValues.push(values);
          return {
            returning: mock(() =>
              Promise.resolve(
                createdId === null ? [] : [{ id: createdId, ...values }],
              ),
            ),
          };
        }),
      };
    }),
  };

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    for: () => selectChain,
    limit: () => Promise.resolve([] as Record<string, unknown>[]),
  };

  const db = {
    select: mock(() => selectChain),
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DB["db"];

  return {
    context: { db, ...BASE_CONTEXT },
    artifactInsertValues,
    versionInsertValues,
    uploadInsertValues,
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
  const calls = {
    whereCount: 0,
    orderByCount: 0,
    forUpdateCount: 0,
    limitArg: -1,
    whereArgs: [] as unknown[],
  };

  const makeChain = (rows: unknown[]) => {
    const chain = {
      from: () => chain,
      where: (arg: unknown) => {
        calls.whereCount += 1;
        calls.whereArgs.push(arg);
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

  const uploadInsertValues: InsertedRow[] = [];
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
        if ("size" in values) {
          uploadInsertValues.push(values);
          return {
            returning: mock(() =>
              Promise.resolve([{ id: "upl_123", ...values }]),
            ),
          };
        }
        versionInsertValues.push(values);
        return Promise.resolve();
      }),
    })),
  };

  const db = {
    select: mock(select),
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DB["db"];

  return {
    context: { db, ...BASE_CONTEXT },
    updateSets,
    versionInsertValues,
    uploadInsertValues,
    calls,
  };
}

function handlerFor(
  context: { db: DB["db"] } & typeof BASE_CONTEXT,
  name: string,
) {
  const tool = createArtifactTools(context).find(
    (t) => t.definition.name === name,
  );
  if (!tool?.handler) throw new Error(`expected a handler for ${name}`);
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(
      (tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args),
    );
}

describe("artifact tool registry", () => {
  it("registers every tool under its own name", () => {
    expect(ARTIFACT_HUB_TOOLS.artifact_link_file.definition).toBe(
      ARTIFACT_LINK_FILE_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_create.definition).toBe(
      ARTIFACT_CREATE_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_read.definition).toBe(
      ARTIFACT_READ_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_read_chunk.definition).toBe(
      ARTIFACT_READ_CHUNK_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_write.definition).toBe(
      ARTIFACT_WRITE_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_list.definition).toBe(
      ARTIFACT_LIST_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_link_presentation.definition).toBe(
      ARTIFACT_LINK_PRESENTATION_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_link_gamma_presentation.definition).toBe(
      ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_find_by_title.definition).toBe(
      ARTIFACT_FIND_BY_TITLE_DEFINITION,
    );
    expect(ARTIFACT_HUB_TOOLS.artifact_create.createTools).toBe(
      createArtifactTools,
    );
  });

  it("requires title, kind, and path for artifact_link_file", () => {
    expect(ARTIFACT_LINK_FILE_DEFINITION.inputSchema.required).toEqual([
      "title",
      "kind",
      "path",
    ]);
  });

  it("artifact_read schema includes optional tenantId property", () => {
    expect(ARTIFACT_READ_DEFINITION.inputSchema.properties).toHaveProperty(
      "tenantId",
    );
    expect(ARTIFACT_READ_DEFINITION.inputSchema.required).toEqual([
      "artifactId",
    ]);
  });
});

describe("artifact_link_file handler", () => {
  it("creates an artifact and version row, returning the artifact id", async () => {
    const { context, artifactInsertValues, versionInsertValues } =
      makeContext();
    const handler = handlerFor(context, "artifact_link_file");

    const raw = await handler({
      title: "  My Doc  ",
      kind: "document",
      path: "notes/doc.md",
      preview: " summary ",
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      title: "My Doc",
      kind: "document",
      path: "notes/doc.md",
    });

    const inserted = artifactInsertValues[0];
    expect(inserted?.content).toBe("summary");
    expect(inserted?.status).toBe("draft");
    expect(inserted?.version).toBe(1);
    expect(inserted?.source).toEqual({
      origin: "agent",
      type: "posix_file",
      path: "notes/doc.md",
      agentId: "agt_1",
      sessionId: "ses_1",
    });
    expect(versionInsertValues[0]?.authorId).toBe("prn_1");
  });

  it("falls back to a linked-file content string when no preview is given", async () => {
    const { context, artifactInsertValues } = makeContext();
    const handler = handlerFor(context, "artifact_link_file");

    await handler({ title: "Doc", kind: "document", path: "a/b.md" });

    expect(artifactInsertValues[0]?.content).toBe("Linked file: a/b.md");
  });

  it("throws when required fields are missing or the insert returns no row", async () => {
    const missing = makeContext();
    const handler = handlerFor(missing.context, "artifact_link_file");
    await expect(handler({ kind: "document", path: "a.md" })).rejects.toThrow(
      /title is required/,
    );
    await expect(handler({ title: "T", path: "a.md" })).rejects.toThrow(
      /kind is required/,
    );
    await expect(handler({ title: "T", kind: "document" })).rejects.toThrow(
      /path is required/,
    );

    const noRow = makeContext({ createdId: null });
    const handler2 = handlerFor(noRow.context, "artifact_link_file");
    await expect(
      handler2({ title: "T", kind: "document", path: "a.md" }),
    ).rejects.toThrow(/Failed to create artifact/);
  });

  it("returns useful error if session context missing (instead of opaque DB null violation)", async () => {
    const bad = { ...makeContext().context, sessionId: "" };
    const handler = handlerFor(bad as any, "artifact_link_file");
    await expect(handler({ title: "T", kind: "k", path: "p" })).rejects.toThrow(
      /session context is required/,
    );
  });
});

describe("artifact_create handler", () => {
  it("persists inline content as version 1 and returns the id", async () => {
    const { context, artifactInsertValues, versionInsertValues } =
      makeContext();
    const handler = handlerFor(context, "artifact_create");

    const raw = await handler({
      title: "Note",
      kind: "note",
      content: "Hello world",
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      title: "Note",
      kind: "note",
      version: 1,
    });
    expect(artifactInsertValues[0]?.content).toBe("Hello world");
    expect(artifactInsertValues[0]?.source).toEqual({
      origin: "agent",
      type: "inline",
      agentId: "agt_1",
      sessionId: "ses_1",
    });
    expect(versionInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.authorId).toBe("prn_1");
  });

  it("requires content", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_create");
    await expect(handler({ title: "T", kind: "note" })).rejects.toThrow(
      /content is required/,
    );
  });

  it("unwraps a single-level args envelope", async () => {
    const { context, artifactInsertValues } = makeContext();
    const handler = handlerFor(context, "artifact_create");

    const raw = await handler({
      artifact: { title: "Enveloped", kind: "note", content: "body" },
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      title: "Enveloped",
      kind: "note",
      version: 1,
    });
    expect(artifactInsertValues[0]?.content).toBe("body");
  });

  it("reports a missing title with a model-actionable message", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_create");
    await expect(handler({ kind: "note", content: "c" })).rejects.toThrow(
      'title is required — pass a top-level string field "title"',
    );
  });
});

describe("artifact_link_file envelope handling", () => {
  it("unwraps an `input` envelope", async () => {
    const { context, artifactInsertValues } = makeContext();
    const handler = handlerFor(context, "artifact_link_file");

    await handler({
      input: { title: "Doc", kind: "document", path: "a/b.md" },
    });

    expect(artifactInsertValues[0]?.title).toBe("Doc");
    expect(artifactInsertValues[0]?.content).toBe("Linked file: a/b.md");
  });
});

describe("artifact_read handler", () => {
  it("returns the current row when no version is given", async () => {
    const { context } = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Current",
          kind: "note",
          status: "draft",
          version: 3,
          content: "latest body",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_read");

    expect(
      JSON.parse((await handler({ artifactId: "art_1" })) as string),
    ).toEqual({
      artifactId: "art_1",
      title: "Current",
      kind: "note",
      status: "draft",
      version: 3,
      content: "latest body",
    });
  });

  it("returns a specific past version when version is given", async () => {
    const { context } = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Current",
          kind: "note",
          status: "draft",
          version: 3,
        },
      ],
      [{ version: 1, title: "First", content: "original body" }],
    ]);
    const handler = handlerFor(context, "artifact_read");

    expect(
      JSON.parse(
        (await handler({ artifactId: "art_1", version: 1 })) as string,
      ),
    ).toEqual({
      artifactId: "art_1",
      title: "First",
      kind: "note",
      status: "draft",
      version: 1,
      content: "original body",
    });
  });

  it("throws when the artifact or requested version is absent", async () => {
    const missingArtifact = makeQueryContext([[]]);
    await expect(
      handlerFor(
        missingArtifact.context,
        "artifact_read",
      )({ artifactId: "nope" }),
    ).rejects.toThrow(/Artifact not found/);

    const missingVersion = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Current",
          kind: "note",
          status: "draft",
          version: 3,
        },
      ],
      [],
    ]);
    await expect(
      handlerFor(
        missingVersion.context,
        "artifact_read",
      )({ artifactId: "art_1", version: 9 }),
    ).rejects.toThrow(/Version 9 not found/);
  });

  it("reads a cross-tenant artifact when the owning user is a member of the target tenant", async () => {
    const { context } = makeQueryContext([
      [{ id: "inst_1" }], // agentInstance lookup
      [{ memberPrincipalId: "prn_user_1" }], // memberAgentInstance lookup
      [{ refId: "usr_ref_1" }], // owner principal refId
      [{ id: "prn_target_1" }], // principal membership in target tenant
      [
        {
          id: "art_cross",
          title: "Cross-tenant artifact",
          kind: "document",
          status: "draft",
          version: 1,
          content: "body",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_read");

    const result = JSON.parse(
      (await handler({
        artifactId: "art_cross",
        tenantId: "tnt_other",
      })) as string,
    );
    expect(result.artifactId).toBe("art_cross");
    expect(result.content).toBe("body");
  });

  it("rejects a cross-tenant read when the owning user is not a member of the target tenant", async () => {
    const { context } = makeQueryContext([
      [{ id: "inst_1" }], // agentInstance lookup
      [{ memberPrincipalId: "prn_user_1" }],
      [{ refId: "usr_ref_1" }],
      [], // no principal in target tenant → denied
    ]);
    const handler = handlerFor(context, "artifact_read");

    await expect(
      handler({ artifactId: "art_cross", tenantId: "tnt_other" }),
    ).rejects.toThrow(/Artifact not found/);
  });

  it("returns the whole body without chunk metadata when it fits under the default limit", async () => {
    const body = "x".repeat(500);
    const { context } = makeQueryContext([
      [
        {
          id: "art_small",
          title: "Small",
          kind: "note",
          status: "draft",
          version: 1,
          content: body,
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_read");

    const result = JSON.parse(
      (await handler({ artifactId: "art_small" })) as string,
    );
    expect(result).toEqual({
      artifactId: "art_small",
      title: "Small",
      kind: "note",
      status: "draft",
      version: 1,
      content: body,
    });
    expect(result.continuation).toBeUndefined();
    expect(result.contentLength).toBeUndefined();
  });

  it("returns a head chunk pointing at artifact_read_chunk when the body is too large", async () => {
    const body = "y".repeat(20000);
    const { context } = makeQueryContext([
      [
        {
          id: "art_big",
          title: "Big",
          kind: "note",
          status: "draft",
          version: 1,
          content: body,
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_read");

    const result = JSON.parse(
      (await handler({ artifactId: "art_big" })) as string,
    );
    expect(result.contentLength).toBe(20000);
    expect(result.chunkStart).toBe(0);
    expect(result.chunkEnd).toBe(8000);
    expect(result.content).toBe(body.slice(0, 8000));
    expect(result.content.length).toBe(8000);
    expect(result.continuation).toContain("artifact_read_chunk");
    expect(result.continuation).toContain("offset=8000");
  });
});

describe("artifact_read_chunk handler", () => {
  const bigRow = (content: string) => [
    {
      id: "art_big",
      title: "Big",
      kind: "note",
      status: "draft",
      version: 1,
      content,
    },
  ];

  it("reads a later chunk from an explicit offset and marks the final chunk complete", async () => {
    const body = "z".repeat(20000);
    const { context } = makeQueryContext([bigRow(body)]);
    const handler = handlerFor(context, "artifact_read_chunk");

    const result = JSON.parse(
      (await handler({ artifactId: "art_big", offset: 16000 })) as string,
    );
    expect(result.chunkStart).toBe(16000);
    expect(result.chunkEnd).toBe(20000);
    expect(result.content).toBe(body.slice(16000, 20000));
    expect(result.continuation).toBeUndefined();
  });

  it("reassembles the full body across successive chunks", async () => {
    const body = Array.from({ length: 25000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join("");
    const handler = () =>
      handlerFor(
        makeQueryContext([bigRow(body)]).context,
        "artifact_read_chunk",
      );

    let assembled = "";
    let offset = 0;
    let guard = 0;
    let done = false;
    while (!done && guard < 20) {
      guard += 1;
      const result = JSON.parse(
        (await handler()({ artifactId: "art_big", offset })) as string,
      );
      assembled += result.content;
      offset = result.chunkEnd;
      done = result.continuation === undefined;
    }
    expect(assembled).toBe(body);
    expect(offset).toBe(body.length);
  });

  it("honors an explicit limit", async () => {
    const body = "q".repeat(5000);
    const { context } = makeQueryContext([bigRow(body)]);
    const handler = handlerFor(context, "artifact_read_chunk");

    const result = JSON.parse(
      (await handler({ artifactId: "art_big", limit: 100 })) as string,
    );
    expect(result.content).toBe(body.slice(0, 100));
    expect(result.chunkEnd).toBe(100);
    expect(result.continuation).toContain("offset=100");
  });

  it("returns an empty final chunk when offset is at or past the end", async () => {
    const body = "w".repeat(3000);
    const { context } = makeQueryContext([bigRow(body)]);
    const handler = handlerFor(context, "artifact_read_chunk");

    const result = JSON.parse(
      (await handler({ artifactId: "art_big", offset: 9999 })) as string,
    );
    expect(result.content).toBe("");
    expect(result.chunkStart).toBe(3000);
    expect(result.chunkEnd).toBe(3000);
    expect(result.continuation).toBeUndefined();
  });

  it("keeps the JSON-encoded chunk under the tool-output size cap for escape-heavy content", async () => {
    const body = "\n".repeat(20000);
    const { context } = makeQueryContext([bigRow(body)]);
    const handler = handlerFor(context, "artifact_read_chunk");

    const raw = (await handler({ artifactId: "art_big" })) as string;
    expect(raw.length).toBeLessThanOrEqual(10000);
    const result = JSON.parse(raw);
    expect(result.chunkEnd).toBeGreaterThan(0);
    expect(result.content).toBe(body.slice(0, result.chunkEnd));
    expect(result.continuation).toContain(`offset=${result.chunkEnd}`);
  });

  it("rejects a negative offset", async () => {
    const { context } = makeQueryContext([bigRow("body")]);
    const handler = handlerFor(context, "artifact_read_chunk");

    await expect(
      handler({ artifactId: "art_big", offset: -1 }),
    ).rejects.toThrow(/offset must be a non-negative integer/);
  });

  it("rejects web_site artifacts in favor of artifact_read", async () => {
    const siteJson = JSON.stringify({
      files: { "index.html": "<html></html>" },
    });
    const { context } = makeQueryContext([
      [
        {
          id: "art_site",
          title: "Site",
          kind: "web_site",
          status: "draft",
          version: 1,
          content: siteJson,
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_read_chunk");

    await expect(handler({ artifactId: "art_site" })).rejects.toThrow(
      /artifact_read_chunk does not support web_site/,
    );
  });
});

describe("artifact_read_chunk envelope with sibling params", () => {
  const noteRows = () => [
    [
      {
        id: "art_1",
        title: "N",
        kind: "note",
        status: "draft",
        version: 1,
        content: "0123456789",
      },
    ],
  ];

  it("flat args: offset is honored", async () => {
    const { context } = makeQueryContext(noteRows());
    const handler = handlerFor(context, "artifact_read_chunk");
    const raw = await handler({ artifactId: "art_1", offset: 5 });
    expect(JSON.parse(raw as string).content).toBe("56789");
  });

  it("enveloped args: sibling params ride along with artifactId", async () => {
    const { context } = makeQueryContext(noteRows());
    const handler = handlerFor(context, "artifact_read_chunk");
    const raw = await handler({
      input: { artifactId: "art_1", offset: 5 },
    });
    // The unwrap happens at the handler entry, so the enveloped offset is
    // honored — not silently dropped while artifactId alone is unwrapped.
    expect(JSON.parse(raw as string).content).toBe("56789");
  });
});

describe("artifact_write handler", () => {
  it("bumps the version under a locked read, updates the row, and appends an authored version", async () => {
    const { context, updateSets, versionInsertValues, calls } =
      makeQueryContext([
        [
          {
            id: "art_1",
            title: "Old",
            kind: "note",
            status: "draft",
            version: 2,
            content: "old",
          },
        ],
      ]);
    const handler = handlerFor(context, "artifact_write");

    const raw = await handler({ artifactId: "art_1", content: "new body" });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_1",
      version: 3,
      title: "Old",
    });
    expect(updateSets[0]?.version).toBe(3);
    expect(updateSets[0]?.content).toBe("new body");
    expect(versionInsertValues[0]?.version).toBe(3);
    expect(versionInsertValues[0]?.content).toBe("new body");
    expect(versionInsertValues[0]?.authorId).toBe("prn_1");
    // The read that drives the version bump must be the locked (FOR UPDATE) read.
    expect(calls.forUpdateCount).toBe(1);
    expect(context.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to write an archived artifact, presenting it as not-found", async () => {
    const { context, updateSets } = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Old",
          kind: "note",
          status: "draft",
          version: 1,
          content: "hidden",
          archivedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
    ]);
    await expect(
      handlerFor(
        context,
        "artifact_write",
      )({
        artifactId: "art_1",
        content: "sneaky revision",
      }),
    ).rejects.toThrow(/Artifact not found/);
    expect(updateSets).toHaveLength(0);
  });

  it("keeps the current content when only the title changes", async () => {
    const { context, updateSets } = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Old",
          kind: "note",
          status: "draft",
          version: 1,
          content: "keep",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_write");

    await handler({ artifactId: "art_1", title: "Renamed" });

    expect(updateSets[0]?.title).toBe("Renamed");
    expect(updateSets[0]?.content).toBe("keep");
  });

  it("unwraps a single-level args envelope", async () => {
    const { context, updateSets } = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Old",
          kind: "note",
          status: "draft",
          version: 2,
          content: "old",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_write");

    const raw = await handler({
      args: { artifactId: "art_1", content: "new body" },
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_1",
      version: 3,
      title: "Old",
    });
    expect(updateSets[0]?.content).toBe("new body");
  });

  it("reports a missing artifactId with the next step to take", async () => {
    const { context } = makeQueryContext([[]]);
    const handler = handlerFor(context, "artifact_write");
    await expect(handler({ content: "x" })).rejects.toThrow(
      'artifactId is required — pass a top-level string field "artifactId" (the id returned by artifact_create or artifact_list); to make a new artifact use artifact_create',
    );
  });

  it("throws when no field is provided or the artifact is absent", async () => {
    const present = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Old",
          kind: "note",
          status: "draft",
          version: 1,
          content: "x",
        },
      ],
    ]);
    await expect(
      handlerFor(present.context, "artifact_write")({ artifactId: "art_1" }),
    ).rejects.toThrow(/Provide content and\/or title/);

    const absent = makeQueryContext([[]]);
    await expect(
      handlerFor(
        absent.context,
        "artifact_write",
      )({ artifactId: "gone", content: "x" }),
    ).rejects.toThrow(/Artifact not found/);
  });

  it("rejects a blank content/title instead of silently wiping the artifact", async () => {
    const blankContent = makeQueryContext([
      [
        {
          id: "art_1",
          title: "Old",
          kind: "note",
          status: "draft",
          version: 1,
          content: "keep",
        },
      ],
    ]);
    await expect(
      handlerFor(
        blankContent.context,
        "artifact_write",
      )({ artifactId: "art_1", content: "   " }),
    ).rejects.toThrow(/content must not be empty/);
    // Nothing was written.
    expect(blankContent.updateSets.length).toBe(0);

    const blankTitle = makeQueryContext([[]]);
    await expect(
      handlerFor(
        blankTitle.context,
        "artifact_write",
      )({ artifactId: "art_1", title: "" }),
    ).rejects.toThrow(/title must not be empty/);
  });
});

describe("artifact_list handler", () => {
  it("returns the summaries and applies a filtered, ordered, default-limited query", async () => {
    const rows = [
      {
        id: "art_2",
        title: "B",
        kind: "note",
        status: "draft",
        version: 1,
        updatedAt: "t2",
      },
      {
        id: "art_1",
        title: "A",
        kind: "doc",
        status: "approved",
        version: 4,
        updatedAt: "t1",
      },
    ];
    const { context, calls } = makeQueryContext([rows]);
    const handler = handlerFor(context, "artifact_list");

    expect(JSON.parse((await handler({})) as string)).toEqual({
      artifacts: rows,
    });
    // A tenant filter was built, results ordered, and the default limit applied.
    expect(calls.whereCount).toBe(1);
    expect(calls.orderByCount).toBe(1);
    expect(calls.limitArg).toBe(20);
  });

  it("clamps an out-of-range limit and ignores a non-finite one", async () => {
    const high = makeQueryContext([[]]);
    await handlerFor(high.context, "artifact_list")({ limit: 9999 });
    expect(high.calls.limitArg).toBe(100);

    const notFinite = makeQueryContext([[]]);
    await handlerFor(notFinite.context, "artifact_list")({ limit: Number.NaN });
    expect(notFinite.calls.limitArg).toBe(20);
  });

  it("accepts a valid status filter and rejects an unknown one", async () => {
    const ok = makeQueryContext([[]]);
    await handlerFor(ok.context, "artifact_list")({ status: "approved" });

    const bad = makeQueryContext([[]]);
    await expect(
      handlerFor(bad.context, "artifact_list")({ status: "archived" }),
    ).rejects.toThrow(/status must be one of/);
  });

  it("filters out archived artifacts (CL-3156)", async () => {
    const { context, calls } = makeQueryContext([[]]);
    await handlerFor(context, "artifact_list")({});
    expect(flattenStrings(calls.whereArgs[0]).join(" ")).toContain(
      "archived_at",
    );
  });
});

describe("artifact_find_by_title handler", () => {
  it("filters out archived artifacts (CL-3156)", async () => {
    const { context, calls } = makeQueryContext([[]]);
    await handlerFor(context, "artifact_find_by_title")({ title: "X" });
    expect(flattenStrings(calls.whereArgs[0]).join(" ")).toContain(
      "archived_at",
    );
  });

  it("returns null when no matching row exists", async () => {
    const { context } = makeQueryContext([[]]);
    const result = await handlerFor(
      context,
      "artifact_find_by_title",
    )({ title: "missing" });
    expect(JSON.parse(result as string)).toBeNull();
  });
});

describe("artifact_link_presentation handler", () => {
  it("creates a new presentation artifact when no artifactId is given", async () => {
    const { context, artifactInsertValues, versionInsertValues } =
      makeContext();
    const handler = handlerFor(context, "artifact_link_presentation");

    const raw = await handler({
      url: "https://gamma.app/docs/abc",
      title: "My Deck",
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      version: 1,
      url: "https://gamma.app/docs/abc",
    });
    expect(artifactInsertValues[0]?.kind).toBe("presentation");
    expect(artifactInsertValues[0]?.content).toBe("https://gamma.app/docs/abc");
    expect(artifactInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.version).toBe(1);
    expect(versionInsertValues[0]?.content).toBe("https://gamma.app/docs/abc");
    expect(versionInsertValues[0]?.authorId).toBe("prn_1");
  });

  it("bumps the version when artifactId is given for an existing presentation", async () => {
    const { context, updateSets, versionInsertValues, calls } =
      makeQueryContext([
        [
          {
            id: "art_1",
            kind: "presentation",
            title: "Old Deck",
            status: "draft",
            version: 1,
            content: "https://gamma.app/docs/old",
          },
        ],
      ]);
    const handler = handlerFor(context, "artifact_link_presentation");

    const raw = await handler({
      url: "https://gamma.app/docs/new",
      title: "New Deck",
      artifactId: "art_1",
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_1",
      version: 2,
      url: "https://gamma.app/docs/new",
    });
    expect(updateSets[0]?.version).toBe(2);
    expect(updateSets[0]?.content).toBe("https://gamma.app/docs/new");
    expect(versionInsertValues[0]?.version).toBe(2);
    expect(versionInsertValues[0]?.authorId).toBe("prn_1");
    expect(calls.forUpdateCount).toBe(1);
  });

  it("rejects a version bump if the artifact is not kind=presentation", async () => {
    const { context } = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "document",
          title: "A Doc",
          status: "draft",
          version: 1,
          content: "some text",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_link_presentation");

    await expect(
      handler({
        url: "https://gamma.app/docs/abc",
        title: "Deck",
        artifactId: "art_1",
      }),
    ).rejects.toThrow(/not a presentation artifact/);
  });

  it("rejects a version bump if the artifact is not found", async () => {
    const { context } = makeQueryContext([[]]);
    const handler = handlerFor(context, "artifact_link_presentation");

    await expect(
      handler({
        url: "https://gamma.app/docs/abc",
        title: "Deck",
        artifactId: "gone",
      }),
    ).rejects.toThrow(/Artifact not found/);
  });

  it("rejects a non-https url", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_link_presentation");

    await expect(
      handler({ url: "http://gamma.app/docs/abc", title: "Deck" }),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("rejects an invalid url", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_link_presentation");

    await expect(handler({ url: "not-a-url", title: "Deck" })).rejects.toThrow(
      /valid URL/,
    );
  });

  it("rejects an empty-string artifactId", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_link_presentation");

    await expect(
      handler({
        url: "https://gamma.app/docs/abc",
        title: "Deck",
        artifactId: "",
      }),
    ).rejects.toThrow(/artifactId must not be empty/);
  });
});

describe("artifact_link_gamma_presentation handler", () => {
  const goodArgs = {
    url: "https://gamma.app/docs/Building-abc",
    title: "My Deck",
    description: "A deck about building on Interchange",
    gammaId: "abc",
  };

  it("creates a gamma_presentation artifact with structured JSON content", async () => {
    const { context, artifactInsertValues, versionInsertValues } =
      makeContext();
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    const raw = await handler(goodArgs);

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      version: 1,
      url: goodArgs.url,
    });
    expect(artifactInsertValues[0]?.kind).toBe("gamma_presentation");
    expect(JSON.parse(artifactInsertValues[0]?.content as string)).toEqual({
      url: goodArgs.url,
      description: goodArgs.description,
      gammaId: goodArgs.gammaId,
    });
    expect(JSON.parse(versionInsertValues[0]?.content as string)).toEqual({
      url: goodArgs.url,
      description: goodArgs.description,
      gammaId: goodArgs.gammaId,
    });
  });

  it("bumps the version for an existing gamma_presentation", async () => {
    const { context, updateSets, calls } = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "gamma_presentation",
          title: "Old",
          status: "draft",
          version: 1,
          content: "{}",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    const raw = await handler({ ...goodArgs, artifactId: "art_1" });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_1",
      version: 2,
      url: goodArgs.url,
    });
    expect(updateSets[0]?.version).toBe(2);
    expect(JSON.parse(updateSets[0]?.content as string)).toEqual({
      url: goodArgs.url,
      description: goodArgs.description,
      gammaId: goodArgs.gammaId,
    });
    expect(calls.forUpdateCount).toBe(1);
  });

  it("rejects a version bump if the artifact is not kind=gamma_presentation", async () => {
    const { context } = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "presentation",
          title: "Legacy",
          status: "draft",
          version: 1,
          content: "https://gamma.app/docs/old",
        },
      ],
    ]);
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await expect(handler({ ...goodArgs, artifactId: "art_1" })).rejects.toThrow(
      /not a gamma_presentation artifact/,
    );
  });

  it("rejects a non-https url", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await expect(
      handler({ ...goodArgs, url: "http://gamma.app/docs/abc" }),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("requires description and gammaId", async () => {
    const { context } = makeContext();
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await expect(
      handler({ url: goodArgs.url, title: "T", gammaId: "abc" }),
    ).rejects.toThrow(/description is required/);
    await expect(
      handler({ url: goodArgs.url, title: "T", description: "d" }),
    ).rejects.toThrow(/gammaId is required/);
  });

  function pdfFetcher(response: Response): typeof fetch {
    return (async () => response) as unknown as typeof fetch;
  }

  it("downloads the export PDF and stores it as a durable upload referenced by source.upload", async () => {
    const base = makeContext();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const context = {
      ...base.context,
      fetch: pdfFetcher(new Response(pdfBytes, { status: 200 })),
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({ ...goodArgs, pdfUrl: "https://exports.gamma.app/d.pdf" });

    expect(base.uploadInsertValues).toHaveLength(1);
    expect(base.uploadInsertValues[0]?.mimeType).toBe("application/pdf");
    expect(base.uploadInsertValues[0]?.size).toBe(pdfBytes.byteLength);
    expect(base.uploadInsertValues[0]?.filename).toBe("My Deck.pdf");
    expect(base.artifactInsertValues[0]?.source).toMatchObject({
      upload: {
        id: "upl_123",
        filename: "My Deck.pdf",
        mimeType: "application/pdf",
        size: pdfBytes.byteLength,
      },
    });
  });

  it("persists the deck link without a PDF when the export fetch fails", async () => {
    const base = makeContext();
    const context = {
      ...base.context,
      fetch: pdfFetcher(new Response("nope", { status: 500 })),
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    const raw = await handler({
      ...goodArgs,
      pdfUrl: "https://exports.gamma.app/d.pdf",
    });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      version: 1,
      url: goodArgs.url,
    });
    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.artifactInsertValues[0]?.source).not.toHaveProperty("upload");
  });

  it("skips the PDF when it exceeds the upload ceiling", async () => {
    const base = makeContext();
    // A valid PDF header so the byte-length check (not the magic-byte or
    // content-length guard) is what rejects it. No content-length header set.
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    oversized.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
    const context = {
      ...base.context,
      fetch: pdfFetcher(new Response(oversized, { status: 200 })),
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({ ...goodArgs, pdfUrl: "https://exports.gamma.app/d.pdf" });

    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.artifactInsertValues[0]?.source).not.toHaveProperty("upload");
  });

  it("persists the deck link when pdfUrl is an empty string (Gamma returned no export link)", async () => {
    const base = makeContext();
    let fetched = false;
    const context = {
      ...base.context,
      fetch: (async () => {
        fetched = true;
        return new Response(new Uint8Array([1]), { status: 200 });
      }) as unknown as typeof fetch,
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    const raw = await handler({ ...goodArgs, pdfUrl: "" });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_123",
      version: 1,
      url: goodArgs.url,
    });
    expect(fetched).toBe(false);
    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.artifactInsertValues[0]?.source).not.toHaveProperty("upload");
  });

  it("clears a stale PDF on a bump when pdfUrl is empty (export link vanished on re-render)", async () => {
    const base = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "gamma_presentation",
          title: "Old",
          status: "draft",
          version: 1,
          content: "{}",
          source: {
            origin: "agent",
            type: "inline",
            upload: { id: "upl_old", filename: "Old.pdf" },
          },
        },
      ],
    ]);
    const handler = handlerFor(
      base.context,
      "artifact_link_gamma_presentation",
    );

    await handler({ ...goodArgs, artifactId: "art_1", pdfUrl: "" });

    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.updateSets[0]?.source).toEqual({
      origin: "agent",
      type: "inline",
    });
  });

  it("skips the PDF when the fetched body is not a PDF", async () => {
    const base = makeContext();
    const context = {
      ...base.context,
      fetch: (async () =>
        new Response("<html>error</html>", {
          status: 200,
        })) as unknown as typeof fetch,
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({ ...goodArgs, pdfUrl: "https://exports.gamma.app/d.pdf" });

    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.artifactInsertValues[0]?.source).not.toHaveProperty("upload");
  });

  it("skips a non-https pdfUrl without issuing a fetch", async () => {
    const base = makeContext();
    let fetched = false;
    const context = {
      ...base.context,
      fetch: (async () => {
        fetched = true;
        return new Response(new Uint8Array([1]), { status: 200 });
      }) as unknown as typeof fetch,
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({ ...goodArgs, pdfUrl: "http://exports.gamma.app/d.pdf" });

    expect(fetched).toBe(false);
    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.artifactInsertValues[0]?.source).not.toHaveProperty("upload");
  });

  it("skips the PDF when the declared content-length exceeds the ceiling", async () => {
    const base = makeContext();
    const context = {
      ...base.context,
      fetch: (async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) },
        })) as unknown as typeof fetch,
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({ ...goodArgs, pdfUrl: "https://exports.gamma.app/d.pdf" });

    expect(base.uploadInsertValues).toHaveLength(0);
  });

  it("clears a stale PDF reference when a version bump's PDF pull fails", async () => {
    const base = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "gamma_presentation",
          title: "Old",
          status: "draft",
          version: 1,
          content: "{}",
          source: {
            origin: "agent",
            type: "inline",
            upload: { id: "upl_old", filename: "Old.pdf" },
          },
        },
      ],
    ]);
    const context = {
      ...base.context,
      fetch: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({
      ...goodArgs,
      artifactId: "art_1",
      pdfUrl: "https://exports.gamma.app/d.pdf",
    });

    expect(base.uploadInsertValues).toHaveLength(0);
    expect(base.updateSets[0]?.source).toEqual({
      origin: "agent",
      type: "inline",
    });
  });

  it("leaves the existing source untouched on a bump with no pdfUrl", async () => {
    const base = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "gamma_presentation",
          title: "Old",
          status: "draft",
          version: 1,
          content: "{}",
          source: {
            origin: "agent",
            type: "inline",
            upload: { id: "upl_old", filename: "Old.pdf" },
          },
        },
      ],
    ]);
    const handler = handlerFor(
      base.context,
      "artifact_link_gamma_presentation",
    );

    await handler({ ...goodArgs, artifactId: "art_1" });

    // No `source` key written → the prior upload reference is preserved.
    expect(base.updateSets[0]).not.toHaveProperty("source");
  });

  it("attaches the PDF upload to source when bumping an existing version", async () => {
    const base = makeQueryContext([
      [
        {
          id: "art_1",
          kind: "gamma_presentation",
          title: "Old",
          status: "draft",
          version: 1,
          content: "{}",
          source: { origin: "agent", type: "inline" },
        },
      ],
    ]);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const context = {
      ...base.context,
      fetch: pdfFetcher(new Response(pdfBytes, { status: 200 })),
    };
    const handler = handlerFor(context, "artifact_link_gamma_presentation");

    await handler({
      ...goodArgs,
      artifactId: "art_1",
      pdfUrl: "https://exports.gamma.app/d.pdf",
    });

    expect(base.uploadInsertValues).toHaveLength(1);
    expect(base.updateSets[0]?.source).toMatchObject({
      origin: "agent",
      type: "inline",
      upload: { id: "upl_123", mimeType: "application/pdf" },
    });
  });
});

describe("artifact_find_by_title handler", () => {
  it("returns artifactId and version when a match is found", async () => {
    const { context, calls } = makeQueryContext([
      [{ id: "art_42", version: 3 }],
    ]);
    const handler = handlerFor(context, "artifact_find_by_title");

    const raw = await handler({ title: "My Deck" });

    expect(JSON.parse(raw as string)).toEqual({
      artifactId: "art_42",
      version: 3,
    });
    expect(calls.whereCount).toBe(1);
    expect(calls.limitArg).toBe(1);
  });

  it("returns null when no matching artifact is found", async () => {
    const { context } = makeQueryContext([[]]);
    const handler = handlerFor(context, "artifact_find_by_title");

    const raw = await handler({ title: "Missing" });

    expect(JSON.parse(raw as string)).toBeNull();
  });

  it("applies orderBy to return the most recently updated match", async () => {
    const { context, calls } = makeQueryContext([
      [{ id: "art_99", version: 5 }],
    ]);
    const handler = handlerFor(context, "artifact_find_by_title");

    await handler({ title: "My Deck" });

    expect(calls.orderByCount).toBe(1);
  });
});
