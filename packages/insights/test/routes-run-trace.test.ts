// DB-gated: skipped when no DATABASE_URL is reachable. Proves the mounted
// /runs/:runId/trace route — createInsightsRoutes wired with a real
// createDrizzleRunTraceReader, the same composition apps/hub/src/index.ts
// uses — returns real spans read off the platform's own workflow_run /
// inference_turn / turn_part tables, not the "reader not mounted" absent
// envelope. trace-reader.test.ts already proves the reader function itself
// in isolation; this proves the HTTP route built on top of it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createInsightsRoutes } from "../src/routes";
import { createDrizzleRunTraceReader } from "../src/trace-reader";
import { createMemoryUsageStore } from "../src/store";
import type { RunTrace } from "../src/queries";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_insights_routes_run_trace_test`;
  return url.toString();
}

// Parse DATABASE_URL the same way the hub does (apps/hub/src/index.ts): an
// empty user falls through to the postgres client's OS-username default.
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

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

describeIfDb("createInsightsRoutes /runs/:runId/trace", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const tenantId = generateId("tenant");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }

    // The same path the hub boots with: the platform's own migrations,
    // then every installed package's.
    await setupDatabase(scratchUrl);

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      await db.insert(schema.tenant).values({
        id: tenantId,
        name: `Insights Routes Trace Test ${tenantId}`,
        slug: `insights-routes-trace-${tenantId}`,
        domain: `insights-routes-trace-${tenantId}.localhost`,
      });
    } finally {
      await close();
    }
    // `setupDatabase` applies the platform's migrations plus every
    // installed package's; under `bun run test`'s cross-package
    // concurrency that comfortably exceeds bun:test's default 5s hook
    // timeout, so it gets an explicit one here rather than a flaky suite.
  }, 30000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  });

  test("returns real spans with correct timingSource for a completed run", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const definitionId = generateId("workflowDefinition");
      const runId = generateId("workflowRun");
      const turnId = generateId("inferenceTurn");
      const sessionId = generateId("session");
      const principalId = generateId("principal");

      const startedAt = new Date("2026-08-01T00:00:00.000Z");
      const endedAt = new Date("2026-08-01T00:00:05.000Z");

      await db.insert(schema.workflowDefinition).values({
        id: definitionId,
        tenantId,
        name: "Echo workflow",
      });
      await db.insert(schema.workflowRun).values({
        id: runId,
        definitionId,
        tenantId,
        status: "completed",
        createdAt: startedAt,
      });
      await db.insert(schema.principal).values({
        id: principalId,
        tenantId,
        kind: "agent",
        refId: "not-a-real-agent-instance",
        status: "active",
      });
      await db.insert(schema.agentSession).values({
        id: sessionId,
        tenantId,
        agentId: definitionId,
        principalId,
        status: "active",
      });
      await db.insert(schema.inferenceTurn).values({
        id: turnId,
        sessionId,
        runId,
        tenantId,
        model: "noop-model",
        status: "completed",
        startedAt,
        endedAt,
      });
      await db.insert(schema.turnPart).values({
        id: generateId("turnPart"),
        turnId,
        sessionId,
        type: "tool",
        content: null,
        metadata: {
          kind: "call",
          callId: "call-1",
          name: "echo",
          arguments: { message: "hi" },
        },
        ordinal: 1,
      });

      const routes = createInsightsRoutes({
        store: createMemoryUsageStore(),
        requireGrant: allowAll,
        runTraceReader: createDrizzleRunTraceReader(db),
      });
      const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
        c.set("tenant", { id: tenantId } as never);
        c.set("principal", { id: principalId } as never);
        await next();
      };
      const app = new Hono<TenantEnv>();
      app.use("*", asTenant);
      app.route("/", routes);

      const response = await app.request(`/runs/${runId}/trace`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as RunTrace;
      expect(body.runId).toBe(runId);
      expect("absent" in body).toBe(false);
      expect(body.spans).not.toBeNull();

      const spans = body.spans ?? [];
      const turnSpan = spans.find((s) => s.kind === "turn");
      expect(turnSpan).toMatchObject({
        id: turnId,
        phase: "ok",
        durationMs: 5000,
        timingSource: "measured",
      });

      const toolSpan = spans.find((s) => s.kind === "tool");
      expect(toolSpan).toMatchObject({
        label: "echo",
        timingSource: "ordinal",
      });
    } finally {
      await close();
    }
  }, 30000);
});
