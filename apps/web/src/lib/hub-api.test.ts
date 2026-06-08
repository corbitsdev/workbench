/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  principalsToWorkbenches,
  principalToWorkbenchEntry,
  type Principal,
} from "./hub-api";

describe("principalsToWorkbenches", () => {
  it('lists the personal workbench first, relabeled "Your Workbench"', () => {
    const principals: Principal[] = [
      {
        principalId: "p-2",
        tenantId: "tenant-acme",
        tenantSlug: "acme-sales",
        tenantName: "Acme Sales",
        kind: "user",
        status: "active",
        roles: [],
      },
      {
        principalId: "p-1",
        tenantId: "tenant-user",
        tenantSlug: "user-abc123",
        tenantName: "alice@example.com",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals);

    expect(workbenches).toHaveLength(2);
    expect(workbenches[0]!.id).toBe("p-1");
    expect(workbenches[0]!.tenantSlug).toBe("user-abc123");
    expect(workbenches[0]!.tenantName).toBe("Your Workbench");
    expect(workbenches[1]!.id).toBe("p-2");
    expect(workbenches[1]!.tenantName).toBe("Acme Sales");
  });

  it("returns only the personal workbench when the user has no shared tenants", () => {
    const principals: Principal[] = [
      {
        principalId: "p-1",
        tenantId: "tenant-user",
        tenantSlug: "user-abc123",
        tenantName: "alice@example.com",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals);
    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.tenantName).toBe("Your Workbench");
  });

  it("maps Interchange principalId to the workbench entry id", () => {
    const principal: Principal = {
      principalId: "principal-workbench",
      tenantId: "tenant-acme",
      tenantSlug: "acme-sales",
      tenantName: "Acme Sales",
      kind: "user",
      status: "active",
      roles: [],
    };

    expect(principalToWorkbenchEntry(principal)).toEqual({
      id: "principal-workbench",
      tenantId: "tenant-acme",
      tenantSlug: "acme-sales",
      tenantName: "Acme Sales",
    });
  });
});
