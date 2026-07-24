import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

// Mock the user-context resolver at the module boundary: the router calls
// getRequestedUserContext(db, userId, requestedTenantId).
let contextImpl: () => {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
} = () => ({
  context: { tenantId: "tn-1", principalId: "prn-1" },
  forbidden: false,
});
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () => contextImpl(),
}));

// Control the admin verdict per test. The archive routes call
// isAdmin(grantStore, principalId, tenantId); default to non-admin so the
// owner path is exercised unless a test opts into admin.
let isAdminImpl: () => boolean = () => false;
mock.module("../lib/admin-grant", () => ({
  isAdmin: () => Promise.resolve(isAdminImpl()),
}));

// The archive routes resolve an agent-owned artifact back to the human member
// who owns the producing agent via resolveOwnerMemberPrincipalId; control the
// verdict per test (default: no owning member, i.e. a human-owned artifact).
let agentOwnerImpl: () => string | null = () => null;
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId: () => Promise.resolve(agentOwnerImpl()),
}));

import { createArtifactsRouter } from "./artifacts";
import { artifact, upload } from "../db/schema";

// The router only forwards this to the mocked isAdmin, so an opaque stand-in is
// enough for the tests.
const fakeGrantStore = {} as unknown as Parameters<
  typeof createArtifactsRouter
>[1];

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;

function makeDb(opts: {
  findMany?: unknown[];
  findFirst?: unknown;
  inserted?: Record<string, unknown>[];
  /** Results returned by successive `db.select(...).from(...).where(...)` calls, in call order. */
  selectResults?: unknown[][];
  /** Captures the `db.update(...).set(values)` payloads, in call order. */
  updated?: Record<string, unknown>[];
}): HubDb {
  const selectResults = [...(opts.selectResults ?? [])];
  const select = mock(() => {
    const chain = {
      from: mock(() => chain),
      where: mock(() => Promise.resolve(selectResults.shift() ?? [])),
    };
    return chain;
  });
  const inserted = opts.inserted ?? [];
  const tx = {
    insert: mock(() => ({
      values: mock((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: mock(() =>
            Promise.resolve([
              {
                id: "art-new",
                parentId: null,
                painPointId: null,
                ownerPrincipalId: values.ownerPrincipalId ?? null,
                sessionId: null,
                version: 1,
                createdAt: new Date("2026-06-26T00:00:00.000Z"),
                updatedAt: new Date("2026-06-26T00:00:00.000Z"),
                ...values,
              },
            ]),
          ),
        };
      }),
    })),
  };
  const updated = opts.updated ?? [];
  const update = mock(() => ({
    set: mock((values: Record<string, unknown>) => {
      updated.push(values);
      return { where: mock(() => Promise.resolve()) };
    }),
  }));
  const db: MockDb = {
    query: {
      artifact: {
        findMany: mock(() => Promise.resolve(opts.findMany ?? [])),
        findFirst: mock(() => Promise.resolve(opts.findFirst ?? undefined)),
      },
    },
    select,
    update,
    transaction: mock((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return db as HubDb;
}

function appWith(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", createArtifactsRouter(db, fakeGrantStore));
  return app;
}

const ROW = {
  id: "art-1",
  tenantId: "tn-1",
  principalId: null,
  ownerPrincipalId: null,
  sessionId: null,
  parentId: null,
  painPointId: null,
  kind: "one-pager",
  title: "My Artifact",
  content: "hello",
  source: null,
  version: 1,
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  updatedAt: new Date("2026-06-20T00:00:00.000Z"),
};

describe("GET /artifacts", () => {
  it("returns serialized tenant artifacts with a null nextCursor under the page limit", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findMany: [ROW] }));

    const res = await app.request("/artifacts?tenantId=tn-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: {
        id: string;
        title: string;
        createdAt: string;
        sessionName: null;
      }[];
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe("art-1");
    expect(body.artifacts[0]?.title).toBe("My Artifact");
    expect(body.artifacts[0]?.createdAt).toBe("2026-06-20T00:00:00.000Z");
    expect(body.artifacts[0]?.sessionName).toBeNull();
  });

  it("normalizes a legacy null source to an unknown origin so a badge can render", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findMany: [{ ...ROW, source: null }] }));
    const res = await app.request("/artifacts");
    const body = (await res.json()) as {
      artifacts: { source: { origin: string } }[];
    };
    expect(body.artifacts[0]?.source.origin).toBe("unknown");
  });

  it("preserves a populated source origin", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({ findMany: [{ ...ROW, source: { origin: "manual" } }] }),
    );
    const res = await app.request("/artifacts");
    const body = (await res.json()) as {
      artifacts: { source: { origin: string } }[];
    };
    expect(body.artifacts[0]?.source.origin).toBe("manual");
  });

  it("emits a nextCursor when results exceed the page limit", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...ROW,
      id: `art-${i}`,
    }));
    const app = appWith(makeDb({ findMany: rows }));

    const res = await app.request("/artifacts");
    const body = (await res.json()) as {
      artifacts: unknown[];
      nextCursor: string | null;
    };
    expect(body.artifacts).toHaveLength(20);
    expect(body.nextCursor).toBe("2026-06-20T00:00:00.000Z__art-19");
  });

  it("403s when the requested tenant is inaccessible", async () => {
    contextImpl = () => ({ context: null, forbidden: true });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?tenantId=other");
    expect(res.status).toBe(403);
  });

  it("400s on an invalid createdAfter filter", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?createdAfter=not-a-date");
    expect(res.status).toBe(400);
  });

  it("400s on an invalid createdBefore filter", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?createdBefore=nope");
    expect(res.status).toBe(400);
  });

  it("narrows the findMany predicate when the date-range facet is set", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const calls: { where: unknown }[] = [];
    const db = makeDb({ findMany: [ROW] });
    const captured = db as unknown as {
      query: {
        artifact: {
          findMany: (opts: { where: unknown }) => Promise<unknown[]>;
        };
      };
    };
    const inner = captured.query.artifact.findMany;
    captured.query.artifact.findMany = (opts: { where: unknown }) => {
      calls.push({ where: opts.where });
      return inner(opts);
    };
    const app = appWith(db);

    // Flatten a drizzle SQL predicate into the set of literal strings and
    // bound param values it carries, so we can assert which facets reached it
    // without rendering a dialect.
    const collect = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (node == null || seen.has(node)) return [];
      if (typeof node === "string") return [node];
      if (typeof node !== "object") return [];
      seen.add(node);
      const out: string[] = [];
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value instanceof Date) out.push(value.toISOString());
        else out.push(...collect(value, seen));
      }
      return out;
    };

    const base = await app.request("/artifacts");
    expect(base.status).toBe(200);
    const baseWhere = collect(calls[0]?.where).join(" ");
    // The unfiltered predicate carries no date facet.
    expect(baseWhere).not.toContain("2026-06-01");

    calls.length = 0;
    const filtered = await app.request(
      "/artifacts?createdAfter=2026-06-01T00:00:00.000Z&createdBefore=2026-06-30T00:00:00.000Z",
    );
    expect(filtered.status).toBe(200);
    const filteredWhere = collect(calls[0]?.where).join(" ");
    // Each date bound is woven into the AND predicate handed to the query layer.
    expect(filteredWhere).toContain("2026-06-01");
    expect(filteredWhere).toContain("2026-06-30");
  });

  it("treats a date-only createdBefore as inclusive end-of-day", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const calls: { where: unknown }[] = [];
    const db = makeDb({ findMany: [ROW] });
    const captured = db as unknown as {
      query: {
        artifact: {
          findMany: (opts: { where: unknown }) => Promise<unknown[]>;
        };
      };
    };
    const inner = captured.query.artifact.findMany;
    captured.query.artifact.findMany = (opts: { where: unknown }) => {
      calls.push({ where: opts.where });
      return inner(opts);
    };
    const app = appWith(db);

    const collect = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (node == null || seen.has(node)) return [];
      if (typeof node === "string") return [node];
      if (typeof node !== "object") return [];
      seen.add(node);
      const out: string[] = [];
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value instanceof Date) out.push(value.toISOString());
        else out.push(...collect(value, seen));
      }
      return out;
    };

    // ROW was created at 2026-06-20T00:00:00Z; a From=To=2026-06-20 range must
    // bound createdBefore at end-of-day, not UTC-midnight, or it drops the row.
    const res = await app.request(
      "/artifacts?createdAfter=2026-06-20&createdBefore=2026-06-20",
    );
    expect(res.status).toBe(200);
    const where = collect(calls[0]?.where).join(" ");
    expect(where).toContain("2026-06-20T23:59:59.999Z");
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(body.artifacts).toHaveLength(1);
  });

  it("filters by kind", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({ findMany: [{ ...ROW, id: "art-onepager", kind: "one-pager" }] }),
    );
    const res = await app.request("/artifacts?kind=one-pager");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { kind: string }[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.kind).toBe("one-pager");
  });

  it("filters by creatorKind, resolving matching owner principal ids first", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const db = makeDb({
      findMany: [{ ...ROW, id: "art-by-agent", ownerPrincipalId: "prn-agent" }],
      selectResults: [[{ id: "prn-agent" }]],
    });
    const captured = db as unknown as {
      query: {
        artifact: {
          findMany: (opts: { where: unknown }) => Promise<unknown[]>;
        };
      };
    };
    const calls: { where: unknown }[] = [];
    const inner = captured.query.artifact.findMany;
    captured.query.artifact.findMany = (opts: { where: unknown }) => {
      calls.push({ where: opts.where });
      return inner(opts);
    };
    const app = appWith(db);

    const res = await app.request("/artifacts?creatorKind=agent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { id: string }[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe("art-by-agent");

    const collect = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (node == null || seen.has(node)) return [];
      if (typeof node === "string") return [node];
      if (typeof node !== "object") return [];
      seen.add(node);
      const out: string[] = [];
      for (const value of Object.values(node as Record<string, unknown>)) {
        out.push(...collect(value, seen));
      }
      return out;
    };
    const where = collect(calls[0]?.where).join(" ");
    expect(where).toContain("prn-agent");
  });

  it("forces an unmatchable predicate when creatorKind matches no principals", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const db = makeDb({ findMany: [ROW], selectResults: [[]] });
    const captured = db as unknown as {
      query: {
        artifact: {
          findMany: (opts: { where: unknown }) => Promise<unknown[]>;
        };
      };
    };
    const calls: { where: unknown }[] = [];
    const inner = captured.query.artifact.findMany;
    captured.query.artifact.findMany = (opts: { where: unknown }) => {
      calls.push({ where: opts.where });
      return inner(opts);
    };
    const app = appWith(db);

    const res = await app.request("/artifacts?creatorKind=agent");
    expect(res.status).toBe(200);

    const collect = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (node == null || seen.has(node)) return [];
      if (typeof node === "string") return [node];
      if (typeof node !== "object") return [];
      seen.add(node);
      const out: string[] = [];
      for (const value of Object.values(node as Record<string, unknown>)) {
        out.push(...collect(value, seen));
      }
      return out;
    };
    // No principal matched `creatorKind=agent`, so the query layer must be
    // handed a predicate that can never match (`false`), not fall through to
    // unfiltered.
    const where = collect(calls[0]?.where).join(" ");
    expect(where).toContain("false");
  });

  it("400s on an invalid creatorKind filter", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?creatorKind=bogus");
    expect(res.status).toBe(400);
  });

  it("combines kind, creatorKind, and date-range filters", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const db = makeDb({
      findMany: [
        {
          ...ROW,
          id: "art-combined",
          kind: "one-pager",
          ownerPrincipalId: "prn-agent",
        },
      ],
      selectResults: [[{ id: "prn-agent" }]],
    });
    const app = appWith(db);
    const res = await app.request(
      "/artifacts?kind=one-pager&creatorKind=agent&createdAfter=2026-06-01&createdBefore=2026-06-30",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { id: string }[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe("art-combined");
  });
});

describe("POST /artifacts", () => {
  function postJson(
    app: Hono<{ Variables: { userId: string } }>,
    body: unknown,
  ) {
    return app.request("/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates a manual artifact from pasted text with a manual origin", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const inserted: Record<string, unknown>[] = [];
    const app = appWith(makeDb({ inserted }));
    const res = await postJson(app, {
      mode: "text",
      title: "Pasted note",
      content: "some body",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact: { source: { origin: string }; kind: string };
    };
    expect(body.artifact.source.origin).toBe("manual");
    expect(body.artifact.kind).toBe("document");
    const artifactInsert = inserted.find((v) => "kind" in v);
    expect(
      (artifactInsert?.source as { origin: string } | undefined)?.origin,
    ).toBe("manual");
  });

  it("writes both the artifact row and its first version row in one transaction", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const inserted: Record<string, unknown>[] = [];
    const app = appWith(makeDb({ inserted }));
    const res = await postJson(app, {
      mode: "text",
      title: "Pasted note",
      content: "some body",
    });
    expect(res.status).toBe(201);
    const artifactInsert = inserted.find((v) => "kind" in v);
    const versionInsert = inserted.find((v) => "authorId" in v);
    expect(artifactInsert?.title).toBe("Pasted note");
    expect(artifactInsert?.principalId).toBe("prn-1");
    expect(versionInsert?.version).toBe(1);
    expect(versionInsert?.authorId).toBe("prn-1");
    expect(versionInsert?.content).toBe("some body");
  });

  it("trims title and content before persisting", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const inserted: Record<string, unknown>[] = [];
    const app = appWith(makeDb({ inserted }));
    const res = await postJson(app, {
      mode: "text",
      title: "  Spaced  ",
      content: "  body  ",
    });
    expect(res.status).toBe(201);
    const artifactInsert = inserted.find((v) => "kind" in v);
    expect(artifactInsert?.title).toBe("Spaced");
    expect(artifactInsert?.content).toBe("body");
  });

  it("400s on a whitespace-only title", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postJson(app, {
      mode: "text",
      title: "   ",
      content: "body",
    });
    expect(res.status).toBe(400);
  });

  it("400s on a file-shaped kind that is not importable", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postJson(app, {
      mode: "url",
      title: "Sneaky",
      content: "https://example.com/x",
      kind: "csv-export",
    });
    expect(res.status).toBe(400);
  });

  it("honors an explicit importable kind", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postJson(app, {
      mode: "text",
      title: "A note",
      content: "body",
      kind: "link",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: { kind: string } };
    expect(body.artifact.kind).toBe("link");
  });

  it("creates an imported artifact from a URL with an imported origin", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const inserted: Record<string, unknown>[] = [];
    const app = appWith(makeDb({ inserted }));
    const res = await postJson(app, {
      mode: "url",
      title: "Docs",
      content: "https://example.com/page",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact: { source: { origin: string; url: string } };
    };
    expect(body.artifact.source.origin).toBe("imported");
    expect(body.artifact.source.url).toBe("https://example.com/page");
  });

  it("400s on a missing title", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postJson(app, { mode: "text", content: "x" });
    expect(res.status).toBe(400);
  });

  it("400s on a malformed URL in url mode", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postJson(app, {
      mode: "url",
      title: "Bad",
      content: "not a url",
    });
    expect(res.status).toBe(400);
  });

  it("403s when there is no accessible workbench", async () => {
    contextImpl = () => ({ context: null, forbidden: false });
    const app = appWith(makeDb({}));
    const res = await postJson(app, {
      mode: "text",
      title: "T",
      content: "C",
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /artifacts/upload", () => {
  function makeFile(name: string, type: string, bytes = 4): File {
    return new File([new Uint8Array(bytes)], name, { type });
  }

  function postFiles(
    app: Hono<{ Variables: { userId: string } }>,
    files: File[],
  ) {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return app.request("/artifacts/upload", { method: "POST", body: form });
  }

  it("stores an uploaded file as an imported artifact", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const inserted: Record<string, unknown>[] = [];
    const app = appWith(makeDb({ inserted }));
    const res = await postFiles(app, [makeFile("notes.txt", "text/plain")]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifacts: { kind: string; source: { origin: string } }[];
    };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.source.origin).toBe("imported");
    expect(body.artifacts[0]?.kind).toBe("file");
    // Each file persists a binary upload row plus an artifact + version row.
    expect(inserted.some((v) => "filename" in v)).toBe(true);
    expect(inserted.some((v) => "mimeType" in v)).toBe(true);
  });

  it("classifies an image upload with the image kind", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postFiles(app, [makeFile("pic.png", "image/png")]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifacts: { kind: string }[] };
    expect(body.artifacts[0]?.kind).toBe("image");
  });

  it("creates one artifact per file for a batch", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postFiles(app, [
      makeFile("a.txt", "text/plain"),
      makeFile("b.csv", "text/csv"),
      makeFile("c.pdf", "application/pdf"),
    ]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(body.artifacts).toHaveLength(3);
  });

  it("400s when no files are supplied", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts/upload", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  });

  it("415s on a disallowed mime/extension", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postFiles(app, [
      makeFile("malware.exe", "application/x-msdownload"),
    ]);
    expect(res.status).toBe(415);
  });

  it("413s when a file exceeds the size limit", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await postFiles(app, [
      makeFile("big.txt", "text/plain", 10 * 1024 * 1024 + 1),
    ]);
    expect(res.status).toBe(413);
  });

  it("403s when there is no accessible workbench", async () => {
    contextImpl = () => ({ context: null, forbidden: false });
    const app = appWith(makeDb({}));
    const res = await postFiles(app, [makeFile("notes.txt", "text/plain")]);
    expect(res.status).toBe(403);
  });
});

describe("GET /artifacts/:id/download", () => {
  it("404s for a missing artifact", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: undefined }));
    const res = await app.request("/artifacts/nope/download");
    expect(res.status).toBe(404);
  });

  it("400s when the kind is not downloadable", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: { ...ROW, kind: "one-pager" } }));
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(400);
  });

  it("serves CSV for a csv-export artifact", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({
        findFirst: {
          ...ROW,
          kind: "csv-export",
          title: "Leads",
          content: "a,b\n1,2\n",
        },
      }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("Leads.csv");
    expect(await res.text()).toBe("a,b\n1,2\n");
  });

  it("403s when the artifact belongs to another tenant", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, tenantId: "tn-other", kind: "csv-export" },
      }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(403);
  });
});

// A stateful db that records inserts and serves them back, so the upload to
// fetch round-trip exercises the real transaction loop and the download stream
// path rather than asserting against a fixture.
function makeUploadDb() {
  const uploads: Record<string, unknown>[] = [];
  const artifacts: Record<string, unknown>[] = [];
  const versions: Record<string, unknown>[] = [];

  function insert(table: unknown) {
    return {
      // Records the row synchronously and returns a thenable that also exposes
      // `.returning()`, so both `await insert().values()` and
      // `await insert().values().returning()` work like drizzle.
      values(vals: Record<string, unknown>) {
        let row: Record<string, unknown>;
        if (table === upload) {
          row = { id: `up-${uploads.length + 1}`, ...vals };
          uploads.push(row);
        } else if (table === artifact) {
          row = {
            id: `art-${artifacts.length + 1}`,
            parentId: null,
            painPointId: null,
            ...vals,
          };
          artifacts.push(row);
        } else {
          row = { id: `ver-${versions.length + 1}`, ...vals };
          versions.push(row);
        }
        const result = Promise.resolve([row]) as Promise<
          Record<string, unknown>[]
        > & { returning: () => Promise<Record<string, unknown>[]> };
        result.returning = () => Promise.resolve([row]);
        return result;
      },
    };
  }

  const db = {
    insert,
    transaction: (fn: (tx: { insert: typeof insert }) => unknown) =>
      Promise.resolve(fn({ insert })),
    query: {
      artifact: {
        findFirst: () => Promise.resolve(artifacts[artifacts.length - 1]),
      },
      upload: {
        findFirst: () => Promise.resolve(uploads[uploads.length - 1]),
      },
    },
  };

  return { db: db as unknown as HubDb, uploads, artifacts, versions };
}

function uploadApp(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", createArtifactsRouter(db, fakeGrantStore));
  return app;
}

function uploadRequest(files: File[]): Request {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return new Request("http://x/artifacts/upload", {
    method: "POST",
    body: form,
  });
}

describe("POST /artifacts/upload", () => {
  it("creates one upload + artifact + version per file with the upload source shape", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const harness = makeUploadDb();
    const app = uploadApp(harness.db);

    const res = await app.request(
      uploadRequest([
        new File(["hello"], "notes.txt", { type: "text/plain" }),
        new File(["<png>"], "logo.png", { type: "image/png" }),
      ]),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifacts: { kind: string; content: string; source: unknown }[];
    };
    expect(harness.uploads).toHaveLength(2);
    expect(harness.artifacts).toHaveLength(2);
    expect(harness.versions).toHaveLength(2);
    expect(body.artifacts[0]?.kind).toBe("file");
    expect(body.artifacts[1]?.kind).toBe("image");
    // content is empty — the upload id is the authoritative download reference.
    expect(body.artifacts[0]?.content).toBe("");
    const source = body.artifacts[1]?.source as {
      upload?: { id: string; mimeType: string };
    };
    expect(source.upload?.id).toBe("up-2");
    expect(source.upload?.mimeType).toBe("image/png");
  });

  it("derives an effective MIME from the extension when the browser omits file.type", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const harness = makeUploadDb();
    const app = uploadApp(harness.db);

    const res = await app.request(
      uploadRequest([new File(["x"], "photo.png", { type: "" })]),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifacts: { kind: string }[] };
    expect(body.artifacts[0]?.kind).toBe("image");
    expect(harness.uploads[0]?.mimeType).toBe("image/png");
  });

  it("round-trips: download streams the stored bytes with the stored content type", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const harness = makeUploadDb();
    const app = uploadApp(harness.db);

    const bytes = new Uint8Array([1, 2, 3, 4, 250, 0, 99]);
    const up = await app.request(
      uploadRequest([new File([bytes], "image.png", { type: "image/png" })]),
    );
    expect(up.status).toBe(201);
    const created = (await up.json()) as { artifacts: { id: string }[] };
    const artifactId = created.artifacts[0]?.id ?? "";

    const down = await app.request(`/artifacts/${artifactId}/download`);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("content-disposition")).toContain("image.png");
    expect(down.headers.get("content-disposition")).toContain("attachment");
    const out = new Uint8Array(await down.arrayBuffer());
    expect([...out]).toEqual([...bytes]);
  });

  it("400s when no file fields are supplied", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = uploadApp(makeUploadDb().db);
    const res = await app.request(uploadRequest([]));
    expect(res.status).toBe(400);
  });

  it("413s when a file exceeds the per-file size limit", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = uploadApp(makeUploadDb().db);
    const oversize = new Uint8Array(10 * 1024 * 1024 + 1);
    const res = await app.request(
      uploadRequest([
        new File([oversize], "big.pdf", { type: "application/pdf" }),
      ]),
    );
    expect(res.status).toBe(413);
  });

  it("413s when the file count exceeds the batch limit", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = uploadApp(makeUploadDb().db);
    const many = Array.from(
      { length: 51 },
      (_, i) => new File(["x"], `f-${i}.txt`, { type: "text/plain" }),
    );
    const res = await app.request(uploadRequest(many));
    expect(res.status).toBe(413);
  });

  it("415s when a file type is not accepted (including SVG)", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = uploadApp(makeUploadDb().db);
    const res = await app.request(
      uploadRequest([
        new File(["<svg></svg>"], "x.svg", { type: "image/svg+xml" }),
      ]),
    );
    expect(res.status).toBe(415);
  });

  it("403s when the caller has no accessible workbench", async () => {
    contextImpl = () => ({ context: null, forbidden: false });
    const app = uploadApp(makeUploadDb().db);
    const res = await app.request(
      uploadRequest([new File(["x"], "a.txt", { type: "text/plain" })]),
    );
    expect(res.status).toBe(403);
  });
});

// Flatten a drizzle SQL predicate into the literal strings (column names,
// operator fragments) it carries, so a test can assert which facets reached the
// query without rendering a dialect.
function flattenWhere(node: unknown, seen = new Set<unknown>()): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (n == null || seen.has(n)) return;
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (typeof n !== "object") return;
    seen.add(n);
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(node);
  return parts.join(" ");
}

describe("GET /artifacts archive filtering (CL-3156)", () => {
  function captureWhere(db: HubDb): { where: unknown }[] {
    const calls: { where: unknown }[] = [];
    const captured = db as unknown as {
      query: {
        artifact: {
          findMany: (opts: { where: unknown }) => Promise<unknown[]>;
        };
      };
    };
    const inner = captured.query.artifact.findMany;
    captured.query.artifact.findMany = (opts: { where: unknown }) => {
      calls.push({ where: opts.where });
      return inner(opts);
    };
    return calls;
  }

  it("hides archived artifacts by default (archived_at IS NULL)", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const db = makeDb({ findMany: [ROW] });
    const calls = captureWhere(db);
    const app = appWith(db);
    const res = await app.request("/artifacts");
    expect(res.status).toBe(200);
    const where = flattenWhere(calls[0]?.where);
    expect(where).toContain("archived_at");
    expect(where).toContain("is null");
    expect(where).not.toContain("is not null");
  });

  it("shows only archived artifacts under ?archived=true (archived_at IS NOT NULL)", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const db = makeDb({ findMany: [ROW] });
    const calls = captureWhere(db);
    const app = appWith(db);
    const res = await app.request("/artifacts?archived=true");
    expect(res.status).toBe(200);
    const where = flattenWhere(calls[0]?.where);
    expect(where).toContain("archived_at");
    expect(where).toContain("is not null");
  });
});

describe("POST /artifacts/:id/archive + /unarchive (CL-3156)", () => {
  // Default: artifact is human-owned (no producing-agent owner) unless a test
  // opts in, so the owner/admin branches are exercised in isolation.
  beforeEach(() => {
    agentOwnerImpl = () => null;
  });

  it("lets a member archive an artifact produced by their own agent", async () => {
    // The artifact is owned by the agent's synthetic principal; the caller is
    // the human member who owns that agent, resolved via member_agent_instance.
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-2" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    agentOwnerImpl = () => "prn-2";
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-agent", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
  });

  it("403s when the producing agent belongs to a different member", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-2" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    agentOwnerImpl = () => "prn-3";
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-agent", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(updated).toHaveLength(0);
  });

  it("lets the owner archive their own artifact, stamping archived_at", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-1", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { archivedAt: string | null };
    };
    expect(body.artifact.archivedAt).not.toBeNull();
    expect(updated).toHaveLength(1);
    expect("archivedAt" in updated[0]!).toBe(true);
    expect(updated[0]!.archivedAt).toBeInstanceOf(Date);
  });

  it("lets a workspace admin archive an artifact they do not own", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-admin" },
      forbidden: false,
    });
    isAdminImpl = () => true;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-owner", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
  });

  it("403s for a non-owner, non-admin member and does not mutate", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-2" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-1", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(updated).toHaveLength(0);
  });

  it("403s cross-tenant even for an admin (tenant guard runs first)", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-admin" },
      forbidden: false,
    });
    isAdminImpl = () => true;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: {
          ...ROW,
          tenantId: "tn-other",
          ownerPrincipalId: "prn-x",
          archivedAt: null,
        },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(updated).toHaveLength(0);
  });

  it("404s when the artifact does not exist", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: undefined }));
    const res = await app.request("/artifacts/nope/archive", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("is idempotent: re-archiving does not overwrite the original archived_at", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    const original = new Date("2026-06-01T00:00:00.000Z");
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-1", archivedAt: original },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/archive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { archivedAt: string | null };
    };
    expect(body.artifact.archivedAt).toBe(original.toISOString());
    expect(updated).toHaveLength(0);
  });

  it("lets the owner unarchive, clearing archived_at", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: {
          ...ROW,
          ownerPrincipalId: "prn-1",
          archivedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/unarchive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { archivedAt: string | null };
    };
    expect(body.artifact.archivedAt).toBeNull();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.archivedAt).toBeNull();
  });

  it("is idempotent: unarchiving a visible artifact is a no-op success", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    isAdminImpl = () => false;
    const updated: Record<string, unknown>[] = [];
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, ownerPrincipalId: "prn-1", archivedAt: null },
        updated,
      }),
    );
    const res = await app.request("/artifacts/art-1/unarchive", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(0);
  });
});
