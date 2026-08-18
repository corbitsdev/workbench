// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/granola-tools/test/credential-delivery.drizzle.test.ts`. Runs
// against its own Postgres schema, never the developer's or the
// walking-skeleton suite's.
//
// Proves CL-6191: `listMcpServerConnections` walks the tenant ancestor
// chain the same way `@intx/db`'s own `resolveProviderByName`/
// `listAssetsForTenant` do, rather than matching the exact tenant only —
// a child tenant sees an ancestor's MCP server connections, and a
// same-slug connection made at the child shadows the ancestor's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { listMcpServerConnections } from "../src/mcp-server-store";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "connections_mcp_server_store_test";

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

async function seedMcpServer(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  input: {
    tenantId: string;
    slug: string;
    providerId: string;
    credentialId: string;
    name: string;
    url: string;
  },
) {
  await db.insert(schema.provider).values({
    id: input.providerId,
    tenantId: input.tenantId,
    name: `mcp:${input.slug}`,
    plugin: "mcp-streamable-http",
    apiBaseUrl: input.url,
  });
  await db.insert(schema.credential).values({
    id: input.credentialId,
    tenantId: input.tenantId,
    providerId: input.providerId,
    name: input.name,
    type: "api_key",
    secret: "unused-in-this-test",
    status: "active",
  });
}

describeIfDb(
  "listMcpServerConnections: tenant ancestor-chain inheritance",
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

    test("a child tenant sees a parent tenant's MCP server connection", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_sees_parent" });
        await seedTenant(db, {
          id: "tnt_sees_parent_child",
          parentId: "tnt_sees_parent",
        });
        await seedMcpServer(db, {
          tenantId: "tnt_sees_parent",
          slug: "granola",
          providerId: "prov_sees_parent",
          credentialId: "cred_sees_parent",
          name: "Granola",
          url: "https://mcp.granola.ai/mcp",
        });

        const connections = await listMcpServerConnections(
          db,
          "tnt_sees_parent_child",
        );

        expect(connections).toEqual([
          {
            slug: "granola",
            name: "Granola",
            url: "https://mcp.granola.ai/mcp",
          },
        ]);
      } finally {
        await close();
      }
    });

    test("a child's own connection shadows a parent's same-slug connection", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_shadow_parent" });
        await seedTenant(db, {
          id: "tnt_shadow_child",
          parentId: "tnt_shadow_parent",
        });
        await seedMcpServer(db, {
          tenantId: "tnt_shadow_parent",
          slug: "exa",
          providerId: "prov_shadow_parent",
          credentialId: "cred_shadow_parent",
          name: "Exa (parent)",
          url: "https://mcp.exa.ai/parent",
        });
        await seedMcpServer(db, {
          tenantId: "tnt_shadow_child",
          slug: "exa",
          providerId: "prov_shadow_child",
          credentialId: "cred_shadow_child",
          name: "Exa (child)",
          url: "https://mcp.exa.ai/child",
        });

        const connections = await listMcpServerConnections(
          db,
          "tnt_shadow_child",
        );

        expect(connections).toEqual([
          { slug: "exa", name: "Exa (child)", url: "https://mcp.exa.ai/child" },
        ]);
      } finally {
        await close();
      }
    });

    test("a grandchild tenant walks two levels to see a grandparent's connection", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_grandparent" });
        await seedTenant(db, {
          id: "tnt_parent_of_grandchild",
          parentId: "tnt_grandparent",
        });
        await seedTenant(db, {
          id: "tnt_grandchild",
          parentId: "tnt_parent_of_grandchild",
        });
        await seedMcpServer(db, {
          tenantId: "tnt_grandparent",
          slug: "linear",
          providerId: "prov_grandparent",
          credentialId: "cred_grandparent",
          name: "Linear",
          url: "https://mcp.linear.app/mcp",
        });

        const connections = await listMcpServerConnections(
          db,
          "tnt_grandchild",
        );

        expect(connections).toEqual([
          { slug: "linear", name: "Linear", url: "https://mcp.linear.app/mcp" },
        ]);
      } finally {
        await close();
      }
    });

    test("a sibling tenant never sees another sibling's connection", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await seedTenant(db, { id: "tnt_siblings_parent" });
        await seedTenant(db, {
          id: "tnt_sibling_a",
          parentId: "tnt_siblings_parent",
        });
        await seedTenant(db, {
          id: "tnt_sibling_b",
          parentId: "tnt_siblings_parent",
        });
        await seedMcpServer(db, {
          tenantId: "tnt_sibling_a",
          slug: "notion",
          providerId: "prov_sibling_a",
          credentialId: "cred_sibling_a",
          name: "Notion",
          url: "https://mcp.notion.example/mcp",
        });

        const connections = await listMcpServerConnections(db, "tnt_sibling_b");

        expect(connections).toEqual([]);
      } finally {
        await close();
      }
    });
  },
);
