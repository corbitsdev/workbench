// DB-gated: skipped when DATABASE_URL is unreachable, matching this
// repo's convention for tests that talk to a real Postgres (see
// `vendor/intx/hub-api/src/middleware/workflow-run-deploy-auth.test.ts`).
// Runs against the caller's own database and deletes every row it wrote
// in `afterAll`.
//
// Exercises `createWorkflowAccessRoutes` end to end against a real DB and
// an in-memory `@intx/authz` grant store — same authorization primitive
// `createRequireGrant` and the delegation-ceiling check both call — so
// this proves the ceiling is enforced against the SAME grants a real
// deploy would see, not a bundle-local approximation.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { createInMemoryGrantStore, type GrantStore } from "@intx/authz";
import { generateId } from "@intx/hub-common";
import { dbGate } from "../../../scripts/e2e/db-gate";

import {
  createWorkflowAccessRoutes,
  type WorkflowRunAuthenticator,
} from "../src/routes";

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
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("createWorkflowAccessRoutes", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const callerPrincipalId = generateId("principal");
  const targetPrincipalId = generateId("principal");
  const SIDECAR_TOKEN = "sidecar-token-for-this-run";
  const RUN_ADDRESS = "workflow-run@tenant.example.test";

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Access Tools Test Tenant",
      slug: `access-tools-${tenantId}`,
      domain: `access-tools-${tenantId}.localhost`,
      parentId: null,
      config: null,
    });

    await db.db.insert(schema.principal).values([
      {
        id: callerPrincipalId,
        tenantId,
        kind: "workflow",
        refId: RUN_ADDRESS,
        status: "active",
      },
      {
        id: targetPrincipalId,
        tenantId,
        kind: "workflow",
        refId: "workflow-run-target@tenant.example.test",
        status: "active",
      },
    ]);
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db.delete(schema.grant).where(eq(schema.grant.tenantId, tenantId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.tenantId, tenantId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  const authenticator: WorkflowRunAuthenticator = {
    async resolve(token, runAddress) {
      if (token !== SIDECAR_TOKEN || runAddress !== RUN_ADDRESS) return null;
      return { tenantId, principalId: callerPrincipalId };
    },
  };

  function mountedApp(grantStore: GrantStore) {
    return createWorkflowAccessRoutes({
      db: db.db,
      authenticator,
      grantStore,
      conditionRegistry: {},
    });
  }

  function request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Request {
    return new Request(`http://hub.test${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        "x-workflow-run-address": RUN_ADDRESS,
        "content-type": "application/json",
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  test("401 without a recognized sidecar bearer token / run address", async () => {
    const app = mountedApp(createInMemoryGrantStore([]));
    const req = new Request("http://hub.test/principals", {
      headers: { authorization: "Bearer not-the-right-token" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(401);
  });

  test("403 when the caller lacks grant:*/create", async () => {
    const app = mountedApp(createInMemoryGrantStore([]));
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          actions: ["read"],
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("403 when the requested pair exceeds the caller's own ceiling", async () => {
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "grant:*",
        action: "create",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
      {
        id: generateId("grant"),
        resource: "room:*",
        action: "read",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          actions: ["read", "write"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { userMessage: string } };
    expect(body.error.userMessage).toContain("write");
  });

  test("201 within the caller's own ceiling", async () => {
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "grant:*",
        action: "create",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
      {
        id: generateId("grant"),
        resource: "room:*",
        action: "read",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          actions: ["read"],
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      grants: { id: string; resource: string; action: string }[];
    };
    expect(body.grants).toHaveLength(1);
    const createdGrant = body.grants[0];
    if (createdGrant === undefined) throw new Error("expected a created grant");
    expect(createdGrant.resource).toBe("room:*");

    await db.db
      .delete(schema.grant)
      .where(eq(schema.grant.id, createdGrant.id));
  });

  test("revoke: 403 outside the caller's own ceiling", async () => {
    const inserted = await db.db
      .insert(schema.grant)
      .values({
        id: generateId("grant"),
        tenantId,
        roleId: null,
        principalId: targetPrincipalId,
        resource: "asset:*",
        action: "write",
        effect: "allow",
        conditions: null,
        origin: "creator",
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const ungrantableRow = inserted[0];
    if (ungrantableRow === undefined)
      throw new Error("expected an inserted grant");

    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "grant:*",
        action: "manage",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request(`/grants/${ungrantableRow.id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);

    const stillThere = await db.db.query.grant.findFirst({
      where: eq(schema.grant.id, ungrantableRow.id),
    });
    expect(stillThere).toBeDefined();

    await db.db
      .delete(schema.grant)
      .where(eq(schema.grant.id, ungrantableRow.id));
  });

  test("404 for an unknown grant id", async () => {
    const grantStore = createInMemoryGrantStore([
      {
        id: generateId("grant"),
        resource: "grant:*",
        action: "manage",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: callerPrincipalId,
      },
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request(`/grants/${generateId("grant")}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});
