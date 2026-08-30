// WORKBENCH DELTA (see VENDORED.md): DB-gated coverage for the widened
// workflow-definition-store surface (CL-7275) -- findById/findByName/
// listByTenant/listByAsset/updateFields, the four read shapes plus the
// update shape the 41 hand-rolled call sites this store now covers
// actually needed. Runs its own per-test schema against DATABASE_URL,
// matching migrate.test.ts's convention, so it never touches a
// developer's default schema.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createWorkflowDefinitionStore } from "./workflow-definition-store";
import { dropSchema, runMigrations } from "./migrate";
import * as schema from "./schema";
import { asset, principal, tenant, workflowDefinition } from "./schema";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = databaseUrl === "" ? describe.skip : describe;

function configFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username) || userInfo().username,
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  };
}

describeIfDb("createWorkflowDefinitionStore's widened surface", () => {
  const schemaName = `wds_test_${Date.now().toString(36)}`;
  const baseConfig = configFromUrl(databaseUrl);
  const config = { ...baseConfig, schema: schemaName };

  let db: ReturnType<typeof drizzle<typeof schema>>;
  let close: () => Promise<void>;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const principalId = randomUUID();

  beforeAll(async () => {
    await runMigrations(baseConfig, { schema: schemaName });
    const sql = postgres({ ...config, max: 1, onnotice: () => undefined });
    db = drizzle(sql, { schema });
    close = () => sql.end();

    for (const id of [tenantId, otherTenantId]) {
      await db.insert(tenant).values({
        id,
        name: "Workflow Definition Store Test",
        slug: `wds-test-${id.slice(-8)}`,
        domain: `wds-test-${id.slice(-8)}.example`,
      });
    }
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: `usr_${tenantId.slice(-8)}`,
      status: "active",
    });
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await dropSchema(baseConfig, { schema: schemaName });
  });

  async function insertAsset(name: string): Promise<string> {
    const assetId = randomUUID();
    await db.insert(asset).values({
      id: assetId,
      tenantId,
      kind: "workflow",
      name,
      displayName: name,
      creatorPrincipalId: principalId,
    });
    return assetId;
  }

  async function insertDefinition(opts: {
    name: string;
    assetId: string;
    status?: "deployed" | "stopped";
    tenantIdOverride?: string;
  }): Promise<string> {
    const definitionId = randomUUID();
    await db.insert(workflowDefinition).values({
      id: definitionId,
      tenantId: opts.tenantIdOverride ?? tenantId,
      assetId: opts.assetId,
      name: opts.name,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
    });
    return definitionId;
  }

  test("findById returns undefined for a real id from another tenant", async () => {
    const store = createWorkflowDefinitionStore(db);
    const assetId = await insertAsset("cross-tenant-asset");
    const definitionId = await insertDefinition({
      name: "cross-tenant-def",
      assetId,
      tenantIdOverride: otherTenantId,
    });

    expect(await store.findById(tenantId, definitionId)).toBeUndefined();
    const found = await store.findById(otherTenantId, definitionId);
    expect(found?.id).toBe(definitionId);
  });

  test("findByName filters by status when asked", async () => {
    const store = createWorkflowDefinitionStore(db);
    const assetId = await insertAsset("named-asset");
    await insertDefinition({
      name: "stopped-def",
      assetId,
      status: "stopped",
    });

    expect(
      await store.findByName(tenantId, "stopped-def", { status: "deployed" }),
    ).toBeUndefined();
    const found = await store.findByName(tenantId, "stopped-def");
    expect(found?.status).toBe("stopped");
  });

  test("listByTenant scopes to the tenant and honors the status filter", async () => {
    const store = createWorkflowDefinitionStore(db);
    const assetId = await insertAsset("tenant-listing-asset");
    const deployedId = await insertDefinition({
      name: "deployed-def",
      assetId,
    });
    await insertDefinition({
      name: "stopped-def-2",
      assetId,
      status: "stopped",
    });

    const deployedOnly = await store.listByTenant(tenantId, {
      status: "deployed",
    });
    expect(deployedOnly.map((row) => row.id)).toContain(deployedId);
    expect(deployedOnly.every((row) => row.status === "deployed")).toBe(true);
  });

  test("listByAsset returns every sibling newest-first", async () => {
    const store = createWorkflowDefinitionStore(db);
    const assetId = await insertAsset("sibling-asset");
    const first = await insertDefinition({ name: "v1", assetId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await insertDefinition({ name: "v2", assetId });

    const siblings = await store.listByAsset(tenantId, assetId);
    expect(siblings.map((row) => row.id)).toEqual([second, first]);
  });

  test("updateFields patches only the tenant's own row and stamps updatedAt", async () => {
    const store = createWorkflowDefinitionStore(db);
    const assetId = await insertAsset("update-asset");
    const definitionId = await insertDefinition({
      name: "update-def",
      assetId,
    });
    const before = await store.findById(tenantId, definitionId);

    await store.updateFields(otherTenantId, definitionId, {
      status: "stopped",
    });
    expect((await store.findById(tenantId, definitionId))?.status).toBe(
      "deployed",
    );

    await store.updateFields(tenantId, definitionId, {
      description: "renamed",
      status: "stopped",
    });
    const after = await store.findById(tenantId, definitionId);
    expect(after?.description).toBe("renamed");
    expect(after?.status).toBe("stopped");
    expect(after?.updatedAt.getTime()).toBeGreaterThan(
      before?.updatedAt.getTime() ?? 0,
    );
  });
});
