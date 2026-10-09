// DB-gated. A run's first reply must reach the chat: its event collector has
// to exist before the first inference event, and its first outbound mail has
// to land in session_mail even though the agent_session is created mid-call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { createEventCollectorRegistry } from "@intx/hub-sessions";
import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";

import { createHubPersistMailWithSessionEnsure } from "../../apps/hub/src/mailbox-persist";
import {
  ensureRunSession,
  withLazyRunCollector,
} from "../../packages/workflows/src/launch/agent-session";

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

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("first reply of a run", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const userPrincipalId = generateId("principal");
  const runPrincipalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const runId = generateId("workflowRun");
  const domain = `first-reply-${tenantId}.localhost`;
  const sessionId = generateId("session");
  const unanchoredRunId = generateId("workflowRun");
  const unanchoredSessionId = generateId("session");
  const unanchoredAddress = `${unanchoredRunId}@${domain}`;
  const closedRunId = generateId("workflowRun");
  const closedSessionId = generateId("session");
  const closedAddress = `${closedRunId}@${domain}`;
  const doneRunId = generateId("workflowRun");
  const doneSessionId = generateId("session");
  const doneAddress = `${doneRunId}@${domain}`;
  const donePrincipalId = generateId("principal");
  const closedPrincipalId = generateId("principal");
  const runIds = [runId, unanchoredRunId, closedRunId, doneRunId];
  const sessionIds = [sessionId, unanchoredSessionId, closedSessionId, doneSessionId];
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
      { id: donePrincipalId, tenantId, kind: "workflow", refId: doneRunId, status: "active" },
      { id: closedPrincipalId, tenantId, kind: "workflow", refId: closedRunId, status: "active" },
    ]);
    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: userPrincipalId,
      assetId: null,
      name: "first-reply-test-definition",
    });
    const seedRun = async (
      id: string,
      session: string,
      principalId: string | null,
      runAddress: string,
    ) => {
      await db.db.insert(schema.workflowRun).values({
        id,
        definitionId,
        anchorRunId: id,
        tenantId,
        principalId,
        address: runAddress,
        status: "running",
      });
      await db.db.insert(schema.workflowRunLaunchSpec).values({
        anchorRunId: id,
        sessionId: session,
        deploymentDomain: domain,
        sourceAuthorityPrincipalId: userPrincipalId,
        frozenApprovalBundle: {},
        sourceOfferingIds: [],
        defaultSourceOfferingId: "off_test",
        deployContent: { systemPrompt: "" },
      });
    };
    await seedRun(runId, sessionId, runPrincipalId, address);
    await seedRun(unanchoredRunId, unanchoredSessionId, null, unanchoredAddress);
    await seedRun(doneRunId, doneSessionId, donePrincipalId, doneAddress);
    await seedRun(closedRunId, closedSessionId, closedPrincipalId, closedAddress);
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db.delete(schema.inferenceTurn).where(eq(schema.inferenceTurn.tenantId, tenantId));
    await db.db.delete(schema.agentSession).where(inArray(schema.agentSession.id, sessionIds));
    await db.db
      .delete(schema.workflowRunLaunchSpec)
      .where(inArray(schema.workflowRunLaunchSpec.anchorRunId, runIds));
    await db.db.delete(schema.workflowRun).where(inArray(schema.workflowRun.id, runIds));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(
        inArray(schema.principal.id, [
          runPrincipalId,
          closedPrincipalId,
          donePrincipalId,
          userPrincipalId,
        ]),
      );
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  async function waitFor(done: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 50 && !(await done()); i++) await Bun.sleep(20);
  }
  const start = (seq: number) => ({ type: "inference.start", seq, data: { model: "m" } }) as const;
  const turnsFor = (session: string) =>
    db.db.query.inferenceTurn.findMany({ where: eq(schema.inferenceTurn.sessionId, session) });

  test("persists the run's first turn although no collector existed yet", async () => {
    const lazy = withLazyRunCollector(createEventCollectorRegistry({ db: db.db }), db.db);

    lazy.dispatch(address, start(1));
    await Bun.sleep(300);

    expect(lazy.has(address)).toBe(true);
    expect(await turnsFor(sessionId)).toHaveLength(1);
  });

  test("creates no collector until the run has a session, then retries on the next event", async () => {
    const lazy = withLazyRunCollector(createEventCollectorRegistry({ db: db.db }), db.db);

    lazy.dispatch(unanchoredAddress, start(1));
    await Bun.sleep(300);
    expect(lazy.has(unanchoredAddress)).toBe(false);

    const [principal] = await db.db
      .insert(schema.principal)
      .values({
        id: generateId("principal"),
        tenantId,
        kind: "workflow",
        refId: unanchoredRunId,
        status: "active",
      })
      .returning();
    await db.db
      .update(schema.workflowRun)
      .set({ principalId: principal!.id })
      .where(eq(schema.workflowRun.id, unanchoredRunId));

    lazy.dispatch(unanchoredAddress, start(2));
    await Bun.sleep(300);
    expect(lazy.has(unanchoredAddress)).toBe(true);
    expect(await turnsFor(unanchoredSessionId)).toHaveLength(1);

    await db.db.delete(schema.inferenceTurn).where(eq(schema.inferenceTurn.tenantId, tenantId));
    await db.db.delete(schema.agentSession).where(eq(schema.agentSession.id, unanchoredSessionId));
    await db.db
      .update(schema.workflowRun)
      .set({ principalId: null })
      .where(eq(schema.workflowRun.id, unanchoredRunId));
    await db.db.delete(schema.principal).where(eq(schema.principal.id, principal!.id));
  });

  test("recreates the collector after an abandon so a reconnected run keeps persisting", async () => {
    const lazy = withLazyRunCollector(createEventCollectorRegistry({ db: db.db }), db.db);

    lazy.dispatch(closedAddress, start(1));
    await waitFor(() => lazy.has(closedAddress));
    lazy.abandon(closedAddress);
    lazy.dispatch(closedAddress, start(2));
    await waitFor(() => lazy.has(closedAddress));

    expect(lazy.has(closedAddress)).toBe(true);
    await waitFor(async () => (await turnsFor(closedSessionId)).length === 2);
    expect(await turnsFor(closedSessionId)).toHaveLength(2);
  });

  test("keeps the reply of a run whose done follows its start immediately", async () => {
    const lazy = withLazyRunCollector(createEventCollectorRegistry({ db: db.db }), db.db);

    lazy.dispatch(doneAddress, start(1));
    lazy.dispatch(doneAddress, { type: "reactor.done", seq: 2, data: {} });
    await waitFor(async () => (await turnsFor(doneSessionId)).length === 1);

    expect(await turnsFor(doneSessionId)).toHaveLength(1);
  });

  test("does not recreate the collector for mail after the run is done", async () => {
    const lazy = withLazyRunCollector(createEventCollectorRegistry({ db: db.db }), db.db);

    lazy.dispatch(doneAddress, start(3));
    lazy.dispatch(doneAddress, { type: "reactor.done", seq: 4, data: {} });
    await waitFor(async () => (await turnsFor(doneSessionId)).length === 2);
    await Bun.sleep(100);
    await ensureRunSession({ db: db.db, eventCollectors: lazy, runId: doneRunId });

    expect(lazy.has(doneAddress)).toBe(false);
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
