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
//
// Every assertion speaks the native Interchange contract (`@intx/hub-api`'s
// `createGrantRoutes`/`createPrincipalRoutes` vocabulary): `{data,
// nextCursor}` pages, single-action `POST /grants` bodies returning the
// single `GrantResponse` object, `204` deletes, and `{error: {code,
// message}}` envelopes. The workflow-access surface is the
// workflow-run-authenticated counterpart to `/api/tenants/:tenantId
// /principals` and `/grants` — same shapes, run bearer instead of a human
// session (see the mount comment in `apps/hub/src/index.ts`).
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

function storeGrant(
  principalId: string,
  resource: string,
  action: string,
): {
  id: string;
  resource: string;
  action: string;
  effect: "allow";
  origin: "system";
  conditions: null;
  expiresAt: null;
  roleId: null;
  principalId: string;
} {
  return {
    id: generateId("grant"),
    resource,
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId,
  };
}

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

  test("GET /principals returns the native page envelope", async () => {
    const app = mountedApp(
      createInMemoryGrantStore([
        storeGrant(callerPrincipalId, "principal:*", "read"),
      ]),
    );
    const res = await app.request(request("/principals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; kind: string; status: string }[];
      nextCursor: string | null;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(
      body.data.some(
        (p) => p.id === callerPrincipalId && p.kind === "workflow",
      ),
    ).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  test("403 when the caller lacks grant:*/create", async () => {
    const app = mountedApp(createInMemoryGrantStore([]));
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          action: "read",
          effect: "allow",
          origin: "invoker",
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("403 when the requested pair exceeds the caller's own ceiling", async () => {
    const grantStore = createInMemoryGrantStore([
      storeGrant(callerPrincipalId, "grant:*", "create"),
      storeGrant(callerPrincipalId, "room:*", "read"),
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          action: "write",
          effect: "allow",
          origin: "invoker",
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("write");
  });

  test("201 within the caller's own ceiling returns the single native GrantResponse", async () => {
    const grantStore = createInMemoryGrantStore([
      storeGrant(callerPrincipalId, "grant:*", "create"),
      storeGrant(callerPrincipalId, "grant:*", "read"),
      storeGrant(callerPrincipalId, "room:*", "read"),
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request("/grants", {
        method: "POST",
        body: {
          principalId: targetPrincipalId,
          resource: "room:*",
          action: "read",
          effect: "allow",
          origin: "invoker",
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      principalId: string;
      resource: string;
      action: string;
      effect: string;
      origin: string;
    };
    expect(body.principalId).toBe(targetPrincipalId);
    expect(body.resource).toBe("room:*");
    expect(body.action).toBe("read");
    expect(body.effect).toBe("allow");

    const listRes = await app.request(
      request(`/grants?principalId=${targetPrincipalId}`),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { id: string }[];
      nextCursor: string | null;
    };
    expect(listBody.data.some((g) => g.id === body.id)).toBe(true);
    expect(listBody.nextCursor).toBeNull();

    await db.db.delete(schema.grant).where(eq(schema.grant.id, body.id));
  });

  test("revoke: 204 within the caller's own ceiling", async () => {
    const inserted = await db.db
      .insert(schema.grant)
      .values({
        id: generateId("grant"),
        tenantId,
        roleId: null,
        principalId: targetPrincipalId,
        resource: "room:*",
        action: "read",
        effect: "allow",
        conditions: null,
        origin: "invoker",
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const grantableRow = inserted[0];
    if (grantableRow === undefined)
      throw new Error("expected an inserted grant");

    const grantStore = createInMemoryGrantStore([
      storeGrant(callerPrincipalId, "grant:*", "manage"),
      storeGrant(callerPrincipalId, "room:*", "read"),
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request(`/grants/${grantableRow.id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);

    const gone = await db.db.query.grant.findFirst({
      where: eq(schema.grant.id, grantableRow.id),
    });
    expect(gone).toBeUndefined();
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
      storeGrant(callerPrincipalId, "grant:*", "manage"),
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
      storeGrant(callerPrincipalId, "grant:*", "manage"),
    ]);
    const app = mountedApp(grantStore);
    const res = await app.request(
      request(`/grants/${generateId("grant")}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});
