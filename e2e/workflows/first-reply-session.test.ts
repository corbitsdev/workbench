// DB-gated. A run's first reply must reach the chat: its event collector has
// to exist before the first inference event, and its first outbound mail has
// to land in session_mail even though the agent_session is created mid-call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { EventCollectorRegistry } from "@intx/hub-sessions";
import { dbGate } from "../lib/db-gate";

import { createHubPersistMailWithSessionEnsure } from "../../apps/hub/src/mailbox-persist";
import { withLazyRunCollector } from "../../packages/workflows/src/launch/agent-session";

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

type Registry = Pick<EventCollectorRegistry, "create" | "has" | "dispatch">;

describeIfDb("first reply of a run", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const userPrincipalId = generateId("principal");
  const runPrincipalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const runId = generateId("workflowRun");
  const sessionId = generateId("session");
  const domain = `first-reply-${tenantId}.localhost`;
  const address = `${runId}@${domain}`;

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "First Reply Test Tenant",
      slug: `first-reply-${tenantId.replaceAll("_", "-")}`,
      domain,
      parentId: null,
      config: null,
    });
    await db.db.insert(schema.principal).values([
      { id: userPrincipalId, tenantId, kind: "user", refId: "usr_test", status: "active" },
      { id: runPrincipalId, tenantId, kind: "workflow", refId: runId, status: "active" },
    ]);
    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: userPrincipalId,
      assetId: null,
      name: "first-reply-test-definition",
    });
    await db.db.insert(schema.workflowRun).values({
      id: runId,
      definitionId,
      anchorRunId: runId,
      tenantId,
      principalId: runPrincipalId,
      address,
      status: "running",
    });
    await db.db.insert(schema.workflowRunLaunchSpec).values({
      anchorRunId: runId,
      sessionId,
      deploymentDomain: domain,
      sourceAuthorityPrincipalId: userPrincipalId,
      frozenApprovalBundle: {},
      sourceOfferingIds: [],
      defaultSourceOfferingId: "off_test",
      deployContent: { systemPrompt: "" },
    });
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db.delete(schema.agentSession).where(eq(schema.agentSession.id, sessionId));
    await db.db
      .delete(schema.workflowRunLaunchSpec)
      .where(eq(schema.workflowRunLaunchSpec.anchorRunId, runId));
    await db.db.delete(schema.workflowRun).where(eq(schema.workflowRun.id, runId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(inArray(schema.principal.id, [runPrincipalId, userPrincipalId]));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  test("creates the collector before dispatching the run's first event, in order", async () => {
    const collectors = new Set<string>();
    const dispatched: string[] = [];
    const registry: Registry = {
      has: (a) => collectors.has(a),
      create: (a) => {
        collectors.add(a);
        dispatched.push("create");
      },
      dispatch: (a, event) => {
        if (!collectors.has(a)) return;
        dispatched.push(event.type);
      },
    };
    const lazy = withLazyRunCollector(registry, db.db);

    lazy.dispatch(address, { type: "custom.first", seq: 1, data: {} });
    lazy.dispatch(address, { type: "custom.second", seq: 2, data: {} });
    await Bun.sleep(200);

    expect(dispatched).toEqual(["create", "custom.first", "custom.second"]);
  });

  test("persists the run's first outbound mail although its session is created mid-call", async () => {
    await db.db.delete(schema.agentSession).where(eq(schema.agentSession.id, sessionId));
    const upstreamCalls: unknown[] = [];
    const persist = createHubPersistMailWithSessionEnsure(
      db.db,
      { current: { create: () => {}, has: () => true } },
      async (args) => {
        upstreamCalls.push(args);
        return [];
      },
    );

    await persist({ senderAddress: address } as Parameters<typeof persist>[0]);

    expect(upstreamCalls).toHaveLength(1);
  });
});
