import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

type RouteEnv = {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
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
  getPrincipalRoster: mock(async (args: unknown) => {
    serviceCalls.push(args);
    if (serviceError) throw serviceError;
    return serviceResult;
  }),
}));

import { createPrincipalRosterRouter } from "./principal-roster";

function buildApp(callerPrincipalId: string) {
  const hub = new Hono<RouteEnv>();
  hub.use(
    "/api/tenants/:tenantId/principals/:principalId/roster/*",
    async (c, next) => {
      c.set("tenant", { id: "tnt_test" });
      c.set("principal", { id: callerPrincipalId });
      await next();
    },
  );
  hub.route(
    "/api/tenants/:tenantId/principals/:principalId/roster",
    createPrincipalRosterRouter({ db: {} as never }),
  );
  return hub;
}

function url(principalId: string) {
  return `http://localhost/api/tenants/tnt_test/principals/${principalId}/roster`;
}

beforeEach(() => {
  serviceCalls = [];
  serviceResult = sampleRoster;
  serviceError = null;
});

describe("GET /api/tenants/:tenantId/principals/:principalId/roster", () => {
  it("lets a principal read their own roster without a grant", async () => {
    const res = await buildApp("prn-self").request(url("prn-self"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof sampleRoster;
    expect(body.instances[0]?.instanceId).toBe("ins-1");
    expect(body.runs[0]?.runId).toBe("run-1");
    expect(serviceCalls[0]).toMatchObject({
      tenantId: "tnt_test",
      principalId: "prn-self",
    });
  });

  it("lets any tenant member read another principal's roster (open intra-tenant)", async () => {
    const res = await buildApp("prn-caller").request(url("prn-target"));
    expect(res.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({
      tenantId: "tnt_test",
      principalId: "prn-target",
    });
  });

  it("maps unexpected service failures to 500", async () => {
    serviceError = new Error("connection refused");
    const res = await buildApp("prn-self").request(url("prn-self"));
    expect(res.status).toBe(500);
  });
});
