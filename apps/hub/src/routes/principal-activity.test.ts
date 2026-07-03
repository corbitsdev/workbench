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
  getPrincipalActivityPage: mock(async (args: unknown) => {
    serviceCalls.push(args);
    if (serviceError) throw serviceError;
    return serviceResult;
  }),
}));

let authorizeEffect: string | null = null;
mock.module("@intx/authz", () => ({
  authorize: mock(async () => ({
    effect: authorizeEffect,
    matchingGrants: [],
    resolvedBy: null,
  })),
}));

import { encodeTimelineCursor } from "@workbench/timeline";

import { createPrincipalActivityRouter } from "./principal-activity";

function buildApp(callerPrincipalId: string) {
  const hub = new Hono<RouteEnv>();
  hub.use(
    "/api/tenants/:tenantId/principals/:principalId/activity/*",
    async (c, next) => {
      c.set("tenant", { id: "tnt_test" });
      c.set("principal", { id: callerPrincipalId });
      await next();
    },
  );
  hub.route(
    "/api/tenants/:tenantId/principals/:principalId/activity",
    createPrincipalActivityRouter({ db: {} as never, grantStore: {} as never }),
  );
  return hub;
}

function url(principalId: string, query = "") {
  return `http://localhost/api/tenants/tnt_test/principals/${principalId}/activity${query}`;
}

beforeEach(() => {
  serviceCalls = [];
  serviceResult = { entries: [sampleEntry], nextCursor: null };
  serviceError = null;
  authorizeEffect = null;
});

describe("GET /api/tenants/:tenantId/principals/:principalId/activity", () => {
  it("lets a principal read their own timeline without a grant", async () => {
    const res = await buildApp("prn-self").request(url("prn-self"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: (typeof sampleEntry)[];
      nextCursor: string | null;
    };
    expect(body.entries[0]?.id).toBe("run-1");
    expect(body.nextCursor).toBeNull();
    expect(serviceCalls[0]).toMatchObject({
      tenantId: "tnt_test",
      principalId: "prn-self",
      limit: 50,
    });
  });

  it("denies another principal's timeline without an allow grant", async () => {
    authorizeEffect = null;
    const res = await buildApp("prn-caller").request(url("prn-target"));
    expect(res.status).toBe(403);
    expect(serviceCalls).toHaveLength(0);
  });

  it("allows an operator with an activity read grant to view any principal", async () => {
    authorizeEffect = "allow";
    const res = await buildApp("prn-operator").request(url("prn-target"));
    expect(res.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ principalId: "prn-target" });
  });

  it("bounds the limit parameter", async () => {
    const app = buildApp("prn-self");
    expect((await app.request(url("prn-self", "?limit=0"))).status).toBe(400);
    expect((await app.request(url("prn-self", "?limit=101"))).status).toBe(400);
    expect((await app.request(url("prn-self", "?limit=abc"))).status).toBe(400);
    expect(serviceCalls).toHaveLength(0);

    const ok = await app.request(url("prn-self", "?limit=100"));
    expect(ok.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ limit: 100 });
  });

  it("passes a valid opaque cursor through and rejects a malformed one with 400", async () => {
    const app = buildApp("prn-self");
    const token = encodeTimelineCursor({
      timestamp: "2026-07-01T10:00:00.000Z",
      sourceTable: "workflow_run_record",
      id: "run-1",
    });
    const ok = await app.request(url("prn-self", `?cursor=${token}`));
    expect(ok.status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ cursor: token });

    const bad = await app.request(url("prn-self", "?cursor=%7Bnope"));
    expect(bad.status).toBe(400);
    expect(serviceCalls).toHaveLength(1);
  });

  it("maps unexpected service failures to 500", async () => {
    serviceError = new Error("connection refused");
    const res = await buildApp("prn-self").request(url("prn-self"));
    expect(res.status).toBe(500);
  });
});
