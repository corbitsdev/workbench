import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({}),
}));

let member: { tenantId: string; principalId: string } | null = {
  tenantId: "ten-1",
  principalId: "pri-1",
};
mock.module("../lib/tenant-provisioning", () => ({
  getRootTenantId: mock(async () => "ten-1"),
  lookupMember: mock(async () => member),
}));

const mergeMemberPreferences = mock(
  async (_db, _t, _p, patch: Record<string, unknown>) => ({
    theme: "notion",
    ...patch,
  }),
);
const readMemberPreferences = mock(async () => ({ theme: "notion" }));
mock.module("../lib/member-preferences", () => ({
  mergeMemberPreferences,
  readMemberPreferences,
}));

import { Hono } from "hono";
import { createMePreferencesRouter } from "./me-preferences";

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-1");
    return next();
  });
  v1.route("/", createMePreferencesRouter({} as unknown as HubDb));
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

function patch(body: unknown): Request {
  return new Request("http://localhost/api/v1/me/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-user-id": "user-1" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/me/preferences", () => {
  it("merges a valid patch and returns the merged preferences", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(patch({ toolSummaryStyle: "mixed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ theme: "notion", toolSummaryStyle: "mixed" });
    // The parsed patch (not the raw request) is handed to the store.
    expect(mergeMemberPreferences).toHaveBeenCalledTimes(1);
    expect((mergeMemberPreferences.mock.calls[0] as unknown[])[3]).toEqual({
      toolSummaryStyle: "mixed",
    });
  });

  it("returns 400 on an invalid preference value", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    const res = await mountApp().request(patch({ toolSummaryStyle: "fancy" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(patch({ theme: "tkww" }));
    expect(res.status).toBe(409);
  });
});

describe("GET /api/v1/me/preferences", () => {
  it("returns the stored preferences for the caller", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/preferences", {
        headers: { "x-test-user-id": "user-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: "notion" });
  });

  it("returns an empty object when the caller has no membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/preferences", {
        headers: { "x-test-user-id": "user-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
