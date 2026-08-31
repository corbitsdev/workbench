// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// @corbits/folded-runs's scope-routes.drizzle.test.ts. Runs the real
// platform schema (@intx/db's runMigrations, into its own named schema on
// the shared e2e database) so createDrizzleSidecarPlacementStore is
// proven against a real tenant row's `config` jsonb column, not the
// in-memory fake — a read-modify-write bug here would silently drop
// another domain's config keys or clobber a concurrent writer, neither
// of which the in-memory store's tests can catch.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createDrizzleSidecarPlacementStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "sidecar_placement_store_test";

describeIfDb("createDrizzleSidecarPlacementStore", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  async function insertTenant(
    db: ReturnType<typeof createDB>["db"],
    id: string,
    config?: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(schema.tenant).values({
      id,
      name: id,
      slug: id,
      domain: `${id}.workbench.test`,
      ...(config !== undefined ? { config } : {}),
    });
  }

  test("setEnabled preserves other keys already present in the tenant's config", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await insertTenant(db, "tnt_preserve", {
        signupPolicy: { selfSignup: "off" },
      });
      const store = createDrizzleSidecarPlacementStore(db);

      const result = await store.setEnabled("tnt_preserve", true);

      expect(result).toBe(true);
      const [row] = await db
        .select({ config: schema.tenant.config })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, "tnt_preserve"));
      expect(row?.config).toMatchObject({
        signupPolicy: { selfSignup: "off" },
        sidecarPlacement: { sharing: "exclusive", reuse: "same-deployment" },
      });
    } finally {
      await close();
    }
  });

  test("clearing the setting removes the sidecarPlacement field entirely", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await insertTenant(db, "tnt_clear");
      const store = createDrizzleSidecarPlacementStore(db);
      await store.setEnabled("tnt_clear", true);

      const result = await store.setEnabled("tnt_clear", false);

      expect(result).toBe(false);
      const [row] = await db
        .select({ config: schema.tenant.config })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, "tnt_clear"));
      expect(
        row?.config !== null &&
          typeof row?.config === "object" &&
          "sidecarPlacement" in (row.config as Record<string, unknown>),
      ).toBe(false);
    } finally {
      await close();
    }
  });

  test("setEnabled on a missing tenant throws", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const store = createDrizzleSidecarPlacementStore(db);

      await expect(
        store.setEnabled("tnt_does_not_exist", true),
      ).rejects.toThrow(/does not exist/);
    } finally {
      await close();
    }
  });

  test("getEnabled round-trips through a real row", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await insertTenant(db, "tnt_roundtrip");
      const store = createDrizzleSidecarPlacementStore(db);

      expect(await store.getEnabled("tnt_roundtrip")).toBe(false);
      await store.setEnabled("tnt_roundtrip", true);
      expect(await store.getEnabled("tnt_roundtrip")).toBe(true);
    } finally {
      await close();
    }
  });
});
