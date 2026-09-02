// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `packages/agent-directory/test/visible-definitions.drizzle.test.ts`.
// Proves the two things a fixture-only test can't: the grant check runs
// before anything is returned (denied -> 403, never a leaked body), and a
// deployed definition's own rows (asset, workflow_definition +
// approved version) really do read back into the documented detail shape.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { applyWorkflowDeploySourceMigrations } from "@corbits/workflow-deploy-source/migrations";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { createWorkflowDetailRoute } from "../src/detail-route";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "workflow_catalog_detail_route_test";

const TENANT = {
  id: "tnt_detail_route",
  name: "Acme",
  slug: "acme-detail-route",
  domain: "acme-detail-route.workbench.test",
};
const PRINCIPAL = {
  id: "prn_detail_route",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_detail_route",
  status: "active" as const,
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};
const denyAll: RequireGrant = () => async (c) =>
  c.json({ error: { code: "forbidden", message: "denied" } }, 403);

function mount(routes: Hono<TenantEnv>): Hono<TenantEnv> {
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

describeIfDb("createWorkflowDetailRoute", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyWorkflowDeploySourceMigrations(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );
  }, 30000);

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  }, 30000);

  test("a denied principal never sees the definition", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const app = mount(
        createWorkflowDetailRoute({ db, requireGrant: denyAll }),
      );
      const res = await app.request("/asset_missing/detail");
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  test("an unknown asset id is a 404, not a leaked shape", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const app = mount(
        createWorkflowDetailRoute({ db, requireGrant: allowAll }),
      );
      const res = await app.request("/asset_does_not_exist/detail");
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  test("a deployed definition reads back name, lifecycle, steps, and grants", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values(TENANT);
      await db.insert(schema.principal).values(PRINCIPAL);
      await db.insert(schema.asset).values({
        id: "asset_deployed_wf",
        tenantId: TENANT.id,
        kind: "workflow",
        name: "outreach",
        displayName: "Outreach",
      });
      await db.insert(schema.workflowDefinition).values({
        id: "wfd_deployed_1",
        tenantId: TENANT.id,
        assetId: "asset_deployed_wf",
        wireHash: "hash_1",
        name: "outreach",
        description: "Sends outreach messages",
        status: "deployed",
        currentVersion: "1",
        grantRequirements: [
          { resource: "mail:*", action: "send", source: "creator" },
        ],
      });
      await db.insert(schema.workflowDefinitionVersion).values({
        id: "wfdv_deployed_1",
        definitionId: "wfd_deployed_1",
        version: "1",
        status: "active",
        approvedWireHash: "hash_1",
        grantSnapshot: {
          perStep: [{ stepId: "s1", grants: ["mail:send"], grantEffects: {} }],
          grantRequirements: [
            { resource: "mail:*", action: "send", source: "creator" },
          ],
        },
        wireProjection: {
          id: "outreach",
          triggers: [],
          stepOrder: ["s1"],
          steps: { s1: { kind: "step", id: "s1" } },
        },
      });

      const app = mount(
        createWorkflowDetailRoute({ db, requireGrant: allowAll }),
      );
      const res = await app.request("/asset_deployed_wf/detail");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        definitionAssetId: "asset_deployed_wf",
        assetName: "outreach",
        displayName: "Outreach",
        lifecycle: "deployed",
        currentDefinitionId: "wfd_deployed_1",
      });
      expect(body.steps).toEqual([
        { id: "s1", role: "step", toolPins: [], grants: ["mail:send"] },
      ]);
      expect(body.grants).toEqual({
        declared: ["mail:*:send"],
        approved: ["mail:*:send"],
      });
      expect(body.credentialBindings).toEqual([]);
    } finally {
      await close();
    }
  });
});
