// DB-gated: skipped when DATABASE_URL is unreachable, matching this
// repo's convention for tests that talk to a real Postgres (see
// `packages/access-tools/test/routes.test.ts`).
//
// CL-7477/CL-7480: nothing writes `agent_session` for a native launch
// until something calls `ensureRunSession` — this proves it writes a
// row `resolveRunSessionId` (vendor's mail-routing lookup) actually
// reads back, only once the run is anchored with a principal, and stays
// idempotent (one insert, one collector) across repeated calls.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { resolveRunSessionId } from "@intx/hub-sessions";
import { dbGate } from "../../../scripts/e2e/db-gate";

import { ensureRunSession } from "../src/launch/agent-session";

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

describeIfDb("ensureRunSession", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const principalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const anchoredRunId = generateId("workflowRun");
  const unanchoredRunId = generateId("workflowRun");
  const sessionId = generateId("session");
  const domain = `agent-session-${tenantId}.localhost`;

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Agent Session Test Tenant",
      slug: `agent-session-${tenantId}`,
      domain,
      parentId: null,
      config: null,
    });

    await db.db.insert(schema.principal).values({
      id: principalId,
      tenantId,
      kind: "workflow",
      refId: anchoredRunId,
      status: "active",
    });

    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: principalId,
      assetId: null,
      name: "agent-session-test-definition",
    });

    // Anchored: has a principal, so `ensureRunSession` can insert its
    // `agent_session` row.
    await db.db.insert(schema.workflowRun).values({
      id: anchoredRunId,
      definitionId,
      anchorRunId: anchoredRunId,
      tenantId,
      principalId,
      address: `${anchoredRunId}@${domain}`,
      status: "running",
    });
    await db.db.insert(schema.workflowRunLaunchSpec).values({
      anchorRunId: anchoredRunId,
      sessionId,
      deploymentDomain: domain,
      sourceAuthorityPrincipalId: principalId,
      frozenApprovalBundle: {},
      sourceOfferingIds: [],
      defaultSourceOfferingId: "off_test",
      deployContent: { systemPrompt: "" },
    });

    // Unanchored: `prepareProvisionedDeployment` minted the row, but no
    // trigger has reconciled a principal onto it yet — the normal state
    // for a freshly provisioned invite.
    await db.db.insert(schema.workflowRun).values({
      id: unanchoredRunId,
      definitionId,
      anchorRunId: unanchoredRunId,
      tenantId,
      principalId: null,
      address: `${unanchoredRunId}@${domain}`,
      status: "running",
    });
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db
      .delete(schema.agentSession)
      .where(eq(schema.agentSession.id, sessionId));
    await db.db
      .delete(schema.workflowRunLaunchSpec)
      .where(eq(schema.workflowRunLaunchSpec.anchorRunId, anchoredRunId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, anchoredRunId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, unanchoredRunId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.id, principalId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  test("an unanchored run returns null and writes nothing", async () => {
    const createCalls: unknown[] = [];
    const resolved = await ensureRunSession({
      db: db.db,
      eventCollectors: {
        create: (...args: unknown[]) => {
          createCalls.push(args);
        },
        has: () => false,
      },
      runId: unanchoredRunId,
    });

    expect(resolved).toBeNull();
    expect(createCalls).toEqual([]);
    const sessionRow = await db.db.query.agentSession.findFirst({
      where: eq(schema.agentSession.agentId, definitionId),
    });
    expect(sessionRow).toBeUndefined();
  });

  test("an anchored run inserts its session and creates its collector once across two calls", async () => {
    const createCalls: unknown[] = [];
    let hasCollector = false;
    const eventCollectors = {
      create: (...args: unknown[]) => {
        createCalls.push(args);
        hasCollector = true;
      },
      has: () => hasCollector,
    };

    const first = await ensureRunSession({
      db: db.db,
      eventCollectors,
      runId: anchoredRunId,
    });
    const second = await ensureRunSession({
      db: db.db,
      eventCollectors,
      runId: anchoredRunId,
    });

    expect(first).toBe(sessionId);
    expect(second).toBe(sessionId);
    expect(createCalls).toEqual([
      [`${anchoredRunId}@${domain}`, tenantId, sessionId, anchoredRunId],
    ]);

    const resolved = await resolveRunSessionId(db.db, principalId);
    expect(resolved).toBe(sessionId);
  });
});
