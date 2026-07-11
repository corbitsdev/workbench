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
      resolveUserIdentity: async () => ({
        userAddress: "user-1@workbench.example",
        userRefId: "user-1",
      }),
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });
    expect(result.seeded).toBe(0);
    expect(ensured).toHaveLength(0);
  });

  it("ensures a heartbeat row per Myra member with the resolved identity payload", async () => {
    const ensured: Ensured[] = [];
    const result = await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => [
        { memberPrincipalId: "principal-a" },
        { memberPrincipalId: "principal-b" },
      ],
      resolveUserIdentity: async (pid) =>
        pid === "principal-a"
          ? { userAddress: "user-a@workbench.example", userRefId: "user-a" }
          : { userAddress: "user-b@workbench.example", userRefId: "user-b" },
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

  it("passes an email-shaped userRefId through verbatim", async () => {
    const ensured: Ensured[] = [];
    await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 9,
      listMyraTargets: async () => [{ memberPrincipalId: "p-1" }],
      resolveUserIdentity: async () => ({
        userAddress: "user@corp.com@workbench.example",
        userRefId: "user@corp.com",
      }),
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });
    expect(ensured[0]?.payload["userRefId"]).toBe("user@corp.com");
  });

  it("skips a target whose resolved identity fails payload validation", async () => {
    const ensured: Ensured[] = [];
    const result = await seedHeartbeatSchedules({
      enabled: true,
      kind: "heartbeat",
      hourUtc: 13,
      listMyraTargets: async () => [{ memberPrincipalId: "p-1" }],
      resolveUserIdentity: async () => ({ userAddress: "", userRefId: "" }),
      ensureSchedule: async (a) => {
        ensured.push(a);
      },
    });
    expect(result.seeded).toBe(0);
    expect(ensured).toHaveLength(0);
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
      resolveUserIdentity: async (pid) => {
        if (pid === "principal-a") throw new Error("no principal");
        return { userAddress: "user-b@workbench.example", userRefId: "user-b" };
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
      resolveUserIdentity: async () => ({ userAddress: "x@y", userRefId: "x" }),
      ensureSchedule: async () => {},
    });
    expect(result.seeded).toBe(0);
  });
});
