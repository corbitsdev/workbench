// DB-gated: skipped when no DATABASE_URL is reachable. Proves
// createDrizzleRunTraceReader reads real rows back off the platform's own
// workflow_run / workflow_run_execution / inference_turn / turn_part
// tables — the same rows apps/hub/src/routine-run-summary.ts and
// @intx/hub-sessions' event-collector already read and write — rather than
// a re-parsed git log or a fabricated trace. Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createDrizzleRunTraceReader } from "../src/trace-reader";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_insights_trace_reader_test`;
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

describeIfDb("createDrizzleRunTraceReader", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const tenantId = generateId("tenant");
  const otherTenantId = generateId("tenant");

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
      for (const id of [tenantId, otherTenantId]) {
        await db.insert(schema.tenant).values({
          id,
          name: `Trace Reader Test ${id}`,
          slug: `trace-reader-${id}`,
          domain: `trace-reader-${id}.localhost`,
        });
      }
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

  test("a run with no workflow_run row reads as absent, never an empty trace", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const reader = createDrizzleRunTraceReader(db);
      const trace = await reader.getTrace(tenantId, generateId("workflowRun"));
      expect(trace).toBeNull();
    } finally {
      await close();
    }
  });

  test("a run in another tenant reads as absent", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const definitionId = generateId("workflowDefinition");
      const runId = generateId("workflowRun");
      await db.insert(schema.workflowDefinition).values({
        id: definitionId,
        tenantId: otherTenantId,
        name: "Other tenant's workflow",
      });
      await db.insert(schema.workflowRun).values({
        id: runId,
        definitionId,
        tenantId: otherTenantId,
        status: "completed",
      });

      const reader = createDrizzleRunTraceReader(db);
      const trace = await reader.getTrace(tenantId, runId);
      expect(trace).toBeNull();
    } finally {
      await close();
    }
  });

  test("a run that exists but never executed reads as an empty (not absent) trace", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const definitionId = generateId("workflowDefinition");
      const runId = generateId("workflowRun");
      await db.insert(schema.workflowDefinition).values({
        id: definitionId,
        tenantId,
        name: "Deployed, never triggered",
      });
      await db.insert(schema.workflowRun).values({
        id: runId,
        definitionId,
        tenantId,
        status: "deployed",
      });

      const reader = createDrizzleRunTraceReader(db);
      const trace = await reader.getTrace(tenantId, runId);
      expect(trace).not.toBeNull();
      expect(trace?.spans).toEqual([]);
    } finally {
      await close();
    }
  });

  test("returns turn spans with real timing, plus tool-call and error sub-spans from turn_part", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const definitionId = generateId("workflowDefinition");
      const runId = generateId("workflowRun");
      const turnId = generateId("inferenceTurn");
      const sessionId = generateId("session");

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
        status: "running",
        createdAt: startedAt,
      });
      const principalId = generateId("principal");
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
      await db.insert(schema.turnPart).values([
        {
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
        },
        {
          id: generateId("turnPart"),
          turnId,
          sessionId,
          type: "tool",
          content: null,
          metadata: {
            kind: "result",
            callId: "call-1",
            content: "hi",
            isError: false,
          },
          ordinal: 2,
        },
        {
          id: generateId("turnPart"),
          turnId,
          sessionId,
          type: "error",
          content: "boom",
          metadata: { category: "reactor_error" },
          ordinal: 3,
        },
      ]);

      const reader = createDrizzleRunTraceReader(db);
      const trace = await reader.getTrace(tenantId, runId);
      expect(trace).not.toBeNull();
      expect(trace?.runId).toBe(runId);

      const turnSpan = trace?.spans.find((s) => s.kind === "turn");
      expect(turnSpan).toMatchObject({
        id: turnId,
        label: "Turn 1",
        phase: "ok",
        durationMs: 5000,
        error: null,
        timingSource: "measured",
      });
      expect(turnSpan?.start).toBe(startedAt.getTime());
      expect(turnSpan?.end).toBe(endedAt.getTime());

      const toolSpan = trace?.spans.find((s) => s.kind === "tool");
      expect(toolSpan).toMatchObject({
        label: "echo",
        phase: "ok",
        error: null,
        // Documented gap: authz verdicts are not reachable from the
        // hub's Postgres-only composition root today.
        authz: null,
        timingSource: "ordinal",
      });

      const errorSpan = trace?.spans.find((s) => s.kind === "error");
      expect(errorSpan).toMatchObject({
        phase: "failed",
        error: "boom",
        timingSource: "ordinal",
      });
    } finally {
      await close();
    }
  });

  test("batches turn_part reads across turns without cross-turn bleeding", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const definitionId = generateId("workflowDefinition");
      const runId = generateId("workflowRun");
      const sessionId = generateId("session");
      const firstTurnId = generateId("inferenceTurn");
      const secondTurnId = generateId("inferenceTurn");

      const firstStart = new Date("2026-08-02T00:00:00.000Z");
      const firstEnd = new Date("2026-08-02T00:00:05.000Z");
      const secondStart = new Date("2026-08-02T00:00:10.000Z");
      const secondEnd = new Date("2026-08-02T00:00:15.000Z");

      await db.insert(schema.workflowDefinition).values({
        id: definitionId,
        tenantId,
        name: "Two-turn workflow",
      });
      await db.insert(schema.workflowRun).values({
        id: runId,
        definitionId,
        tenantId,
        status: "running",
        createdAt: firstStart,
      });
      const principalId = generateId("principal");
      await db.insert(schema.principal).values({
        id: principalId,
        tenantId,
        kind: "agent",
        refId: "not-a-real-agent-instance-batching",
        status: "active",
      });
      await db.insert(schema.agentSession).values({
        id: sessionId,
        tenantId,
        agentId: definitionId,
        principalId,
        status: "active",
      });
      await db.insert(schema.inferenceTurn).values([
        {
          id: firstTurnId,
          sessionId,
          runId,
          tenantId,
          model: "noop-model",
          status: "completed",
          startedAt: firstStart,
          endedAt: firstEnd,
        },
        {
          id: secondTurnId,
          sessionId,
          runId,
          tenantId,
          model: "noop-model",
          status: "completed",
          startedAt: secondStart,
          endedAt: secondEnd,
        },
      ]);
      await db.insert(schema.turnPart).values([
        {
          id: generateId("turnPart"),
          turnId: firstTurnId,
          sessionId,
          type: "tool",
          content: null,
          metadata: {
            kind: "call",
            callId: "first-call",
            name: "first-tool",
            arguments: {},
          },
          ordinal: 2,
        },
        {
          id: generateId("turnPart"),
          turnId: firstTurnId,
          sessionId,
          type: "tool",
          content: null,
          metadata: {
            kind: "result",
            callId: "first-call",
            content: "ok",
            isError: false,
          },
          ordinal: 1,
        },
        {
          id: generateId("turnPart"),
          turnId: secondTurnId,
          sessionId,
          type: "tool",
          content: null,
          metadata: {
            kind: "call",
            callId: "second-call",
            name: "second-tool",
            arguments: {},
          },
          ordinal: 1,
        },
        {
          id: generateId("turnPart"),
          turnId: secondTurnId,
          sessionId,
          type: "tool",
          content: null,
          metadata: {
            kind: "result",
            callId: "second-call",
            content: "ok",
            isError: false,
          },
          ordinal: 2,
        },
      ]);

      const reader = createDrizzleRunTraceReader(db);
      const trace = await reader.getTrace(tenantId, runId);
      expect(trace).not.toBeNull();

      const toolSpans = trace?.spans.filter((s) => s.kind === "tool") ?? [];
      expect(toolSpans).toHaveLength(2);

      const firstToolSpan = toolSpans.find((s) => s.label === "first-tool");
      const secondToolSpan = toolSpans.find((s) => s.label === "second-tool");
      expect(firstToolSpan).toMatchObject({ phase: "ok" });
      expect(secondToolSpan).toMatchObject({ phase: "ok" });

      // Each tool span is positioned within its own turn's window, never
      // bleeding into the other turn's [start, end] range.
      expect(firstToolSpan?.start).toBeGreaterThanOrEqual(firstStart.getTime());
      expect(firstToolSpan?.start).toBeLessThanOrEqual(firstEnd.getTime());
      expect(secondToolSpan?.start).toBeGreaterThanOrEqual(
        secondStart.getTime(),
      );
      expect(secondToolSpan?.start).toBeLessThanOrEqual(secondEnd.getTime());
    } finally {
      await close();
    }
  });
});
