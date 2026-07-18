import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

const listMemberFeatureStates = mock(async () => [
  { name: "scheduler" as const, enabled: true },
  { name: "triage" as const, enabled: false },
  { name: "tasks-reconciler" as const, enabled: true },
]);

mock.module("../lib/feature-grants", () => ({
  listMemberFeatureStates,
}));

const resolveCallerMember = mock(async () => ({
  tenantId: "tn-1",
  principalId: "pr-1",
}));

mock.module("../lib/tenant-provisioning", () => ({
  resolveCallerMember,
}));

import { createMeFeaturesRouter } from "./me-features";

function wrap(db: HubDb = {} as HubDb) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", createMeFeaturesRouter(db));
  return app;
}

describe("GET /me/features", () => {
  it("returns member-readable feature enablement for the caller's tenant", async () => {
    const app = wrap();
    const res = await app.request("/me/features");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      features: [
        { name: "scheduler", enabled: true },
        { name: "triage", enabled: false },
        { name: "tasks-reconciler", enabled: true },
      ],
    });
    expect(listMemberFeatureStates).toHaveBeenCalledWith(
      expect.anything(),
      "tn-1",
    );
  });

  it("returns an empty features array when the caller has no tenant membership", async () => {
    resolveCallerMember.mockImplementationOnce(
      async () => null as unknown as { tenantId: string; principalId: string },
    );
    const app = wrap();
    const res = await app.request("/me/features");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ features: [] });
  });
});
