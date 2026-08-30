// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `visible-definitions.drizzle.test.ts`. Runs against its own Postgres
// schema, never the developer's or the walking-skeleton suite's.
//
// Proves `resolveMyraDefinitionIdFromDb` resolves by (name, tenant),
// requires the definition be deployed and asset-backed, and never leaks
// a match from another tenant -- the by-name category CL-7275 routed
// through `createWorkflowDefinitionStore`'s `findByName`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import {
  resolveMyraDefinitionIdFromDb,
  MyraDefinitionUnresolvableError,
} from "../src/resolve-myra-definition-id";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "agent_directory_resolve_myra_definition_id_test";
const MYRA_ASSET_NAME = "assistant";

async function seedTenant(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  id: string,
) {
  await db.insert(schema.tenant).values({
    id,
    name: id,
    slug: id.replace(/_/g, "-"),
    domain: `${id.replace(/_/g, "-")}.workbench.test`,
  });
}

async function seedDefinition(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  input: {
    id: string;
    tenantId: string;
    status?: "deployed" | "stopped";
    assetId?: string | null;
  },
) {
  const assetId =
    input.assetId === undefined ? `asset_${input.id}` : input.assetId;
  if (assetId !== null) {
    await db.insert(schema.asset).values({
      id: assetId,
      tenantId: input.tenantId,
      kind: "workflow",
      name: MYRA_ASSET_NAME,
    });
  }
  await db.insert(schema.workflowDefinition).values({
    id: input.id,
    tenantId: input.tenantId,
    name: MYRA_ASSET_NAME,
    assetId,
    status: input.status ?? "deployed",
  });
}

describeIfDb("resolveMyraDefinitionIdFromDb", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("resolves the deployed Myra definition id for the tenant", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await seedTenant(db, "tnt_myra_resolve");
      await seedDefinition(db, {
        id: "def_myra_resolve",
        tenantId: "tnt_myra_resolve",
      });

      const id = await resolveMyraDefinitionIdFromDb(db, "tnt_myra_resolve");
      expect(id).toBe("def_myra_resolve");
    } finally {
      await close();
    }
  });

  test("rejects a stopped Myra definition", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await seedTenant(db, "tnt_myra_stopped");
      await seedDefinition(db, {
        id: "def_myra_stopped",
        tenantId: "tnt_myra_stopped",
        status: "stopped",
      });

      await expect(
        resolveMyraDefinitionIdFromDb(db, "tnt_myra_stopped"),
      ).rejects.toBeInstanceOf(MyraDefinitionUnresolvableError);
    } finally {
      await close();
    }
  });

  test("never resolves another tenant's Myra definition", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await seedTenant(db, "tnt_myra_owner");
      await seedTenant(db, "tnt_myra_stranger");
      await seedDefinition(db, {
        id: "def_myra_owner",
        tenantId: "tnt_myra_owner",
      });

      await expect(
        resolveMyraDefinitionIdFromDb(db, "tnt_myra_stranger"),
      ).rejects.toBeInstanceOf(MyraDefinitionUnresolvableError);
    } finally {
      await close();
    }
  });
});
