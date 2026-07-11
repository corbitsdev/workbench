import { describe, expect, it } from "bun:test";
import { seedHeartbeatSchedules } from "./scheduled-trigger-seeder";

type Ensured = {
  ownerPrincipalId: string;
  kind: string;
  hourUtc: number;
  payload: Record<string, unknown>;
};

describe("seedHeartbeatSchedules", () => {
  it("seeds nothing when disabled", async () => {
    const ensured: Ensured[] = [];
    const result = await seedHeartbeatSchedules({
      enabled: false,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => [{ memberPrincipalId: "p-1" }],
      resolveUserAddress: async () => "user-1@workbench.example",
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });
    expect(result.seeded).toBe(0);
    expect(ensured).toHaveLength(0);
  });

  it("ensures a heartbeat row per Myra member with the user-address payload", async () => {
    const ensured: Ensured[] = [];
    const result = await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => [
        { memberPrincipalId: "principal-a" },
        { memberPrincipalId: "principal-b" },
      ],
      resolveUserAddress: async (pid) =>
        pid === "principal-a"
          ? "user-a@workbench.example"
          : "user-b@workbench.example",
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });

    expect(result.seeded).toBe(2);
    expect(ensured).toContainEqual({
      ownerPrincipalId: "principal-a",
      kind: "heartbeat",
      hourUtc: 13,
      payload: {
        reason: "scheduled-heartbeat",
        userAddress: "user-a@workbench.example",
        userRefId: "user-a",
      },
    });
    expect(ensured).toContainEqual({
      ownerPrincipalId: "principal-b",
      kind: "heartbeat",
      hourUtc: 13,
      payload: {
        reason: "scheduled-heartbeat",
        userAddress: "user-b@workbench.example",
        userRefId: "user-b",
      },
    });
  });

  it("derives userRefId as the segment before the final @ for an email refId", async () => {
    const ensured: Ensured[] = [];
    await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 9,
      listMyraTargets: async () => [{ memberPrincipalId: "p-1" }],
      resolveUserAddress: async () => "user@corp.com@workbench.example",
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });
    expect(ensured[0]?.payload["userRefId"]).toBe("user@corp.com");
  });

  it("one member's failure does not block the others", async () => {
    const ensured: Ensured[] = [];
    const result = await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => [
        { memberPrincipalId: "principal-a" },
        { memberPrincipalId: "principal-b" },
      ],
      resolveUserAddress: async (pid) => {
        if (pid === "principal-a") throw new Error("no principal");
        return "user-b@workbench.example";
      },
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });

    expect(result.seeded).toBe(1);
    expect(ensured.map((e) => e.ownerPrincipalId)).toEqual(["principal-b"]);
  });

  it("returns zero without throwing when enumeration fails", async () => {
    const result = await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => {
        throw new Error("db down");
      },
      resolveUserAddress: async () => "x@y",
      ensureSchedule: async () => {},
    });
    expect(result.seeded).toBe(0);
  });
});
