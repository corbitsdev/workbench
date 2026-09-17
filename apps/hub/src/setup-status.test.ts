// The native cold-boot status read (CL-8112): empty hub demands setup,
// any tenant means setup is behind us, and a count failure answers the
// hub's error envelope (never a leak, never a bare 500).
import { describe, expect, test } from "bun:test";

import {
  createSetupStatusRoutes,
  type SetupStatusCounts,
} from "./setup-status";

function counts(counters: SetupStatusCounts) {
  return createSetupStatusRoutes(counters);
}

describe("createSetupStatusRoutes", () => {
  test("an empty hub reports setupRequired with zero counts", async () => {
    const res = await counts({
      countUsers: async () => 0,
      countTenants: async () => 0,
    }).request("/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupRequired: true,
      userCount: 0,
      tenantCount: 0,
    });
  });

  test("a hub with tenants reports setupRequired false with real counts", async () => {
    const res = await counts({
      countUsers: async () => 3,
      countTenants: async () => 2,
    }).request("/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupRequired: false,
      userCount: 3,
      tenantCount: 2,
    });
  });

  test("users with zero tenants still require setup — no bench exists", async () => {
    const res = await counts({
      countUsers: async () => 1,
      countTenants: async () => 0,
    }).request("/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupRequired: true,
      userCount: 1,
      tenantCount: 0,
    });
  });

  test("a count failure answers the error envelope with a refId", async () => {
    const res = await counts({
      countUsers: async () => 0,
      countTenants: async () => {
        throw new Error("connection refused");
      },
    }).request("/status");

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("setup_status_failed");
    expect(body.error.userMessage).not.toContain("connection refused");
    expect(body.error.refId.length).toBeGreaterThan(0);
  });
});
