import { describe, expect, test } from "bun:test";

import { tenantResolutionFromBench } from "./tenant-resolution";

describe("tenantResolutionFromBench", () => {
  test("passes through loading memberships", () => {
    expect(
      tenantResolutionFromBench({
        memberships: { kind: "loading" },
        selectedTenantId: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  test("passes through error memberships", () => {
    expect(
      tenantResolutionFromBench({
        memberships: { kind: "error", message: "offline" },
        selectedTenantId: "tnt_1",
      }),
    ).toEqual({ kind: "error", message: "offline" });
  });

  test("ready with no selection is empty", () => {
    expect(
      tenantResolutionFromBench({
        memberships: {
          kind: "ready",
          data: { data: [], nextCursor: null },
        },
        selectedTenantId: null,
      }),
    ).toEqual({ kind: "empty" });
  });

  test("ready with a selection yields that tenant id", () => {
    expect(
      tenantResolutionFromBench({
        memberships: {
          kind: "ready",
          data: { data: [], nextCursor: null },
        },
        selectedTenantId: "tnt_acme",
      }),
    ).toEqual({ kind: "ready", tenantId: "tnt_acme" });
  });
});
