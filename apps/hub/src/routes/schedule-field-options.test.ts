import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
  loadConfig: () => ({}),
}));

const resolveOptionsMock = mock(async () => [
  { value: "1", label: "Engine - Growth" },
]);

mock.module("../lib/schedule-field-options", () => ({
  SCHEDULE_FIELD_OPTIONS_SOURCES: {
    "sumble-organization-lists": resolveOptionsMock,
  },
}));

import { createScheduleFieldOptionsRouter } from "./schedule-field-options";

// biome-ignore lint/suspicious/noExplicitAny: structural mock
type MockDb = any;

const MOCK_TENANT = { id: "tn-global", slug: "global-org" };
const MOCK_PRINCIPAL = {
  id: "prn-user",
  tenantId: "tn-global",
  kind: "user",
  status: "active",
};

function makeMockDb(): MockDb {
  return {
    query: {
      tenant: { findFirst: mock(() => Promise.resolve(MOCK_TENANT)) },
      principal: { findFirst: mock(() => Promise.resolve(MOCK_PRINCIPAL)) },
    },
  };
}

function buildApp(db: HubDb) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", createScheduleFieldOptionsRouter(db));
  return app;
}

describe("GET /schedule-field-options/:sourceId (CL-4279)", () => {
  it("resolves and returns options for a known source", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.request(
      "/schedule-field-options/sumble-organization-lists",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      options: [{ value: "1", label: "Engine - Growth" }],
    });
  });

  it("404s on an unknown sourceId", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.request("/schedule-field-options/not-a-real-source");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown options source/);
  });

  it("surfaces a resolver failure as 502 rather than an empty list", async () => {
    resolveOptionsMock.mockImplementationOnce(async () => {
      throw new Error("Sumble API unreachable");
    });
    const app = buildApp(makeMockDb());
    const res = await app.request(
      "/schedule-field-options/sumble-organization-lists",
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Sumble API unreachable");
  });

  it("404s when the requesting user has no root-tenant principal", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.request(
      "/schedule-field-options/sumble-organization-lists",
    );
    expect(res.status).toBe(404);
  });
});
