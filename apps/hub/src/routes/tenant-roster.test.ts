import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

type RouteEnv = {
  Variables: {
    tenant: { id: string };
  };
};

const sampleRoster = {
  instances: [
    {
      instanceId: "ins-1",
      principalId: "prn-syn-1",
      name: "Myra",
      status: "running",
      sessionCount: 3,
    },
  ],
  runs: [{ runId: "run-1", kind: "last30days", status: "completed" }],
};

let serviceCalls: unknown[] = [];
let serviceResult: unknown = sampleRoster;
let serviceError: Error | null = null;
mock.module("../services/principal-roster", () => ({
  RosterInstanceSchema: { array: () => ({}) },
  RosterRunSchema: { array: () => ({}) },
  getTenantRoster: mock(async (args: unknown) => {
    serviceCalls.push(args);
    if (serviceError) throw serviceError;
    return serviceResult;
  }),
}));

import { createTenantRosterRouter } from "./tenant-roster";

function buildApp() {
  const hub = new Hono<RouteEnv>();
  hub.use("/api/tenants/:tenantId/roster/*", async (c, next) => {
    c.set("tenant", { id: "tnt_test" });
    await next();
  });
  hub.route(
    "/api/tenants/:tenantId/roster",
    createTenantRosterRouter({ db: {} as never }),
  );
  return hub;
}

const url = "http://localhost/api/tenants/tnt_test/roster";

beforeEach(() => {
  serviceCalls = [];
  serviceResult = sampleRoster;
  serviceError = null;
});

describe("GET /api/tenants/:tenantId/roster", () => {
  it("returns the tenant roster scoped to the authenticated tenant", async () => {
    const res = await buildApp().request(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof sampleRoster;
    expect(body.instances[0]?.instanceId).toBe("ins-1");
    expect(body.runs[0]?.runId).toBe("run-1");
    expect(serviceCalls[0]).toMatchObject({ tenantId: "tnt_test" });
  });

  it("maps unexpected service failures to 500", async () => {
    serviceError = new Error("connection refused");
    const res = await buildApp().request(url);
    expect(res.status).toBe(500);
  });
});
