// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// `apps/hub/src/memory-mount.test.ts`). Runs against the caller's own
// database and deletes every row it wrote in `afterAll`.
//
// This suite proves the bearer mirror (`createWorkflowRunDeployAuth`) reaches
// the EXACT SAME `createWorkflowRoutes` deploy handler a human session does
// -- same `requireGrant("workflow:*", "create")` gate, same asset-scoping,
// same install/probe/gate/freeze call into `sessionService.deployWorkflowFromSource`
// -- rather than a parallel, weaker path. `deployWorkflowFromSource` itself
// (the actual probe/gate/freeze internals) is a fake here: those internals
// live in `@intx/hub-sessions` and are unchanged and already covered there;
// what is new, and under test, is only the auth wiring in front of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { createDB, schema, type DB } from "@intx/db";
import { createInMemoryGrantStore } from "@intx/authz";
import { generateId } from "@intx/hub-common";
import type {
  DeployWorkflowFromSourceParams,
  SessionService,
} from "@intx/hub-sessions";

import { createRequireGrant } from "../middleware/grant";
import { createWorkflowRoutes } from "../routes/workflows";
import {
  createWorkflowRunDeployAuth,
  type WorkflowRunAuthenticator,
} from "./workflow-run-deploy-auth";
import type { TenantEnv } from "../context";

function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("workflow deploy: bearer mirror of the session deploy route", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const otherTenantId = generateId("tenant");
  const runPrincipalId = generateId("principal");
  const ungrantedPrincipalId = generateId("principal");
  const ownAssetId = generateId("asset");
  const otherTenantAssetId = generateId("asset");
  const SIDECAR_TOKEN = "sidecar-token-for-this-run";
  const RUN_ADDRESS = "workflow-run@tenant.example.test";

  let deployCalls: unknown[] = [];

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    for (const [id, domain] of [
      [tenantId, `deploy-bearer-${tenantId}.localhost`],
      [otherTenantId, `deploy-bearer-${otherTenantId}.localhost`],
    ] as const) {
      await db.db.insert(schema.tenant).values({
        id,
        name: "Deploy Bearer Test Tenant",
        slug: `deploy-bearer-${id}`,
        domain,
        parentId: null,
        config: null,
      });
    }

    await db.db.insert(schema.principal).values([
      {
        id: runPrincipalId,
        tenantId,
        kind: "workflow",
        refId: RUN_ADDRESS,
        status: "active",
      },
      {
        id: ungrantedPrincipalId,
        tenantId,
        kind: "workflow",
        refId: "workflow-run-no-grant@tenant.example.test",
        status: "active",
      },
    ]);

    await db.db.insert(schema.asset).values([
      {
        id: ownAssetId,
        tenantId,
        kind: "workflow",
        name: "own-workflow",
        displayName: "Own workflow",
      },
      {
        id: otherTenantAssetId,
        tenantId: otherTenantId,
        kind: "workflow",
        name: "other-tenant-workflow",
        displayName: "Other tenant workflow",
      },
    ]);
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.tenantId, tenantId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.tenantId, tenantId));
    await db.db
      .delete(schema.asset)
      .where(
        and(
          eq(schema.asset.tenantId, tenantId),
          eq(schema.asset.id, ownAssetId),
        ),
      );
    await db.db
      .delete(schema.asset)
      .where(eq(schema.asset.id, otherTenantAssetId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.tenantId, tenantId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
    await db.db
      .delete(schema.tenant)
      .where(eq(schema.tenant.id, otherTenantId));
  });

  /** Resolves the fixed `SIDECAR_TOKEN`/`RUN_ADDRESS` pair to the run
   * principal fixture above -- standing in for
   * `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`, which does
   * the equivalent DB-backed sidecar-token + folded-run-address lookup. */
  const authenticator: WorkflowRunAuthenticator = {
    async resolve(token, runAddress) {
      if (token !== SIDECAR_TOKEN || runAddress !== RUN_ADDRESS) return null;
      return { tenantId, principalId: runPrincipalId };
    },
  };

  /** Stands in for `sessionService.deployWorkflowFromSource`: the real
   * install/probe/gate/freeze internals live in `@intx/hub-sessions` and
   * are untouched by this change, so this fake only records that it was
   * called (proving the bearer path reaches the SAME call the session path
   * does) and persists the anchor row the real implementation would have,
   * so the route's own read-back succeeds exactly as it does in
   * production. */
  function fakeSessionService(): SessionService {
    return {
      async deployWorkflowFromSource(
        params: DeployWorkflowFromSourceParams,
      ) {
        deployCalls.push(params);
        const anchorRunId = generateId("workflowRun");
        const definitionId = generateId("workflowDefinition");
        await db.db.insert(schema.workflowDefinition).values({
          id: definitionId,
          tenantId: params.tenantId,
          assetId: params.definitionAssetId,
          name: "own-workflow",
        });
        await db.db.insert(schema.workflowRun).values({
          id: anchorRunId,
          definitionId,
          anchorRunId,
          tenantId: params.tenantId,
          principalId: runPrincipalId,
          status: "deployed",
        });
        return {
          anchorRunId,
          deploymentAddress: params.agentAddress,
          publicKey: "pk_test",
        };
      },
      async stageWorkflowStep() {
        throw new Error("not exercised by this suite");
      },
      async sendUserMessage() {
        throw new Error("not exercised by this suite");
      },
      async endSession() {
        throw new Error("not exercised by this suite");
      },
    } as unknown as SessionService;
  }

  function mountedApp(grantStore: ReturnType<typeof createInMemoryGrantStore>) {
    const requireGrant = createRequireGrant({ grantStore, conditionRegistry: {} });
    const app = new Hono<TenantEnv>();
    app.use(
      "/api/tenants/:tenantId/workflows/deployments",
      createWorkflowRunDeployAuth({ db: db.db, authenticator }),
    );
    app.route(
      "/api/tenants/:tenantId/workflows",
      createWorkflowRoutes({
        db: db.db,
        sessionService: fakeSessionService(),
        sidecarRouter: {} as never,
        repoStore: {} as never,
        grantStore,
        requireGrant,
      }),
    );
    return app;
  }

  function deployRequest(assetId: string) {
    return new Request(
      `http://hub.test/api/tenants/${tenantId}/workflows/deployments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SIDECAR_TOKEN}`,
          "x-workflow-run-address": RUN_ADDRESS,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: {
            kind: "asset",
            assetId,
            package: { format: "tarball" },
          },
          entry: "interchange.workflow",
          sources: [
            {
              id: "src_1",
              provider: "test",
              baseURL: "https://inference.example.test",
              apiKey: "test-key",
              model: "test-model",
            },
          ],
          defaultSource: "src_1",
        }),
      },
    );
  }

  test("a workflow-run principal holding workflow:*/create deploys its own tenant's asset", async () => {
    deployCalls = [];
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "workflow:*",
        action: "create",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: runPrincipalId,
      },
    ]);
    const res = await mountedApp(grantStore).request(deployRequest(ownAssetId));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { definitionAssetId: string; tenantId: string };
    expect(body.definitionAssetId).toBe(ownAssetId);
    expect(body.tenantId).toBe(tenantId);
    // The real deploy call was reached -- not a shortcut -- scoped to the
    // authenticated run's own tenant/principal, never anything from the body.
    expect(deployCalls).toHaveLength(1);
    expect((deployCalls[0] as { tenantId: string }).tenantId).toBe(tenantId);
  });

  test("a workflow-run principal without the grant is refused before the deploy call", async () => {
    deployCalls = [];
    const noGrantAuthenticator: WorkflowRunAuthenticator = {
      async resolve(token, runAddress) {
        if (token !== SIDECAR_TOKEN || runAddress !== RUN_ADDRESS) return null;
        return { tenantId, principalId: ungrantedPrincipalId };
      },
    };
    const grantStore = createInMemoryGrantStore([]);
    const requireGrant = createRequireGrant({ grantStore, conditionRegistry: {} });
    const app = new Hono<TenantEnv>();
    app.use(
      "/api/tenants/:tenantId/workflows/deployments",
      createWorkflowRunDeployAuth({ db: db.db, authenticator: noGrantAuthenticator }),
    );
    app.route(
      "/api/tenants/:tenantId/workflows",
      createWorkflowRoutes({
        db: db.db,
        sessionService: fakeSessionService(),
        sidecarRouter: {} as never,
        repoStore: {} as never,
        grantStore,
        requireGrant,
      }),
    );
    const res = await app.request(deployRequest(ownAssetId));
    expect(res.status).toBe(403);
    expect(deployCalls).toHaveLength(0);
  });

  test("an asset belonging to another tenant reads as not-found, never a confirming 403", async () => {
    deployCalls = [];
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "workflow:*",
        action: "create",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: runPrincipalId,
      },
    ]);
    const res = await mountedApp(grantStore).request(
      deployRequest(otherTenantAssetId),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(deployCalls).toHaveLength(0);
  });

  test("an unrecognized bearer token is refused before any tenant/grant is resolved", async () => {
    deployCalls = [];
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "workflow:*",
        action: "create",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: runPrincipalId,
      },
    ]);
    const req = new Request(
      `http://hub.test/api/tenants/${tenantId}/workflows/deployments`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-the-right-token",
          "x-workflow-run-address": RUN_ADDRESS,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    const res = await mountedApp(grantStore).request(req);
    expect(res.status).toBe(401);
    expect(deployCalls).toHaveLength(0);
  });
});
