import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

type RouteEnv = {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const sampleEntry = {
  id: "run-1",
  kind: "workflow_run",
  sourceTable: "workflow_run_record",
  timestamp: "2026-07-01T10:00:00.000Z",
  summary: "last30days completed",
};

let serviceCalls: unknown[] = [];
let serviceResult: unknown = { entries: [sampleEntry], nextCursor: null };
let serviceError: Error | null = null;
mock.module("../services/principal-activity", () => ({
  getTenantActivityPage: mock(async (args: unknown) => {
    serviceCalls.push(args);
    if (serviceError) throw serviceError;
    return serviceResult;
  }),
}));

import { encodeTimelineCursor } from "@workbench/timeline";

import { createTenantActivityRouter } from "./tenant-activity";

function buildApp(callerPrincipalId: string, tenantId = "tnt_test") {
  const hub = new Hono<RouteEnv>();
  hub.use("/api/tenants/:tenantId/activity/*", async (c, next) => {
    c.set("tenant", { id: tenantId });
    c.set("principal", { id: callerPrincipalId });
    await next();
  });
  hub.route(
    "/api/tenants/:tenantId/activity",
    createTenantActivityRouter({ db: {} as never }),
  );
  return hub;
}

function url(query = "", tenantId = "tnt_test") {
  return `http://localhost/api/tenants/${tenantId}/activity/timeline${query}`;
}

beforeEach(() => {
  serviceCalls = [];
  serviceResult = { entries: [sampleEntry], nextCursor: null };
  serviceError = null;
});

describe("GET /api/tenants/:tenantId/activity/timeline", () => {
  it("returns the tenant-wide feed to any member, scoped to the path tenant", async () => {
    const res = await buildApp("prn-anyone").request(url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: (typeof sampleEntry)[];
      nextCursor: string | null;
    };
    expect(body.entries[0]?.id).toBe("run-1");
    expect(serviceCalls[0]).toMatchObject({ tenantId: "tnt_test", limit: 50 });
    // The tenant-wide service never receives a principalId filter.
    expect(serviceCalls[0]).not.toHaveProperty("principalId");
  });

  it("forwards the path tenantId to the service", async () => {
    const res = await buildApp("prn-anyone", "tnt_other").request(
      url("", "tnt_other"),
    );
    expect(res.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ tenantId: "tnt_other" });
  });

  it("bounds the limit parameter", async () => {
    const app = buildApp("prn-anyone");
    expect((await app.request(url("?limit=0"))).status).toBe(400);
    expect((await app.request(url("?limit=101"))).status).toBe(400);
    expect((await app.request(url("?limit=abc"))).status).toBe(400);
    expect(serviceCalls).toHaveLength(0);

    const ok = await app.request(url("?limit=100"));
    expect(ok.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ limit: 100 });
  });

  it("passes a valid opaque cursor through and rejects a malformed one with 400", async () => {
    const app = buildApp("prn-anyone");
    const token = encodeTimelineCursor({
      timestamp: "2026-07-01T10:00:00.000Z",
      sourceTable: "workflow_run_record",
      id: "run-1",
    });
    const ok = await app.request(url(`?cursor=${token}`));
    expect(ok.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({
      cursor: {
        timestamp: "2026-07-01T10:00:00.000Z",
        sourceTable: "workflow_run_record",
        id: "run-1",
      },
    });

    const bad = await app.request(url("?cursor=%7Bnope"));
    expect(bad.status).toBe(400);
    expect(serviceCalls).toHaveLength(1);
  });

  it("maps unexpected service failures to 500", async () => {
    serviceError = new Error("connection refused");
    const res = await buildApp("prn-anyone").request(url());
    expect(res.status).toBe(500);
  });
});
