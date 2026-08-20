// The /runs/:runId/trace lookup fires on every run-detail open, so both
// "no reader mounted" and "no recorded trace" are normal states that must
// answer the absent envelope with 200 — never a 404 the client cannot
// tell apart from a broken path. routes-run-trace.test.ts (DB-gated)
// proves the present-trace path against real tables.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { createInsightsRoutes } from "./routes";
import { createMemoryUsageStore } from "./store";

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

function mount(runTraceReader?: {
  getTrace: (tenantId: string, runId: string) => Promise<null>;
}): Hono<TenantEnv> {
  const routes = createInsightsRoutes({
    store: createMemoryUsageStore(),
    requireGrant: allowAll,
    ...(runTraceReader !== undefined ? { runTraceReader } : {}),
  });
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", { id: "tnt_1" } as never);
    c.set("principal", { id: "prn_1" } as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

describe("GET /runs/:runId/trace absent envelopes", () => {
  test("answers 200 with absent when no reader is mounted", async () => {
    const response = await mount().request("/runs/run_1/trace");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      spans: unknown;
      absent: string;
    };
    expect(body.runId).toBe("run_1");
    expect(body.spans).toBeNull();
    expect(body.absent).toBe("run_trace_reader_not_mounted");
  });

  test("answers 200 with absent when the run has no recorded trace", async () => {
    const app = mount({ getTrace: async () => null });
    const response = await app.request("/runs/run_1/trace");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      spans: unknown;
      absent: string;
    };
    expect(body.runId).toBe("run_1");
    expect(body.spans).toBeNull();
    expect(body.absent).toBe("trace_not_recorded");
  });
});
