import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

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
  agentActivity: { active: 0, idle: 0 },
  conversations: { total: 0, createdInRange: 0 },
  messages: { total: 0, createdInRange: 0 },
  dailySeries: [],
  metricsBucket: "week",
  metricsSeries: [
    {
      bucketStart: "2026-06-16",
      agentsDeployed: 1,
      agentsActive: 0,
      tokensSpent: 10,
      artifactsCreated: 0,
    },
  ],
  models: [],
  byModel: [],
  tokensRecordedFrom: null,
  byPerson: [],
  byWorkflowType: [],
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
    previousSummary: null,
    byAgent: [],
    byInstance: [],
  },
};

let lastArgs: { tenantId?: string; callerPrincipalId?: string | null } = {};
mock.module("../lib/pricing", () => ({
  loadPriceCatalog: mock(async () => ({
    source: "test",
    generatedAt: "2026-01-01",
    models: {},
    qualified: {},
    ambiguous: [],
  })),
}));
mock.module("../services/offering-providers-by-model", () => ({
  getOfferingProvidersByModel: mock(async () => ({})),
}));
mock.module("../services/activity-overview", () => ({
  getActivityOverview: mock(
    async (args: { tenantId: string; callerPrincipalId?: string | null }) => {
      lastArgs = args;
      return overviewPayload;
    },
  ),
}));

const { createActivityRouter } = await import("./activity");

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

describe("GET /export.csv", () => {
  function mountRouter() {
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
    return hub;
  }

  it("returns CSV with attachment headers when metrics exist", async () => {
    const hub = mountRouter();
    const res = await hub.request(
      "http://localhost/api/tenants/tnt_test/activity/export.csv?bucket=week",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="insights-week-',
    );
    const text = await res.text();
    expect(text).toContain("[metrics_series]");
    expect(text).toContain("[by_person]");
  });

  it("returns 404 when there is no metrics series to export", async () => {
    overviewPayload.metricsSeries = [];
    try {
      const hub = mountRouter();
      const res = await hub.request(
        "http://localhost/api/tenants/tnt_test/activity/export.csv",
      );
      expect(res.status).toBe(404);
    } finally {
      overviewPayload.metricsSeries = [
        {
          bucketStart: "2026-06-16",
          agentsDeployed: 1,
          agentsActive: 0,
          tokensSpent: 10,
          artifactsCreated: 0,
        },
      ];
    }
  });
});