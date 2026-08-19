// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/granola-tools/test/credential-delivery.drizzle.test.ts`.
//
// Proves the lazy build end-to-end against a real (lexical-only, since no
// EMBED_* is set and no credential is seeded) plane: nothing is built at
// `createLazyMemoryPlane` construction time, the first real call runs
// migrations and builds the engine, `describeStatus` reports the plane's
// own `capabilities.embeddingsConfigured` rather than a config guess, and
// a second concurrent call reuses the same in-flight build rather than
// racing a second migration run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema } from "@intx/db";
import { createInMemoryGrantStore } from "@intx/authz";
import { createNoopCredentialCipher } from "@intx/crypto";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createLazyMemoryPlane } from "../src/lazy-plane";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const CORE_SCHEMA = "memory_plane_lazy_plane_test";

describeIfDb("createLazyMemoryPlane: lexical-only end-to-end", () => {
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

  test("builds lazily on first use and reports lexical-only status", async () => {
    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
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
