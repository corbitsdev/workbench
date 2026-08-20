import { describe, expect, test } from "bun:test";

import { createWorkbenchPresenceRegistry } from "./workbench-presence";

describe("createWorkbenchPresenceRegistry", () => {
  test("an unknown workbench has an empty roster", () => {
    const registry = createWorkbenchPresenceRegistry();
    expect(registry.snapshot("wb_none")).toEqual([]);
  });

  test("connecting adds a member with a stamped lastActiveAt", () => {
    const registry = createWorkbenchPresenceRegistry();
    registry.connect("wb_1", "prn_ada", 1_000);
    expect(registry.snapshot("wb_1")).toEqual([
      { principalId: "prn_ada", lastActiveAt: new Date(1_000).toISOString() },
    ]);
  });

  test("a second connection from the same principal is one member, ref-counted", () => {
    const registry = createWorkbenchPresenceRegistry();
    registry.connect("wb_1", "prn_ada", 1_000);
    registry.connect("wb_1", "prn_ada", 2_000);
    expect(registry.snapshot("wb_1")).toHaveLength(1);

    // Releasing one of the two connections leaves the principal present.
    expect(registry.disconnect("wb_1", "prn_ada")).toBe(false);
    expect(registry.snapshot("wb_1")).toHaveLength(1);

    // Releasing the last connection actually removes the member and
    // reports it as the caller's cue to broadcast "offline".
    expect(registry.disconnect("wb_1", "prn_ada")).toBe(true);
    expect(registry.snapshot("wb_1")).toEqual([]);
  });

  test("disconnecting a principal with no open connection is a no-op, reported as such", () => {
    const registry = createWorkbenchPresenceRegistry();
    expect(registry.disconnect("wb_1", "prn_ghost")).toBe(false);
  });

  test("ping refreshes lastActiveAt without changing the connection count", () => {
    const registry = createWorkbenchPresenceRegistry();
    registry.connect("wb_1", "prn_ada", 1_000);
    registry.connect("wb_1", "prn_ada", 1_500);
    registry.ping("wb_1", "prn_ada", 9_000);
    expect(registry.snapshot("wb_1")).toEqual([
      { principalId: "prn_ada", lastActiveAt: new Date(9_000).toISOString() },
    ]);

    // Still two connections underneath: one disconnect leaves the member.
    registry.disconnect("wb_1", "prn_ada");
    expect(registry.snapshot("wb_1")).toHaveLength(1);
  });

  test("pinging a principal with no open connection is a no-op — never fabricates a member", () => {
    const registry = createWorkbenchPresenceRegistry();
    registry.ping("wb_1", "prn_ghost", 9_000);
    expect(registry.snapshot("wb_1")).toEqual([]);
  });

  test("two workbenches never see each other's members", () => {
    const registry = createWorkbenchPresenceRegistry();
    registry.connect("wb_1", "prn_ada");
    registry.connect("wb_2", "prn_bob");
    expect(registry.snapshot("wb_1").map((m) => m.principalId)).toEqual([
      "prn_ada",
    ]);
    expect(registry.snapshot("wb_2").map((m) => m.principalId)).toEqual([
      "prn_bob",
    ]);
  });
});
