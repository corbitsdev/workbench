// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// packages/chat/test/migrations.test.ts). Runs against the caller's own
// database and deletes every row it wrote in afterAll, since the tables it
// touches (tenant, workflow_definition, workflow_run, approval) are shared
// platform tables this suite must not leave dirty for anything else that
// reads them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";

import { createDB, schema, parseApprovalRow, type DB } from "@intx/db";
import { createInMemoryGrantStore } from "@intx/authz";
import type { TenantEnv, TenantRow, PrincipalRow } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";

import { createNeedsYouRoutes } from "../src/routes";
import { hydrateNeedsYou } from "../src/view-model";

// Parse DATABASE_URL the same way the hub does (apps/hub/src/index.ts):
// an empty user falls through to the postgres client's OS-username default.
// Do not default to "postgres" — that role often does not exist on laptop
// installs that use peer auth as $USER.
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

describeIfDb("needs-you: resolving pending approvals to display labels", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const otherTenantId = generateId("tenant");
  const definitionId = `def_${generateId("deployment")}`;
  const runId = `run_${generateId("deployment")}`;
  const approvalId = generateId("approval");
  const resolvedApprovalId = generateId("approval");
  const otherTenantApprovalId = generateId("approval");
  const approverPrincipalId = generateId("principal");
  const strangerPrincipalId = generateId("principal");

  const tenantRow: TenantRow = {
    id: tenantId,
    name: "Growth Team Bench",
    slug: `growth-${tenantId}`,
    domain: `growth-${tenantId}.localhost`,
    parentId: null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    db = createDB(dbConfigFromUrl(databaseUrl as string));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Growth Team Bench",
      slug: `growth-${tenantId}`,
      domain: `growth-${tenantId}.localhost`,
    });
    await db.db.insert(schema.tenant).values({
      id: otherTenantId,
      name: "Unrelated Bench",
      slug: `unrelated-${otherTenantId}`,
      domain: `unrelated-${otherTenantId}.localhost`,
    });
    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      name: "Outreach Composer",
      status: "deployed",
    });
    await db.db.insert(schema.workflowRun).values({
      id: runId,
      definitionId,
      tenantId,
      status: "running",
    });
    await db.db.insert(schema.approval).values({
      id: approvalId,
      tenantId,
      deploymentId: runId,
      runId,
      agentAddress: `instance_abc123@growth-${tenantId}.localhost`,
      correlationId: `cor_${generateId("signal")}`,
      toolDefinition: { name: "send_email" },
      toolArguments: { to: "customer@example.com" },
      status: "pending",
    });
    await db.db.insert(schema.approval).values({
      id: resolvedApprovalId,
      tenantId,
      deploymentId: runId,
      runId,
      agentAddress: `instance_abc123@growth-${tenantId}.localhost`,
      correlationId: `cor_${generateId("signal")}`,
      toolDefinition: { name: "send_email" },
      toolArguments: { to: "customer@example.com" },
      status: "approved",
      resolvedAt: new Date(),
    });
    await db.db.insert(schema.approval).values({
      id: otherTenantApprovalId,
      tenantId: otherTenantId,
      deploymentId: runId,
      runId,
      agentAddress: `instance_abc123@growth-${tenantId}.localhost`,
      correlationId: `cor_${generateId("signal")}`,
      toolDefinition: { name: "send_email" },
      toolArguments: {},
      status: "pending",
    });
  });

  afterAll(async () => {
    await db.db
      .delete(schema.approval)
      .where(eq(schema.approval.id, approvalId));
    await db.db
      .delete(schema.approval)
      .where(eq(schema.approval.id, resolvedApprovalId));
    await db.db
      .delete(schema.approval)
      .where(eq(schema.approval.id, otherTenantApprovalId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, runId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
    await db.db
      .delete(schema.tenant)
      .where(eq(schema.tenant.id, otherTenantId));
    await db.close();
  });

  test("hydrateNeedsYou resolves the agent and bench names off the approval's own foreign keys", async () => {
    const row = await db.db.query.approval.findFirst({
      where: eq(schema.approval.id, approvalId),
    });
    if (row === undefined) throw new Error("fixture approval missing");

    const [item] = await hydrateNeedsYou(db.db, [parseApprovalRow(row)]);

    expect(item).toBeDefined();
    expect(item?.agentName).toBe("Outreach Composer");
    expect(item?.benchName).toBe("Growth Team Bench");
    expect(item?.headline).toBe("send_email");
    // The UI floor: nothing on the view model may be the raw id a person
    // would have to decode to understand what they're looking at.
    expect(JSON.stringify(item)).not.toContain(runId);
    expect(JSON.stringify(item)).not.toContain(tenantId);
    expect(JSON.stringify(item)).not.toContain(definitionId);
  });

  function mountedApp(principal: PrincipalRow) {
    const app = new Hono<TenantEnv>();
    app.use("*", async (c: Context<TenantEnv>, next: Next) => {
      c.set("tenant", tenantRow);
      c.set("principal", principal);
      c.set("user", null);
      c.set("session", null);
      await next();
    });
    app.route(
      "/",
      createNeedsYouRoutes({
        db: db.db,
        grantStore: createInMemoryGrantStore([
          {
            id: generateId("grant"),
            resource: "approval:*",
            action: "resolve",
            effect: "allow",
            origin: "system",
            conditions: null,
            expiresAt: null,
            roleId: null,
            principalId: approverPrincipalId,
          },
        ]),
        conditionRegistry: {},
      }),
    );
    return app;
  }

  test("a principal holding the approval:* grant sees the pending item with resolved names", async () => {
    const app = mountedApp({
      id: approverPrincipalId,
      tenantId,
      kind: "user",
      refId: "usr_approver",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      agentName: "Outreach Composer",
      benchName: "Growth Team Bench",
      headline: "send_email",
    });
  });

  test("a principal with no approval grant is refused server-side, not just hidden in the UI", async () => {
    const app = mountedApp({
      id: strangerPrincipalId,
      tenantId,
      kind: "user",
      refId: "usr_stranger",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await app.request("/");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  describe("single-approval detail read", () => {
    function approverApp() {
      return mountedApp({
        id: approverPrincipalId,
        tenantId,
        kind: "user",
        refId: "usr_approver",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    function strangerApp() {
      return mountedApp({
        id: strangerPrincipalId,
        tenantId,
        kind: "user",
        refId: "usr_stranger",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    test("an approver reads a pending approval's status", async () => {
      const response = await approverApp().request(`/${approvalId}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body).toMatchObject({
        id: approvalId,
        status: "pending",
        agentName: "Outreach Composer",
        benchName: "Growth Team Bench",
      });
    });

    test("a resolved approval is still fetchable, in its terminal status", async () => {
      const response = await approverApp().request(`/${resolvedApprovalId}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("approved");
    });

    // The tenant-wide approval:* grant this read checks is deliberately
    // coarser than the native routes' per-deployment approval:<id> check --
    // a 403 here means "could not determine," never "cannot resolve." See
    // `packages/chat-ui/src/blocks/approve-card-state.ts`.
    test("a principal without the tenant-wide grant is refused, not shown a guessed status", async () => {
      const response = await strangerApp().request(`/${approvalId}`);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
    });

    // Authorization is checked before the row is loaded (the grant is
    // tenant-wide, not keyed to the target id), so an unauthorized caller
    // gets the same 403 whether the id exists or not -- a 404-vs-403 split
    // here would let a stranger enumerate which ids exist in the tenant.
    test("an unauthorized principal sees 403 even for an id that doesn't exist, never a leaking 404", async () => {
      const response = await strangerApp().request("/apv_does_not_exist");
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
    });

    test("an unknown approval id 404s", async () => {
      const response = await approverApp().request("/apv_does_not_exist");
      expect(response.status).toBe(404);
    });

    test("cross-tenant existence is masked as 404, not 403", async () => {
      const response = await approverApp().request(`/${otherTenantApprovalId}`);
      expect(response.status).toBe(404);
    });
  });
});
