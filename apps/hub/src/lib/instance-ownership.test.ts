import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import {
  callerCanResolveApproval,
  resolveInstanceOwner,
  resolveOwnedApprovalPrincipalIds,
} from "./instance-ownership";

type Graph = {
  callerPrincipal?: { id: string } | null;
  instanceById?: { id: string; tenantId: string } | null;
  instanceByPrincipal?: { id: string; tenantId: string } | null;
  ownership?: { memberPrincipalId: string } | null;
  memberships?: { instanceId: string }[];
  ownedInstances?: { principalId: string }[];
};

function makeDb(graph: Graph): HubDb {
  return {
    query: {
      principal: {
        findFirst: mock(() =>
          Promise.resolve(graph.callerPrincipal ?? undefined),
        ),
      },
      agentInstance: {
        // callerCanResolveApproval looks up by principalId, resolveInstanceOwner
        // by id; the fixtures set the same instance for both so either lookup
        // resolves it.
        findFirst: mock(() =>
          Promise.resolve(
            graph.instanceByPrincipal ?? graph.instanceById ?? undefined,
          ),
        ),
        findMany: mock(() => Promise.resolve(graph.ownedInstances ?? [])),
      },
      memberAgentInstance: {
        findFirst: mock(() => Promise.resolve(graph.ownership ?? undefined)),
        findMany: mock(() => Promise.resolve(graph.memberships ?? [])),
      },
    },
  } as unknown as HubDb;
}

describe("resolveInstanceOwner", () => {
  it("returns the caller principal + tenant when the caller owns the instance", async () => {
    const db = makeDb({
      instanceById: { id: "ins-1", tenantId: "ten-1" },
      callerPrincipal: { id: "prn-1" },
      ownership: { memberPrincipalId: "prn-1" },
    });
    const owner = await resolveInstanceOwner(db, "ins-1", "user-1");
    expect(owner).toEqual({ principalId: "prn-1", tenantId: "ten-1" });
  });

  it("returns null when the instance is unknown", async () => {
    const db = makeDb({ instanceById: null });
    expect(await resolveInstanceOwner(db, "ins-x", "user-1")).toBeNull();
  });

  it("returns null when the caller has no principal in the instance tenant", async () => {
    const db = makeDb({
      instanceById: { id: "ins-1", tenantId: "ten-1" },
      callerPrincipal: null,
    });
    expect(await resolveInstanceOwner(db, "ins-1", "user-1")).toBeNull();
  });

  it("returns null when the caller is not mapped to the instance", async () => {
    const db = makeDb({
      instanceById: { id: "ins-1", tenantId: "ten-1" },
      callerPrincipal: { id: "prn-1" },
      ownership: null,
    });
    expect(await resolveInstanceOwner(db, "ins-1", "user-1")).toBeNull();
  });
});

describe("callerCanResolveApproval", () => {
  const approval = { principalId: "agent-prn", tenantId: "ten-1" };

  it("allows an approval addressed to the caller's own principal", async () => {
    const db = makeDb({ callerPrincipal: { id: "agent-prn" } });
    expect(await callerCanResolveApproval(db, approval, "user-1")).toBe(true);
  });

  it("allows an approval raised by an instance the caller owns", async () => {
    const db = makeDb({
      callerPrincipal: { id: "prn-1" },
      instanceByPrincipal: { id: "ins-1", tenantId: "ten-1" },
      instanceById: { id: "ins-1", tenantId: "ten-1" },
      ownership: { memberPrincipalId: "prn-1" },
    });
    expect(await callerCanResolveApproval(db, approval, "user-1")).toBe(true);
  });

  it("denies when the caller has no principal in the tenant", async () => {
    const db = makeDb({ callerPrincipal: null });
    expect(await callerCanResolveApproval(db, approval, "user-1")).toBe(false);
  });

  it("denies when the approval principal maps to no instance", async () => {
    const db = makeDb({
      callerPrincipal: { id: "prn-1" },
      instanceByPrincipal: null,
      instanceById: null,
    });
    expect(await callerCanResolveApproval(db, approval, "user-1")).toBe(false);
  });

  it("denies when the caller does not own the raising instance", async () => {
    const db = makeDb({
      callerPrincipal: { id: "prn-1" },
      instanceByPrincipal: { id: "ins-1", tenantId: "ten-1" },
      instanceById: { id: "ins-1", tenantId: "ten-1" },
      ownership: null,
    });
    expect(await callerCanResolveApproval(db, approval, "user-1")).toBe(false);
  });
});

describe("resolveOwnedApprovalPrincipalIds", () => {
  it("returns only the caller principal when they own no instances", async () => {
    const db = makeDb({ memberships: [] });
    expect(
      await resolveOwnedApprovalPrincipalIds(db, "ten-1", "prn-1"),
    ).toEqual(["prn-1"]);
  });

  it("includes the synthetic principals of every instance the caller owns", async () => {
    const db = makeDb({
      memberships: [{ instanceId: "ins-1" }, { instanceId: "ins-2" }],
      ownedInstances: [
        { principalId: "agent-prn-1" },
        { principalId: "agent-prn-2" },
      ],
    });
    expect(
      await resolveOwnedApprovalPrincipalIds(db, "ten-1", "prn-1"),
    ).toEqual(["prn-1", "agent-prn-1", "agent-prn-2"]);
  });
});
