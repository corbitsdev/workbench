import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import { resolveInstanceOwner } from "./instance-ownership";

type Graph = {
  callerPrincipal?: { id: string } | null;
  instanceById?: { id: string; tenantId: string } | null;
  ownership?: { memberPrincipalId: string } | null;
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
        findFirst: mock(() => Promise.resolve(graph.instanceById ?? undefined)),
      },
      memberAgentInstance: {
        findFirst: mock(() => Promise.resolve(graph.ownership ?? undefined)),
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
