import { describe, expect, test } from "bun:test";
import type { RequireGrant } from "@intx/hub-api";
import { Hono } from "hono";

import {
  WORKBENCH_TEMPLATE_ARTIFACT_KIND,
  createTemplateLibraryRoutes,
  seedTemplateLibrary,
  type TemplateLibraryEngine,
  type TemplateLibraryStore,
} from "./template-library";

const TENANT = { id: "tenant_a" };
const SCOPE = { tenantId: TENANT.id, principalId: "prin_admin" };

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

type StoredRow = {
  id: string;
  tenantId: string;
  kind: string;
  title: string;
  content: string;
  version: number;
};

/** In-memory stand-in for the artifacts engine, shaped like the five
 * calls `seedTemplateLibrary` makes. */
function memoryEngine(): {
  engine: TemplateLibraryEngine;
  rows: StoredRow[];
} {
  const rows: StoredRow[] = [];
  let nextId = 1;
  const engine = {
    async createArtifact(
      _tx: unknown,
      args: {
        scope: { tenantId: string };
        kind: string;
        title: string;
        content: string;
      },
    ) {
      const row: StoredRow = {
        id: `art_${nextId++}`,
        tenantId: args.scope.tenantId,
        kind: args.kind,
        title: args.title,
        content: args.content,
        version: 1,
      };
      rows.push(row);
      return row;
    },
    async findArtifactByTitle(
      _db: unknown,
      tenantId: string,
      title: string,
      kind?: string,
    ) {
      const row = rows.find(
        (r) => r.tenantId === tenantId && r.title === title && r.kind === kind,
      );
      return row ? { artifactId: row.id, version: row.version } : null;
    },
    async getArtifact(_db: unknown, artifactId: string) {
      return rows.find((r) => r.id === artifactId) ?? null;
    },
    async writeArtifactVersion(
      _db: unknown,
      args: { artifactId: string; content?: string },
    ) {
      const row = rows.find((r) => r.id === args.artifactId);
      if (!row) throw new Error("not found");
      if (args.content !== undefined) row.content = args.content;
      row.version += 1;
      return { artifactId: row.id, version: row.version, title: row.title };
    },
    async listArtifacts(
      _db: unknown,
      _identity: unknown,
      tenantId: string,
      filters: { kind?: string },
    ) {
      return {
        rows: rows.filter(
          (r) => r.tenantId === tenantId && r.kind === filters.kind,
        ),
        nextCursor: null,
      };
    },
  } as unknown as TemplateLibraryEngine;
  return { engine, rows };
}

const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
} as unknown as Parameters<typeof seedTemplateLibrary>[0]["db"];

const ENTRIES = [
  { id: "code-review", content: '{"id":"code-review"}' },
  { id: "gtm", content: '{"id":"gtm"}' },
];

describe("seedTemplateLibrary", () => {
  test("seeds each template once under the workbench-template kind", async () => {
    const { engine, rows } = memoryEngine();
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(["created", "created"]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === WORKBENCH_TEMPLATE_ARTIFACT_KIND)).toBe(
      true,
    );
  });

  test("a second boot leaves exactly one entry per template, untouched", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    const second = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    expect(second.map((o) => o.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  test("a changed shipped manifest revises the existing row, never duplicates it", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [{ id: "code-review", content: '{"id":"code-review","v":2}' }],
      engine,
    });
    expect(outcomes).toEqual([{ id: "code-review", outcome: "revised" }]);
    expect(rows).toHaveLength(2);
    const revised = rows.find((r) => r.title === "code-review");
    expect(revised?.version).toBe(2);
    expect(revised?.content).toBe('{"id":"code-review","v":2}');
  });
});

type TestEnv = {
  Variables: { tenant: { id: string }; principal: { id: string } };
};

function mountRoutes(store: TemplateLibraryStore): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", { id: SCOPE.principalId });
    await next();
  });
  app.route(
    "/library/templates",
    createTemplateLibraryRoutes({ store, requireGrant: allowAll }),
  );
  return app;
}

const fakeStore: TemplateLibraryStore = {
  async list(tenantId) {
    return tenantId === TENANT.id ? ENTRIES : [];
  },
  async get(tenantId, templateId) {
    if (tenantId !== TENANT.id) return null;
    return ENTRIES.find((e) => e.id === templateId) ?? null;
  },
};

describe("template library routes", () => {
  test("lists the seeded entries", async () => {
    const res = await mountRoutes(fakeStore).request("/library/templates");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ENTRIES });
  });

  test("fetches one template by id", async () => {
    const res = await mountRoutes(fakeStore).request(
      "/library/templates/code-review",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ENTRIES[0]);
  });

  test("404s an id the library does not hold", async () => {
    const res = await mountRoutes(fakeStore).request(
      "/library/templates/standup",
    );
    expect(res.status).toBe(404);
  });
});
