// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/connections/test/mcp-server-store.drizzle.test.ts`. Runs
// against its own Postgres schema, never the developer's or the
// walking-skeleton suite's.
//
// Proves CL-6253: `listVisibleAgentDefinitions` walks the tenant
// ancestor chain the same way `listMcpServerConnections` does (CL-6191) —
// a child tenant sees an ancestor's agent definitions, and a same-name
// definition made at the child shadows the ancestor's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { listVisibleAgentDefinitions } from "../src/visible-definitions";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "agent_directory_visible_definitions_test";

async function seedTenant(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  input: { id: string; parentId?: string },
) {
  await db.insert(schema.tenant).values({
    id: input.id,
    name: input.id,
    slug: input.id.replace(/_/g, "-"),
    domain: `${input.id.replace(/_/g, "-")}.workbench.test`,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
  });
}

async function seedDefinition(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  input: {
    id: string;
    tenantId: string;
    name: string;
    description?: string;
    assetId?: string | null;
    status?: "deployed" | "stopped";
  },
) {
  const assetId =
    input.assetId === undefined ? `asset_${input.id}` : input.assetId;
  if (assetId !== null) {
    await db.insert(schema.asset).values({
      id: assetId,
      tenantId: input.tenantId,
      kind: "workflow",
      name: input.name,
    });
  }
  await db.insert(schema.workflowDefinition).values({
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    assetId,
    status: input.status ?? "deployed",
  });
}

describeIfDb(
  "listVisibleAgentDefinitions: tenant ancestor-chain inheritance",
  () => {
    const target = dbTargetFromUrl(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );

    beforeAll(async () => {
      await runMigrations(target, { schema: SCHEMA });
    });

    afterAll(async () => {
      await dropSchema(target, { schema: SCHEMA });
    });

    test("a child tenant sees a parent tenant's agent definition", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_sees_parent" });
        await seedTenant(db, {
          id: "tnt_dm_sees_parent_child",
          parentId: "tnt_dm_sees_parent",
        });
        await seedDefinition(db, {
          id: "wfd_outreach",
          tenantId: "tnt_dm_sees_parent",
          name: "outreach",
          description: "Outreach",
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_sees_parent_child",
        );

        expect(definitions).toHaveLength(1);
        expect(definitions[0]).toMatchObject({
          id: "wfd_outreach",
          name: "Outreach",
          tenantId: "tnt_dm_sees_parent",
          tenantName: "tnt_dm_sees_parent",
        });
        expect(typeof definitions[0]?.createdAt).toBe("string");
      } finally {
        await close();
      }
    });

    test("a child's own definition shadows a parent's same-name definition", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_shadow_parent" });
        await seedTenant(db, {
          id: "tnt_dm_shadow_child",
          parentId: "tnt_dm_shadow_parent",
        });
        await seedDefinition(db, {
          id: "wfd_shadow_parent",
          tenantId: "tnt_dm_shadow_parent",
          name: "assist",
          description: "Assist (parent)",
        });
        await seedDefinition(db, {
          id: "wfd_shadow_child",
          tenantId: "tnt_dm_shadow_child",
          name: "assist",
          description: "Assist (child)",
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_shadow_child",
        );

        expect(definitions).toHaveLength(1);
        expect(definitions[0]).toMatchObject({
          id: "wfd_shadow_child",
          name: "Assist (child)",
          tenantId: "tnt_dm_shadow_child",
        });
      } finally {
        await close();
      }
    });

    test("a sibling tenant never sees another sibling's definition", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_siblings_parent" });
        await seedTenant(db, {
          id: "tnt_dm_sibling_a",
          parentId: "tnt_dm_siblings_parent",
        });
        await seedTenant(db, {
          id: "tnt_dm_sibling_b",
          parentId: "tnt_dm_siblings_parent",
        });
        await seedDefinition(db, {
          id: "wfd_sibling_a",
          tenantId: "tnt_dm_sibling_a",
          name: "researcher",
          description: "Researcher",
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_sibling_b",
        );

        expect(definitions).toEqual([]);
      } finally {
        await close();
      }
    });

    test("a workbench host anchor is never listed as a DM-able definition", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_host_guard" });
        await seedDefinition(db, {
          id: "wfd_host",
          tenantId: "tnt_dm_host_guard",
          name: `run-${"a".repeat(32)}`,
        });
        await seedDefinition(db, {
          id: "wfd_real",
          tenantId: "tnt_dm_host_guard",
          name: "assist",
          description: "Assist",
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_host_guard",
        );

        expect(definitions).toHaveLength(1);
        expect(definitions[0]).toMatchObject({
          id: "wfd_real",
          name: "Assist",
          tenantId: "tnt_dm_host_guard",
        });
      } finally {
        await close();
      }
    });

    test("a seeded workflow-catalog utility is never listed as a DM-able definition", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_catalog_guard" });
        await seedDefinition(db, {
          id: "wfd_echo",
          tenantId: "tnt_dm_catalog_guard",
          name: "echo",
        });
        await seedDefinition(db, {
          id: "wfd_last_30_days",
          tenantId: "tnt_dm_catalog_guard",
          name: "last-30-days-research",
        });
        await seedDefinition(db, {
          id: "wfd_recurring_task",
          tenantId: "tnt_dm_catalog_guard",
          name: "recurring-task",
        });
        await seedDefinition(db, {
          id: "wfd_workbench_digest",
          tenantId: "tnt_dm_catalog_guard",
          name: "workbench-digest",
        });
        await seedDefinition(db, {
          id: "wfd_assistant",
          tenantId: "tnt_dm_catalog_guard",
          name: "assistant",
          description: "Myra",
        });
        await seedDefinition(db, {
          id: "wfd_custom_agent",
          tenantId: "tnt_dm_catalog_guard",
          name: "my-researcher",
          description: "My researcher",
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_catalog_guard",
        );

        expect(definitions.map((d) => d.id).sort()).toEqual(
          ["wfd_assistant", "wfd_custom_agent"].sort(),
        );
      } finally {
        await close();
      }
    });

    test("a definition with no materialized asset is not launchable yet, so it isn't listed", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_dm_no_asset" });
        await seedDefinition(db, {
          id: "wfd_no_asset",
          tenantId: "tnt_dm_no_asset",
          name: "draft",
          assetId: null,
        });

        const definitions = await listVisibleAgentDefinitions(
          db,
          "tnt_dm_no_asset",
        );

        expect(definitions).toEqual([]);
      } finally {
        await close();
      }
    });
  },
);
