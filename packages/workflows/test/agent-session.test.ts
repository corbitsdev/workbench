// DB-gated: skipped when DATABASE_URL is unreachable, matching this
// repo's convention for tests that talk to a real Postgres (see
// `packages/access-tools/test/routes.test.ts`).
//
// CL-7477: before this fix, nothing wrote `agent_session` for a native
// launch, so `resolveRunSessionId` (vendor's mail-routing lookup) could
// never find a session for a run's principal and every launch's first
// turn failed to persist mail. This proves `recordAgentSessionForRun`
// writes a row `resolveRunSessionId` actually reads back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { resolveRunSessionId } from "@intx/hub-sessions";
import { dbGate } from "../../../scripts/e2e/db-gate";

import { recordAgentSessionForRun } from "../src/launch/agent-session";

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

describeIfDb("recordAgentSessionForRun", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const principalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const anchorRunId = generateId("workflowRun");
  const sessionId = generateId("session");

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Agent Session Test Tenant",
      slug: `agent-session-${tenantId}`,
      domain: `agent-session-${tenantId}.localhost`,
      parentId: null,
      config: null,
    });

    await db.db.insert(schema.principal).values({
      id: principalId,
      tenantId,
      kind: "workflow",
      refId: anchorRunId,
      status: "active",
    });

    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: principalId,
      assetId: null,
      name: "agent-session-test-definition",
    });

    await db.db.insert(schema.workflowRun).values({
      id: anchorRunId,
      definitionId,
      anchorRunId,
      tenantId,
      principalId,
      address: `${anchorRunId}@agent-session-${tenantId}.localhost`,
      status: "running",
    });
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db
      .delete(schema.agentSession)
      .where(eq(schema.agentSession.id, sessionId));
    await db.db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.id, anchorRunId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(eq(schema.principal.id, principalId));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  test("writes an agent_session resolveRunSessionId reads back", async () => {
    await recordAgentSessionForRun(db.db, { sessionId, anchorRunId });

    const resolved = await resolveRunSessionId(db.db, principalId);
    expect(resolved).toBe(sessionId);
  });
});
