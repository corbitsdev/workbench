import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createInMemoryGrantStore } from "@intx/authz";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { createAccountCallerResolver, mountMemory } from "./memory-mount";

const KEYS = ["DATABASE_URL", "EMBED_BASE_URL", "EMBED_MODEL"] as const;

type EnvKey = (typeof KEYS)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  // Prefer assignment over `delete process.env[key]` — eslint forbids dynamic delete.
  process.env[key] = undefined;
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
});

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
}

// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// packages/approvals/test/needs-you.test.ts). There is no non-DB-gated
// path left to test: config is env-only now (CL-6289), but `mountMemory`
// always runs `runMemoryMigrations` against `DATABASE_URL` at boot — env,
// or the lexical-only floor, both still need a real Postgres to migrate.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const CORE_SCHEMA = "hub_memory_mount_test";

describeIfDb("mountMemory", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: CORE_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: CORE_SCHEMA });
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  test("mounts at boot — migrations run and tables land under `memory`, never `public`", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
    try {
      const app = new Hono();
      const handle = await mountMemory({
        app,
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });
      expect(handle.memory).toBeDefined();

      const postgres = (await import("postgres")).default;
      const sql = postgres(databaseUrl as string, { max: 1 });
      try {
        const memoryTables = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'memory'
        `;
        expect(memoryTables.length).toBeGreaterThan(0);

        const publicLeaks = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('document', 'raw_capture', '_migrations')
        `;
        expect(publicLeaks.length).toBe(0);
      } finally {
        await sql.end();
      }
    } finally {
      await close();
    }
  });

  test("registers the status route at /api/tenants/:tenantId/memory/status", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
    try {
      const app = new Hono();
      await mountMemory({
        app,
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });
      // No principal on the request context: the status route's own
      // fail-closed guard rejects with 401 before the status handler ever
      // runs — this only proves the route exists and is guarded.
      const res = await app.request("/api/tenants/tnt_1/memory/status");
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});

const CALLER_RESOLVER_SCHEMA = "hub_memory_caller_resolver_test";

function appWithResolver(
  db: Parameters<typeof createAccountCallerResolver>[0],
  operatorTenantId: string | undefined,
  seat: { tenantId: string; principalId: string },
) {
  const resolver = createAccountCallerResolver(db, operatorTenantId);
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", {
      id: seat.tenantId,
      name: seat.tenantId,
      slug: seat.tenantId,
      domain: `${seat.tenantId}.workbench.test`,
      parentId: null,
      config: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    c.set("principal", {
      id: seat.principalId,
      tenantId: seat.tenantId,
      kind: "user",
      refId: seat.principalId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await next();
  });
  app.get("/resolve", async (c) => {
    const resolved = await resolver(c);
    return c.json(resolved);
  });
  return app;
}

// `createAccountCallerResolver` is `registerMemoryRoutes`'s `CallerResolver`
// — the seam every memory route's identity actually flows through (see
// `memory-mount.ts`'s module doc comment). Exercised here as an isolated
// unit against a real tenant hierarchy: this is where CL-6289's security
// property — same scope in a workbench and its bench, never across
// accounts, never into the operator tenant — actually gets wired to HTTP.
describeIfDb("createAccountCallerResolver", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: CALLER_RESOLVER_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: CALLER_RESOLVER_SCHEMA });
  });

  test("remaps a workbench caller's tenant to the bench tenant, keeping the caller's own principal id", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const benchTenantId = "tnt_resolver_bench";
      const workbenchTenantId = "tnt_resolver_workbench";
      await db.insert(schema.tenant).values({
        id: benchTenantId,
        name: "Bench",
        slug: "resolver-bench",
        domain: "resolver-bench.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: workbenchTenantId,
        name: "Workbench",
        slug: "resolver-workbench",
        domain: "resolver-workbench.workbench.test",
        parentId: benchTenantId,
      });

      const app = appWithResolver(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_alice",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({
        tenantId: benchTenantId,
        principalId: "prn_alice",
      });
    } finally {
      await close();
    }
  });

  test("a caller whose own tenant IS the operator tenant resolves to null (401 via resolveCaller), never a fallback scope", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const operatorTenantId = "tnt_resolver_operator";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "resolver-operator",
        domain: "resolver-operator.workbench.test",
      });

      const app = appWithResolver(db, operatorTenantId, {
        tenantId: operatorTenantId,
        principalId: "prn_operator_admin",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toBeNull();
    } finally {
      await close();
    }
  });
});
