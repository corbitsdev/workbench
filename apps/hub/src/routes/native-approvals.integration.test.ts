import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { Hono } from "hono";

import {
  createApprovalStore,
  createSignalCorrelationStore,
  type SignalCorrelationStore,
} from "@intx/db";
import { createInMemoryGrantStore } from "@intx/authz";
import { createApp } from "@intx/hub-api";
import type { GetSession, SessionUser, SessionInfo } from "@intx/hub-api";
import { signalName } from "@intx/types";
import type { GrantRule } from "@intx/types/authz";
import type {
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@workbench/hub-sessions";
import type { Handler } from "hono";

import { schema } from "../db";
import type { HubDb } from "../db";
import { createNativeApprovalsRouter } from "./native-approvals";
import { createApprovalsEventBus } from "../lib/approvals-events";
import type { ApprovalEvent } from "../lib/approvals-events";
import { publishNativeApprovalResolved } from "../lib/native-approval-notify";

// Real-Postgres (PGlite) exercise of the native approval rail (CL-3934), driven
// through interchange's own `createApp` so the mounted approve/reject routes and
// resolveTenant auth run exactly as in production. The only mocked boundary is
// the sidecar transport (`sendSignalDeliver`); the resolve transaction, stores,
// grant check, and tenant middleware are all real.

const TENANT = "tnt-native";
const OTHER_TENANT = "tnt-other";
const PRINCIPAL = "prn-native";
const USER = "usr-native";
// A second member in the same tenant who owns no instance — the cross-member
// isolation control.
const PRINCIPAL_B = "prn-native-b";
const USER_B = "usr-native-b";
const INSTANCE = "ins-native";
const DEPLOYMENT = "dep-native";
const RUN = "run-native";
const DOMAIN = "native.example.com";
const AGENT_ADDRESS = `ins_${DEPLOYMENT}@${DOMAIN}`;

let client: PGlite;
let db: HubDb;
let signalStore: SignalCorrelationStore;

let deliverCalls: { runId: string; signalId: string }[];
let events: ApprovalEvent[];

function makeUser(id: string): SessionUser {
  return {
    id,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    email: `${id}@native.example.com`,
    emailVerified: true,
    name: "Native Tester",
  };
}

function makeSession(userId: string): SessionInfo {
  return {
    id: `ses-${userId}`,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    userId,
    expiresAt: new Date("2999-01-01"),
    token: "tok",
  };
}

// Session resolves to the user named by `x-test-user` (default member A). An
// `x-anon` header returns no session, exercising the 401 path.
const getSession: GetSession = async (headers) => {
  if (headers.get("x-anon") === "1") return null;
  const userId = headers.get("x-test-user") ?? USER;
  return { user: makeUser(userId), session: makeSession(userId) };
};

function mockSidecarRouter(): SidecarRouter {
  return new Proxy(
    {
      sendSignalDeliver: (args: { runId: string; signalId: string }) => {
        deliverCalls.push({ runId: args.runId, signalId: args.signalId });
      },
    },
    {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        return () => {
          throw new Error(`mock sidecarRouter.${String(prop)} not implemented`);
        };
      },
    },
  ) as unknown as SidecarRouter;
}

function resolveGrant(): GrantRule {
  return {
    id: "grant-native",
    resource: `approval:${DEPLOYMENT}`,
    action: "resolve",
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL,
  };
}

function buildApp(): Hono {
  const bus = createApprovalsEventBus();
  bus.subscribe(TENANT, (e) => events.push(e));

  const noAuth: Handler = (c) => c.body(null, 404);
  const hubApp = createApp({
    getSession,
    authHandler: noAuth,
    db: db as never,
    sidecarRouter: mockSidecarRouter(),
    sessionService: {} as unknown as SessionService,
    eventCollectors: {} as unknown as EventCollectorRegistry,
    grantStore: createInMemoryGrantStore([resolveGrant()]),
    assetService: null,
    repoStore: null,
    maxTarballBytes: 10 * 1024 * 1024,
  });
  // Mirror index.ts: the workbench-owned native list route mounts on hubApp so
  // it inherits interchange's resolveTenant.
  hubApp.route(
    "/api/tenants/:tenantId/native-approvals",
    createNativeApprovalsRouter({ db }),
  );

  const app = new Hono();
  // Mirror index.ts: the "resolved" change notification fires from an outer
  // middleware ahead of the hub-app mount.
  const nativeResolvePath =
    /^\/api\/tenants\/([^/]+)\/approvals\/[^/]+\/(?:approve|reject)$/;
  app.use(
    "/api/tenants/:tenantId/approvals/:approvalId/:decision",
    async (c, next) => {
      await next();
      if (c.req.method !== "POST" || !c.res.ok) return;
      const match = nativeResolvePath.exec(new URL(c.req.url).pathname);
      const tenantId = match?.[1];
      if (tenantId !== undefined) publishNativeApprovalResolved(bus, tenantId);
    },
  );
  app.route("/", hubApp as never);
  return app;
}

async function registerSuspension(correlationId: string, approvalId: string) {
  await signalStore.registerIfAbsent({
    correlationId,
    tenantId: TENANT,
    deploymentId: DEPLOYMENT,
    agentAddress: AGENT_ADDRESS,
    runId: RUN,
    signalName: signalName(correlationId),
    kind: "approval",
  });
  await createApprovalStore(db as never).createIfAbsent({
    id: approvalId,
    tenantId: TENANT,
    deploymentId: DEPLOYMENT,
    runId: RUN,
    agentAddress: AGENT_ADDRESS,
    correlationId,
    status: "pending",
    toolDefinition: null,
    toolArguments: null,
    scope: null,
    timeoutAt: null,
  });
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  db = bootstrap as unknown as HubDb;
  signalStore = createSignalCorrelationStore(db as never);

  // FK off for seeding: the tenant + membership rows resolveTenant reads, and the
  // approval/correlation rows, are inserted directly.
  await client.exec(`SET session_replication_role = 'replica';`);
  for (const [id, slug] of [
    [TENANT, "native"],
    [OTHER_TENANT, "other"],
  ]) {
    await client.query(
      `insert into tenant (id, name, slug, domain) values ($1, $2, $3, $4)`,
      [id, slug, slug, `${slug}.example.com`],
    );
  }
  for (const [id, user] of [
    [PRINCIPAL, USER],
    [PRINCIPAL_B, USER_B],
  ]) {
    await client.query(
      `insert into principal (id, tenant_id, kind, ref_id, status) values ($1, $2, 'user', $3, 'active')`,
      [id, TENANT, user],
    );
  }
  // Member A owns the instance whose address the seeded approvals name; member B
  // owns nothing. The list is scoped to owned instances, so B must see none of
  // A's approvals.
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status) values ($1, $2, $3, $4, $5, 'running')`,
    [INSTANCE, "agt-native", TENANT, PRINCIPAL, AGENT_ADDRESS],
  );
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id) values ($1, $2, $3, 'myra', $4, $5)`,
    ["mai-native", TENANT, PRINCIPAL, "agt-native", INSTANCE],
  );
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  deliverCalls = [];
  events = [];
  await client.exec(`DELETE FROM approval;`);
  await client.exec(`DELETE FROM signal_correlation;`);
  await client.exec(`DELETE FROM auto_approved_tool;`);
});

async function autoApprovedRows(): Promise<
  { principal_id: string; tool_name: string; created_by_principal_id: string }[]
> {
  const rows = await client.query<{
    principal_id: string;
    tool_name: string;
    created_by_principal_id: string;
  }>(
    `select principal_id, tool_name, created_by_principal_id from auto_approved_tool`,
  );
  return rows.rows;
}

function autoApproveBody(approvalId: string, toolName: string, user = USER) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": user },
    body: JSON.stringify({ approvalId, toolName }),
  };
}

describe("native approval rail", () => {
  test("list route returns the tenant's pending suspension", async () => {
    await registerSuspension("corr-1", "apr-1");
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("apr-1");
    expect(body[0]?.status).toBe("pending");
  });

  test("list route rejects a non-member with 403 (cross-tenant scoping)", async () => {
    await registerSuspension("corr-1", "apr-1");
    const res = await buildApp().request(
      `/api/tenants/${OTHER_TENANT}/native-approvals`,
    );
    expect(res.status).toBe(403);
  });

  test("list route is ownership-scoped: another member sees nothing", async () => {
    await registerSuspension("corr-1", "apr-1");
    // Member A owns the instance and sees the approval.
    const a = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals`,
    );
    expect(await a.json()).toHaveLength(1);
    // Member B is a tenant member but owns no instance, so sees none of A's.
    const b = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals`,
      { headers: { "x-test-user": USER_B } },
    );
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual([]);
  });

  test("list route 404s an unknown tenant", async () => {
    const res = await buildApp().request(
      `/api/tenants/tnt-nope/native-approvals`,
    );
    expect(res.status).toBe(404);
  });

  test("list route 401s an unauthenticated caller", async () => {
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals`,
      { headers: { "x-anon": "1" } },
    );
    expect(res.status).toBe(401);
  });

  test("approve resolves the row, fires delivery, and notifies", async () => {
    await registerSuspension("corr-1", "apr-1");
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/approvals/apr-1/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "once" }),
      },
    );
    expect(res.status).toBe(200);
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]?.runId).toBe(RUN);
    expect(events).toEqual([
      { tenantId: TENANT, sessionId: null, kind: "resolved" },
    ]);

    const list = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals`,
    );
    expect(await list.json()).toEqual([]);
  });

  test("a second resolve of the same approval is a 409", async () => {
    await registerSuspension("corr-1", "apr-1");
    const first = await buildApp().request(
      `/api/tenants/${TENANT}/approvals/apr-1/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "once" }),
      },
    );
    expect(first.status).toBe(200);
    const second = await buildApp().request(
      `/api/tenants/${TENANT}/approvals/apr-1/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(second.status).toBe(409);
  });

  test("reject resolves a pending suspension and fires delivery", async () => {
    await registerSuspension("corr-2", "apr-2");
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/approvals/apr-2/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "no" }),
      },
    );
    expect(res.status).toBe(200);
    expect(deliverCalls).toHaveLength(1);
  });
});

describe("durable auto-approve (CL-3942)", () => {
  test("auto-approve persists a record keyed on the instance principal", async () => {
    await registerSuspension("corr-1", "apr-1");
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message"),
    );
    expect(res.status).toBe(200);
    const rows = await autoApprovedRows();
    expect(rows).toEqual([
      {
        principal_id: PRINCIPAL,
        tool_name: "slack__post_message",
        created_by_principal_id: PRINCIPAL,
      },
    ]);
  });

  test("auto-approve is idempotent (repeat click is a no-op)", async () => {
    await registerSuspension("corr-1", "apr-1");
    await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message"),
    );
    await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message"),
    );
    expect(await autoApprovedRows()).toHaveLength(1);
  });

  test("auto-approve 404s an approval the caller does not own", async () => {
    await registerSuspension("corr-1", "apr-1");
    // Member B is a tenant member but owns no instance.
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message", USER_B),
    );
    expect(res.status).toBe(404);
    expect(await autoApprovedRows()).toHaveLength(0);
  });

  test("auto-approve 404s an unknown approval id", async () => {
    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-nope", "slack__post_message"),
    );
    expect(res.status).toBe(404);
  });

  test("list returns the caller's records; another member sees none", async () => {
    await registerSuspension("corr-1", "apr-1");
    await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message"),
    );
    const mine = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approved-tools`,
    );
    const mineBody = (await mine.json()) as { toolName: string }[];
    expect(mineBody.map((r) => r.toolName)).toEqual(["slack__post_message"]);

    const other = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approved-tools`,
      { headers: { "x-test-user": USER_B } },
    );
    expect(await other.json()).toEqual([]);
  });

  test("revoke removes the record; a stranger cannot revoke it", async () => {
    await registerSuspension("corr-1", "apr-1");
    await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approve`,
      autoApproveBody("apr-1", "slack__post_message"),
    );
    const id = (await autoApprovedRows()).length;
    expect(id).toBe(1);
    const recordId = (
      await client.query<{ id: string }>(`select id from auto_approved_tool`)
    ).rows[0]?.id as string;

    // Member B cannot revoke member A's decision.
    const stranger = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approved-tools/${recordId}`,
      { method: "DELETE", headers: { "x-test-user": USER_B } },
    );
    expect(stranger.status).toBe(404);
    expect(await autoApprovedRows()).toHaveLength(1);

    const res = await buildApp().request(
      `/api/tenants/${TENANT}/native-approvals/auto-approved-tools/${recordId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await autoApprovedRows()).toHaveLength(0);
  });
});
