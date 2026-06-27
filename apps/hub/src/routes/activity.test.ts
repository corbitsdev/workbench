import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

import { createActivityRouter } from "./activity";

type ActivityRouteEnv = {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
    db: unknown;
  };
};

const overviewPayload = {
  tenantId: "tnt_test",
  range: { startDate: "2026-06-16" },
  artifacts: {
    total: 0,
    createdInRange: 0,
    byStatus: [],
    byKind: [],
  },
  workflowRuns: {
    executionRecords: 0,
    executionsStartedInRange: 0,
    activeExecutions: 0,
    byStatus: [],
    byKind: [],
    deploymentsIndexed: 0,
  },
  agentInstances: { active: 0, startedInRange: 0, endedInRange: 0, total: 0 },
  inference: {
    summary: {
      tenantId: "tnt_test",
      turnCount: 0,
      failedTurnCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    byAgent: [],
    byInstance: [],
  },
};

let lastArgs: { tenantId?: string; callerPrincipalId?: string | null } = {};
mock.module("../services/activity-overview", () => ({
  getActivityOverview: mock(
    async (args: { tenantId: string; callerPrincipalId?: string | null }) => {
      lastArgs = args;
      return overviewPayload;
    },
  ),
}));

describe("GET /overview", () => {
  it("accepts startDate without endDate (Insights preset ranges)", async () => {
    const hub = new Hono<ActivityRouteEnv>();
    hub.use("/api/tenants/:tenantId/activity/*", async (c, next) => {
      c.set("tenant", { id: "tnt_test" });
      c.set("principal", { id: "pri_1" });
      await next();
    });

    hub.route(
      "/api/tenants/:tenantId/activity",
      createActivityRouter({ db: {} as never }),
    );

    const res = await hub.request(
      "http://localhost/api/tenants/tnt_test/activity/overview?startDate=2026-06-16",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string };
    expect(body.tenantId).toBe("tnt_test");
  });

  it("threads the caller's principal id into the overview for self-marking", async () => {
    const hub = new Hono<ActivityRouteEnv>();
    hub.use("/api/tenants/:tenantId/activity/*", async (c, next) => {
      c.set("tenant", { id: "tnt_test" });
      c.set("principal", { id: "pri_caller" });
      await next();
    });
    hub.route(
      "/api/tenants/:tenantId/activity",
      createActivityRouter({ db: {} as never }),
    );

    const res = await hub.request(
      "http://localhost/api/tenants/tnt_test/activity/overview",
    );
    expect(res.status).toBe(200);
    expect(lastArgs.callerPrincipalId).toBe("pri_caller");
  });
});
