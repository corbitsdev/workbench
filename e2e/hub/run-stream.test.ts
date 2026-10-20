// DB-gated: verifies `GET /api/tenants/:tenantId/workflows/runs/:runId/stream`
// gates on auth/grant, tenant-scopes the run lookup against real Postgres rows,
// and forwards validated `InferenceEvent` frames over SSE while ignoring
// non-InferenceEvent payloads.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDB, createGrantStore, dropSchema, runMigrations } from "@intx/db";
import { grant, principal, tenant, workflowDefinition, workflowRun } from "@intx/db/schema";
import { createRequireGrant, createResolveTenant, type TenantEnv } from "@intx/hub-api";
import { createSidecarRouter } from "@intx/hub-sessions";
import type { InferenceEvent } from "@intx/types/runtime";
import { createWorkflowRunStreamRoutes } from "../../apps/hub/src/run-stream";
import { dbGate } from "../lib/db-gate";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);

describeIfDb("workflow run SSE stream", () => {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgres://x@localhost/x");
  const config = {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    schema: `run_stream_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
  const handle = createDB(config);
  const { db } = handle;
  const suffix = crypto.randomUUID().slice(0, 8);

  const tenantId = `tnt_stream_${suffix}`;
  const otherTenantId = `tnt_other_${suffix}`;
  const userId = `usr_stream_${suffix}`;
  const principalId = `prn_stream_${suffix}`;
  const definitionId = `def_stream_${suffix}`;
  const runId = `run_stream_${suffix}`;
  const otherRunId = `run_other_${suffix}`;
  const runAddress = `${runId}@stream-${suffix}.test`;

  const sidecarRouter = createSidecarRouter({
    authenticateSidecar: async () => null,
    validateSidecarIdentity: async () => false,
    withExecutableWorkflowRun: async () => false,
    resolveSidecarBindings: async () => [],
  });

  const now = new Date();
  const app = new Hono<TenantEnv>();
  app.use("/api/tenants/:tenantId/*", async (c, next) => {
    const authUser = c.req.header("x-test-user-id");
    c.set(
      "user",
      authUser !== undefined && authUser !== ""
        ? {
            id: authUser,
            email: "person@stream.test",
            name: "Person",
            emailVerified: true,
            image: null,
            createdAt: now,
            updatedAt: now,
          }
        : null,
    );
    await next();
  });
  app.use("/api/tenants/:tenantId/*", createResolveTenant({ db }));
  app.route(
    "/api/tenants/:tenantId",
    createWorkflowRunStreamRoutes({
      db,
      sidecarRouter,
      requireGrant: createRequireGrant({
        grantStore: createGrantStore(db),
        conditionRegistry: {},
      }),
    }),
  );

  beforeAll(async () => {
    await runMigrations(config, { schema: config.schema });
    await db.insert(tenant).values([
      {
        id: tenantId,
        name: "Stream Tenant",
        slug: `stream-${suffix}`,
        domain: `stream-${suffix}.test`,
      },
      {
        id: otherTenantId,
        name: "Other Tenant",
        slug: `other-${suffix}`,
        domain: `other-${suffix}.test`,
      },
    ]);
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: userId,
      status: "active",
    });
    await db.insert(grant).values({
      id: `grt_stream_${suffix}`,
      tenantId,
      principalId,
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
      origin: "system",
    });
    await db.insert(workflowDefinition).values([
      { id: definitionId, tenantId, name: "worker" },
      { id: `def_other_${suffix}`, tenantId: otherTenantId, name: "worker" },
    ]);
    await db.insert(workflowRun).values([
      {
        id: runId,
        definitionId,
        anchorRunId: runId,
        tenantId,
        principalId: null,
        address: runAddress,
        status: "running",
      },
      {
        id: otherRunId,
        definitionId: `def_other_${suffix}`,
        anchorRunId: otherRunId,
        tenantId: otherTenantId,
        principalId: null,
        address: `${otherRunId}@other-${suffix}.test`,
        status: "running",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await handle.close();
    await dropSchema(config, { schema: config.schema });
  }, 60_000);

  test("rejects unauthenticated requests with 401 and unknown/cross-tenant runs with 404", async () => {
    const unauth = await app.request(`/api/tenants/${tenantId}/workflows/runs/${runId}/stream`);
    expect(unauth.status).toBe(401);

    const missing = await app.request(
      `/api/tenants/${tenantId}/workflows/runs/run_missing_${suffix}/stream`,
      { headers: { "x-test-user-id": userId } },
    );
    expect(missing.status).toBe(404);

    const crossTenant = await app.request(
      `/api/tenants/${tenantId}/workflows/runs/${otherRunId}/stream`,
      { headers: { "x-test-user-id": userId } },
    );
    expect(crossTenant.status).toBe(404);
  });

  test("streams live InferenceEvent frames as SSE `run` events and filters non-InferenceEvents", async () => {
    const abort = new AbortController();
    const res = await app.request(`/api/tenants/${tenantId}/workflows/runs/${runId}/stream`, {
      headers: { "x-test-user-id": userId },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const startEvent: InferenceEvent = {
      type: "inference.start",
      seq: 1,
      data: { model: "claude-sonnet-4-6" },
    };
    const deltaEvent: InferenceEvent = {
      type: "inference.text.delta",
      seq: 2,
      data: { token: "Hello", partial: { text: "Hello" } },
    };

    sidecarRouter.dispatchAgentEvent(runAddress, {
      type: "turn.committed",
      data: { turnId: "t1" },
    });
    sidecarRouter.dispatchAgentEvent(runAddress, startEvent);
    sidecarRouter.dispatchAgentEvent(runAddress, deltaEvent);

    let buffer = "";
    const received: unknown[] = [];
    while (received.length < 2) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const lines = block.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event:"));
        const dataLine = lines.find((line) => line.startsWith("data:"));
        if (eventLine?.slice("event:".length).trim() === "run" && dataLine !== undefined) {
          received.push(JSON.parse(dataLine.slice("data:".length).trim()));
        }
      }
    }

    abort.abort();
    await reader.cancel();
    expect(received).toEqual([startEvent, deltaEvent]);
  });
});
