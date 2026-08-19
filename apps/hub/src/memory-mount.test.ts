import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import { createNoopCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, dropSchema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { createLazyMemoryPlane, mountMemory } from "./memory-mount";

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

describe("mountMemory", () => {
  test("mounts synchronously and always returns a handle — nothing is built at mount time", () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    const handle = mountMemory({
      app,
      db: undefined as never, // never touched: mounting registers routes only, it never resolves config
      credentialCipher: createNoopCredentialCipher(),
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle.memory).toBeDefined();
  });

  test("registers the status route at /api/tenants/:tenantId/memory/status", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    mountMemory({
      app,
      db: undefined as never,
      credentialCipher: createNoopCredentialCipher(),
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    // No principal on the request context: the status route's own
    // fail-closed guard rejects with 401 before the (lazy, DB-touching)
    // status handler ever runs — this only proves the route exists and is
    // guarded, not that it works end-to-end.
    const res = await app.request("/api/tenants/tnt_1/memory/status");
    expect(res.status).toBe(401);
  });
});

// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// packages/approvals/test/needs-you.test.ts). Proves the actual cutover:
// mounting never touches the database, and the first real memory request
// (not the mount call) is what lands the engine's tables under its own
// `memory` schema, never `public`.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const CORE_SCHEMA = "hub_memory_mount_test";

describeIfDb("mountMemory: schema isolation against a real database", () => {
  // `describe.skip` still evaluates this body to register skipped tests,
  // so this must parse even when `databaseUrl` is unset.
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

  test("the first real memory call (not mount) creates tables under `memory`, not `public`", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;

    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
    try {
      const app = new Hono();
      // Lexical-only floor: no EMBED_* set, and no credential exists for
      // this fresh tenant, so this reaches lexical-only without ever
      // needing a seeded provider/credential row.
      const handle = mountMemory({
        app,
        db,
        credentialCipher: createNoopCredentialCipher(),
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });

      await handle.memory.add({
        tenantId: "tnt_memory_mount_lazy",
        principalId: "prn_memory_mount_lazy",
        content: { title: "t", text: "hello" },
      });

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
});

const LAZY_STATUS_SCHEMA = "hub_memory_mount_lazy_status_test";

describeIfDb("createLazyMemoryPlane: lexical-only end-to-end", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: LAZY_STATUS_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: LAZY_STATUS_SCHEMA });
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  test("builds lazily on first use and reports lexical-only status — never built at construction time", async () => {
    const { db, close } = createDB({ ...target, schema: LAZY_STATUS_SCHEMA });
    try {
      const plane = createLazyMemoryPlane({
        env: { DATABASE_URL: databaseUrl as string },
        db,
        credentialCipher: createNoopCredentialCipher(),
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });

      const [first, second] = await Promise.all([
        plane.describeStatus("tnt_memory_plane_lazy"),
        plane.describeStatus("tnt_memory_plane_lazy"),
      ]);

      expect(first.source).toBe("lexical-only");
      expect(first.embeddingsConfigured).toBe(false);
      expect(first.embed).toBeNull();
      expect(second.source).toBe("lexical-only");
    } finally {
      await close();
    }
  });
});
