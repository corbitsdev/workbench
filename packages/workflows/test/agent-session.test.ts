// DB-gated: skipped when DATABASE_URL is unreachable, matching this
// repo's convention for tests that talk to a real Postgres (see
// `packages/access-tools/test/routes.test.ts`).
//
// CL-7481: `recordAgentSessionAtProvision` is the eager write every
// native launcher makes right after `prepareProvisionedDeployment`
// returns — this proves it lands the `agent_session` row under the
// *deploying* principal (the run's own principal does not exist yet)
// and creates the run's event collector exactly once, idempotently.
// `ensureRunSession` is now purely a re-key: once the run's first
// trigger anchors a real principal onto it, this proves the session
// moves onto that principal without ever touching the session id, and
// that a run with no launch spec row is a bug this throws on rather
// than papering over.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { resolveRunSessionId } from "@intx/hub-sessions";
import { dbGate } from "../../../scripts/e2e/db-gate";

import {
  ensureRunSession,
  recordAgentSessionAtProvision,
} from "../src/launch/agent-session";

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

describeIfDb("recordAgentSessionAtProvision / ensureRunSession", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const deployingPrincipalId = generateId("principal");
  const runPrincipalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const provisionedRunId = generateId("workflowRun");
  const noLaunchSpecRunId = generateId("workflowRun");
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

    await db.db.insert(schema.principal).values([
      {
        id: deployingPrincipalId,
        tenantId,
        kind: "user",
        refId: "usr_test",
        status: "active",
      },
      {
        id: runPrincipalId,
        tenantId,
        kind: "workflow",
        refId: provisionedRunId,
        status: "active",
      },
    ]);

    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: deployingPrincipalId,
      assetId: null,
      name: "agent-session-test-definition",
    });

    // Born the instant `prepareProvisionedDeployment` returns: a run row
    // exists, its own principal is still null, and its launch spec names
    // the session `recordAgentSessionAtProvision` will record.
    await db.db.insert(schema.workflowRun).values({
      id: provisionedRunId,
      definitionId,
      anchorRunId: provisionedRunId,
      tenantId,
      principalId: null,
      address: `${provisionedRunId}@${domain}`,
      status: "deployed",
    });
    await db.db.insert(schema.workflowRunLaunchSpec).values({
      anchorRunId: provisionedRunId,
      sessionId,
      deploymentDomain: domain,
      sourceAuthorityPrincipalId: deployingPrincipalId,
      frozenApprovalBundle: {},
      sourceOfferingIds: [],
      defaultSourceOfferingId: "off_test",
      deployContent: { systemPrompt: "" },
    });

    // A run with no launch spec row at all: a launcher that skipped the
    // shared provisioning path — a bug `ensureRunSession` must surface,
    // not silently no-op past.
    await db.db.insert(schema.workflowRun).values({
      id: noLaunchSpecRunId,
      definitionId,
      anchorRunId: noLaunchSpecRunId,
      tenantId,
      principalId: null,
      address: `${noLaunchSpecRunId}@${domain}`,
      status: "deployed",
    });
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db
      .delete(schema.agentSession)
      .where(eq(schema.agentSession.id, sessionId));
    await db.db
      .delete(schema.workflowRunLaunchSpec)
      .where(eq(schema.workflowRunLaunchSpec.anchorRunId, provisionedRunId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, provisionedRunId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, noLaunchSpecRunId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.id, runPrincipalId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.id, deployingPrincipalId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  test("records the session under the deploying principal and creates the collector once", async () => {
    const createCalls: unknown[] = [];
    let hasCollector = false;
    const eventCollectors = {
      create: (...args: unknown[]) => {
        createCalls.push(args);
        hasCollector = true;
      },
      has: () => hasCollector,
    };

    await recordAgentSessionAtProvision({
      db: db.db,
      eventCollectors,
      runId: provisionedRunId,
      sessionId,
      sourceAuthorityPrincipalId: deployingPrincipalId,
    });
    // A second call for the same run is a no-op, not a conflict, and
    // must not create a second collector.
    await recordAgentSessionAtProvision({
      db: db.db,
      eventCollectors,
      runId: provisionedRunId,
      sessionId,
      sourceAuthorityPrincipalId: deployingPrincipalId,
    });

    expect(createCalls).toEqual([
      [`${provisionedRunId}@${domain}`, tenantId, sessionId, provisionedRunId],
    ]);

    const sessionRow = await db.db.query.agentSession.findFirst({
      where: eq(schema.agentSession.id, sessionId),
    });
    expect(sessionRow?.principalId).toBe(deployingPrincipalId);
    expect(sessionRow?.agentId).toBe(definitionId);
  });

  test("re-keys the session onto the run principal once Interchange anchors it", async () => {
    await db.db
      .update(schema.workflowRun)
      .set({ principalId: runPrincipalId, status: "running" })
      .where(eq(schema.workflowRun.id, provisionedRunId));

    const resolved = await ensureRunSession({
      db: db.db,
      eventCollectors: { create: () => {}, has: () => true },
      runId: provisionedRunId,
    });

    expect(resolved).toBe(sessionId);
    const sessionRow = await db.db.query.agentSession.findFirst({
      where: eq(schema.agentSession.id, sessionId),
    });
    expect(sessionRow?.principalId).toBe(runPrincipalId);

    // Interchange's own mail-routing lookup now finds the session by the
    // run's own principal, exactly as it would for a folded run.
    const viaVendorLookup = await resolveRunSessionId(db.db, runPrincipalId);
    expect(viaVendorLookup).toBe(sessionId);
  });

  test("throws for a run with no launch spec row", async () => {
    await expect(
      ensureRunSession({
        db: db.db,
        eventCollectors: { create: () => {}, has: () => false },
        runId: noLaunchSpecRunId,
      }),
    ).rejects.toThrow(/no workflow_run_launch_spec/);
  });
});
