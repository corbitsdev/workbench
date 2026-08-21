import { describe, expect, test } from "bun:test";
import type { RequireGrant } from "@intx/hub-api";
import { Hono } from "hono";

import {
  WORKBENCH_TEMPLATE_ARTIFACT_KIND,
  createTemplateLibraryDbStore,
  createTemplateLibraryRoutes,
  createTemplateLibrarySeeder,
  createUnavailableTemplateLibraryRoutes,
  seedTemplateLibrary,
  type TemplateLibraryEngine,
  type TemplateLibrarySeeder,
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
  archivedAt: Date | null;
  source: Record<string, unknown> | null;
};

/** In-memory stand-in for the artifacts engine, shaped like the calls
 * `seedTemplateLibrary` makes. */
function memoryEngine(): {
  engine: TemplateLibraryEngine;
  rows: StoredRow[];
  userEdit: (title: string, content: string) => void;
  userArchive: (title: string) => void;
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
        source: Record<string, unknown>;
      },
    ) {
      const row: StoredRow = {
        id: `art_${nextId++}`,
        tenantId: args.scope.tenantId,
        kind: args.kind,
        title: args.title,
        content: args.content,
        version: 1,
        archivedAt: null,
        source: args.source,
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
        (r) =>
          r.tenantId === tenantId &&
          r.title === title &&
          r.kind === kind &&
          r.archivedAt === null,
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
      if (!row || row.archivedAt !== null) throw new Error("not found");
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
          (r) =>
            r.tenantId === tenantId &&
            r.kind === filters.kind &&
            r.archivedAt === null,
        ),
        nextCursor: null,
      };
    },
    async listSeedRows(_db: unknown, tenantId: string, kind: string) {
      return rows.filter(
        (r) =>
          r.tenantId === tenantId &&
          r.kind === kind &&
          r.source?.origin === "template-library-seed",
      );
    },
    async updateArtifactSource(
      _db: unknown,
      artifactId: string,
      source: Record<string, unknown>,
    ) {
      const row = rows.find((r) => r.id === artifactId);
      if (!row) throw new Error("not found");
      row.source = source;
    },
    async setArtifactArchivedById(
      _db: unknown,
      artifactId: string,
      archived: boolean,
    ) {
      const row = rows.find((r) => r.id === artifactId);
      if (!row) throw new Error("not found");
      row.archivedAt = archived ? (row.archivedAt ?? new Date()) : null;
    },
  } as unknown as TemplateLibraryEngine;
  const userEdit = (title: string, content: string) => {
    const row = rows.find((r) => r.title === title);
    if (!row) throw new Error(`no row titled ${title}`);
    row.content = content;
    row.version += 1;
  };
  const userArchive = (title: string) => {
    const row = rows.find((r) => r.title === title);
    if (!row) throw new Error(`no row titled ${title}`);
    row.archivedAt = new Date();
  };
  return { engine, rows, userEdit, userArchive };
}

const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
} as unknown as Parameters<typeof seedTemplateLibrary>[0]["db"];

const CODE_REVIEW_ENTRY = {
  id: "code-review",
  content: '{"id":"code-review"}',
};
const GTM_ENTRY = { id: "gtm", content: '{"id":"gtm"}' };
const ENTRIES = [CODE_REVIEW_ENTRY, GTM_ENTRY];

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
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "revised" });
    expect(rows).toHaveLength(2);
    const revised = rows.find((r) => r.title === "code-review");
    expect(revised?.version).toBe(2);
    expect(revised?.content).toBe('{"id":"code-review","v":2}');
  });

  test("a user-edited template is never clobbered by a moved manifest", async () => {
    const { engine, rows, userEdit } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    userEdit("code-review", '{"id":"code-review","mine":true}');
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":2}' },
        { id: "gtm", content: '{"id":"gtm"}' },
      ],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "kept" });
    const edited = rows.find((r) => r.title === "code-review");
    expect(edited?.content).toBe('{"id":"code-review","mine":true}');
  });

  test("a manifest change after an untouched earlier revision still converges", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":2}' },
        GTM_ENTRY,
      ],
      engine,
    });
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":3}' },
        GTM_ENTRY,
      ],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "revised" });
    expect(rows.find((r) => r.title === "code-review")?.content).toBe(
      '{"id":"code-review","v":3}',
    );
  });

  test("a template dropped from the manifest is retired (archived), not deleted", async () => {
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
      entries: [GTM_ENTRY],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "retired" });
    const retired = rows.find((r) => r.title === "code-review");
    expect(retired?.archivedAt).not.toBeNull();
    expect(rows).toHaveLength(2);
  });

  test("a user-edited template dropped from the manifest is kept visible", async () => {
    const { engine, rows, userEdit } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    userEdit("code-review", '{"id":"code-review","mine":true}');
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [GTM_ENTRY],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "kept" });
    expect(rows.find((r) => r.title === "code-review")?.archivedAt).toBeNull();
  });

  test("a retired template re-added to the manifest is restored to the current content", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [GTM_ENTRY],
      engine,
    });
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":2}' },
        GTM_ENTRY,
      ],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "restored" });
    const restored = rows.find((r) => r.title === "code-review");
    expect(restored?.archivedAt).toBeNull();
    expect(restored?.content).toBe('{"id":"code-review","v":2}');
    expect(rows).toHaveLength(2);
  });

  test("a template the user archived themselves stays archived", async () => {
    const { engine, rows, userArchive } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    userArchive("code-review");
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "kept" });
    expect(
      rows.find((r) => r.title === "code-review")?.archivedAt,
    ).not.toBeNull();
  });

  test("a legacy seeded row without a seed marker adopts one when content matches", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    for (const row of rows) {
      row.source = { origin: "template-library-seed", templateId: row.title };
    }
    const adopt = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    expect(adopt.map((o) => o.outcome)).toEqual(["unchanged", "unchanged"]);
    const moved = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":2}' },
        GTM_ENTRY,
      ],
      engine,
    });
    expect(moved).toContainEqual({ id: "code-review", outcome: "revised" });
  });

  test("a legacy seeded row whose content differs without a marker is preserved", async () => {
    const { engine, rows } = memoryEngine();
    await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: ENTRIES,
      engine,
    });
    for (const row of rows) {
      row.source = { origin: "template-library-seed", templateId: row.title };
    }
    const edited = rows.find((r) => r.title === "code-review");
    if (!edited) throw new Error("row missing");
    edited.content = '{"id":"code-review","mine":true}';
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [
        { id: "code-review", content: '{"id":"code-review","v":2}' },
        GTM_ENTRY,
      ],
      engine,
    });
    expect(outcomes).toContainEqual({ id: "code-review", outcome: "kept" });
    expect(edited.content).toBe('{"id":"code-review","mine":true}');
  });

  test("a user-created artifact sharing a template's title is never touched or duplicated", async () => {
    const { engine, rows } = memoryEngine();
    rows.push({
      id: "art_user",
      tenantId: TENANT.id,
      kind: WORKBENCH_TEMPLATE_ARTIFACT_KIND,
      title: "code-review",
      content: '{"mine":true}',
      version: 1,
      archivedAt: null,
      source: { origin: "member" },
    });
    const outcomes = await seedTemplateLibrary({
      db: fakeDb,
      scope: SCOPE,
      entries: [CODE_REVIEW_ENTRY],
      engine,
    });
    expect(outcomes).toEqual([{ id: "code-review", outcome: "kept" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('{"mine":true}');
  });
});

const OTHER_TENANT = { id: "tenant_b" };

describe("createTemplateLibrarySeeder", () => {
  test("seeds a tenant the first time it is asked, and not again after", async () => {
    let passes = 0;
    const seeder = createTemplateLibrarySeeder({
      db: fakeDb,
      entries: ENTRIES,
      seed: async (args) => {
        passes += 1;
        return seedTemplateLibrary(args);
      },
      engine: memoryEngine().engine,
    });

    await seeder.ensureSeeded(SCOPE);
    await seeder.ensureSeeded(SCOPE);
    expect(passes).toBe(1);
  });

  test("concurrent first reads share one seed pass", async () => {
    let passes = 0;
    const seeder = createTemplateLibrarySeeder({
      db: fakeDb,
      entries: ENTRIES,
      seed: async (args) => {
        passes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return seedTemplateLibrary(args);
      },
      engine: memoryEngine().engine,
    });

    await Promise.all([seeder.ensureSeeded(SCOPE), seeder.ensureSeeded(SCOPE)]);
    expect(passes).toBe(1);
  });

  test("a failed pass never latches: the next read retries instead of giving up", async () => {
    let passes = 0;
    const seeder = createTemplateLibrarySeeder({
      db: fakeDb,
      entries: ENTRIES,
      seed: async (args) => {
        passes += 1;
        if (passes === 1) throw new Error("database is booting");
        return seedTemplateLibrary(args);
      },
      engine: memoryEngine().engine,
    });

    await expect(seeder.ensureSeeded(SCOPE)).rejects.toThrow(
      "database is booting",
    );
    await seeder.ensureSeeded(SCOPE);
    expect(passes).toBe(2);
  });

  test("each tenant converges on its own first read — no operator bench involved", async () => {
    const seededTenants: string[] = [];
    const seeder = createTemplateLibrarySeeder({
      db: fakeDb,
      entries: ENTRIES,
      seed: async (args) => {
        seededTenants.push(args.scope.tenantId);
        return seedTemplateLibrary(args);
      },
      engine: memoryEngine().engine,
    });

    await seeder.ensureSeeded(SCOPE);
    await seeder.ensureSeeded({
      tenantId: OTHER_TENANT.id,
      principalId: "prin_b",
    });
    expect(seededTenants).toEqual([TENANT.id, OTHER_TENANT.id]);
  });
});

type TestEnv = {
  Variables: { tenant: { id: string }; principal: { id: string } };
};

function mountRoutes(
  store: TemplateLibraryStore,
  seeder: TemplateLibrarySeeder,
): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", { id: SCOPE.principalId });
    await next();
  });
  app.route(
    "/library/templates",
    createTemplateLibraryRoutes({
      store,
      seeder,
      requireGrant: allowAll,
      log: () => {},
    }),
  );
  return app;
}

const noopSeeder: TemplateLibrarySeeder = { ensureSeeded: async () => {} };

const fakeStore: TemplateLibraryStore = {
  async list(tenantId) {
    return tenantId === TENANT.id ? ENTRIES : [];
  },
  async get(tenantId, templateId) {
    if (tenantId !== TENANT.id) return null;
    return ENTRIES.find((e) => e.id === templateId) ?? null;
  },
};

/** The bench the owner actually hit: a tenant nothing ever seeded, on a
 * hub that never resolved an operator bench. Reads go through the real
 * store over the same memory engine the seeder writes into, so a served
 * template proves the read itself converged the shelf. */
function mountUnseededTenant(): Hono<TestEnv> {
  const { engine } = memoryEngine();
  return mountRoutes(
    createTemplateLibraryDbStore(fakeDb, engine),
    createTemplateLibrarySeeder({ db: fakeDb, entries: ENTRIES, engine }),
  );
}

describe("template library routes", () => {
  test("lists the seeded entries", async () => {
    const res = await mountRoutes(fakeStore, noopSeeder).request(
      "/library/templates",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ENTRIES });
  });

  test("fetches one template by id", async () => {
    const res = await mountRoutes(fakeStore, noopSeeder).request(
      "/library/templates/code-review",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CODE_REVIEW_ENTRY);
  });

  test("404s an id the library does not hold", async () => {
    const res = await mountRoutes(fakeStore, noopSeeder).request(
      "/library/templates/standup",
    );
    expect(res.status).toBe(404);
  });

  test("a never-seeded tenant's first list read seeds the shelf and serves it", async () => {
    const res = await mountUnseededTenant().request("/library/templates");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ENTRIES });
  });

  test("a never-seeded tenant's first template read serves the template instead of 404ing", async () => {
    const res = await mountUnseededTenant().request(
      "/library/templates/code-review",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CODE_REVIEW_ENTRY);
  });

  test("a seed the read could not run answers 503, never a 404 that reads as 'no such template'", async () => {
    const failing: TemplateLibrarySeeder = {
      ensureSeeded: async () => {
        throw new Error("artifacts database unreachable");
      },
    };
    const app = mountRoutes(fakeStore, failing);

    const list = await app.request("/library/templates");
    expect(list.status).toBe(503);
    const one = await app.request("/library/templates/code-review");
    expect(one.status).toBe(503);
    const body = (await one.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unavailable");
  });
});

describe("createUnavailableTemplateLibraryRoutes", () => {
  test("both routes answer 503 instead of the mount silently not existing", async () => {
    const app = new Hono<TestEnv>();
    app.use("*", async (c, next) => {
      c.set("tenant", TENANT);
      c.set("principal", { id: SCOPE.principalId });
      await next();
    });
    app.route(
      "/library/templates",
      createUnavailableTemplateLibraryRoutes(allowAll),
    );

    const list = await app.request("/library/templates");
    expect(list.status).toBe(503);
    const listBody = (await list.json()) as { error: { code: string } };
    expect(listBody.error.code).toBe("unavailable");

    const one = await app.request("/library/templates/starter");
    expect(one.status).toBe(503);
  });
});
