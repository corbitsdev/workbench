import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";

import { mountMemory } from "./memory-mount";

const KEYS = [
  "DATABASE_URL",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_API_STYLE",
  "EMBED_API_KEY",
] as const;

type EnvKey = (typeof KEYS)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  // Must actually remove the key: `process.env[key] = undefined` stores the
  // *string* "undefined" (Bun >= 1.4 matches Node here), which reads as a
  // configured value and makes every DATABASE_URL/EMBED_BASE_URL gate in this
  // app's suites fire against postgres.js's localhost:5432 default.
  // `Reflect.deleteProperty` because eslint forbids dynamic `delete`.
  Reflect.deleteProperty(process.env, key);
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
  test("returns undefined when EMBED_BASE_URL is unset (optional)", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    const handle = await mountMemory({
      app,
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle).toBeUndefined();
  });

  test("throws when optional is false and EMBED_BASE_URL is missing", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
        optional: false,
      }),
    ).rejects.toThrow(/EMBED_BASE_URL/);
  });

  test("fails loudly at config parse when EMBED_BASE_URL is set but blank, rather than silently treating it as unset", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    process.env["EMBED_BASE_URL"] = "";
    const app = new Hono();
    await expect(
      mountMemory({
        app,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      }),
    ).rejects.toThrow(/EMBED_BASE_URL/);
  });
});

// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// packages/approvals/test/needs-you.test.ts). Proves the actual cutover:
// mounting with only DATABASE_URL (no second memory-plane URL) lands the
// memory engine's tables in its own `memory` schema, never `public`.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("mountMemory: schema isolation against a real database", () => {
  afterAll(async () => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  test("mounts off DATABASE_URL alone and creates tables under `memory`, not `public`", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
    process.env["EMBED_MODEL"] = "test-embedding-model";

    const app = new Hono();
    const handle = await mountMemory({
      app,
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    });
    expect(handle).toBeDefined();

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
  });
});
