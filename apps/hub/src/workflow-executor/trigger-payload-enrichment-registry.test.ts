import { describe, expect, test } from "bun:test";
import type { HubDb } from "../db";
import { enrichTriggerPayloadForStart } from "./trigger-payload-enrichment-registry";

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
function makeDb(storedPreferences: Record<string, unknown> | undefined): any {
  return {
    query: {
      memberPreferences: {
        findFirst: async () =>
          storedPreferences === undefined
            ? undefined
            : { preferences: storedPreferences },
      },
    },
  };
}

describe("enrichTriggerPayloadForStart", () => {
  test("passes input through unchanged for a kind with no registered enricher", async () => {
    const input = { topic: "Acme" };
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb(undefined) as HubDb,
        resolveUserIdentity: async () => ({
          userAddress: "usr_x@d",
          userRefId: "x",
        }),
      },
      { kind: "pain-point-collateral", tenantId: "tn-1", principalId: "prn-1" },
      input,
    );
    expect(result).toBe(input);
  });

  test("fills enabledSources, identity, and createdAfter for a bare heartbeat start", async () => {
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb(undefined) as HubDb,
        resolveUserIdentity: async (principalId: string) => ({
          userAddress: `usr_${principalId}@d`,
          userRefId: principalId,
          userDisplayName: "Jordan Lee",
        }),
        now: () => Date.UTC(2026, 0, 9, 9, 0, 0),
      },
      { kind: "heartbeat", tenantId: "tn-1", principalId: "prn-1" },
      { reason: "manual-brief" },
    );
    expect(result.enabledSources).toEqual([]);
    expect(result.userAddress).toBe("usr_prn-1@d");
    expect(result.userRefId).toBe("prn-1");
    expect(result.userDisplayName).toBe("Jordan Lee");
    expect(typeof result.createdAfter).toBe("string");
  });

  test("overwrites a caller-supplied enabledSources with the member's current preferences", async () => {
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb({ "briefSource:granola": true }) as HubDb,
        resolveUserIdentity: async () => ({
          userAddress: "usr_1@d",
          userRefId: "1",
        }),
      },
      { kind: "heartbeat", tenantId: "tn-1", principalId: "prn-1" },
      { enabledSources: ["some-stale-caller-value"] },
    );
    expect(result.enabledSources).not.toEqual(["some-stale-caller-value"]);
  });

  // TRANSITIONAL: granola-call has no HITL gate, so a schedule
  // saved before its ONE intake field was renamed `maxCalls` -> `limit` may
  // still hold the old key. See the granola-call entry's comment in
  // trigger-payload-enrichment-registry.ts for the deletion condition.
  test("normalizes a legacy granola-call maxCalls into the canonical limit field", async () => {
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb(undefined) as HubDb,
        resolveUserIdentity: async () => ({
          userAddress: "usr_1@d",
          userRefId: "1",
        }),
      },
      { kind: "granola-call", tenantId: "tn-1", principalId: "prn-1" },
      { maxCalls: 5 },
    );
    expect(result).toEqual({ limit: 5 });
  });

  test("prefers a new-shape limit over a legacy maxCalls when both are present", async () => {
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb(undefined) as HubDb,
        resolveUserIdentity: async () => ({
          userAddress: "usr_1@d",
          userRefId: "1",
        }),
      },
      { kind: "granola-call", tenantId: "tn-1", principalId: "prn-1" },
      { maxCalls: 5, limit: 20 },
    );
    expect(result).toEqual({ limit: 20 });
  });

  test("a new-shape granola-call trigger payload (limit only) is unaffected by the legacy shim", async () => {
    const input = { limit: 8 };
    const result = await enrichTriggerPayloadForStart(
      {
        db: makeDb(undefined) as HubDb,
        resolveUserIdentity: async () => ({
          userAddress: "usr_1@d",
          userRefId: "1",
        }),
      },
      { kind: "granola-call", tenantId: "tn-1", principalId: "prn-1" },
      input,
    );
    expect(result).toBe(input);
  });

  // resolveUserIdentity (apps/hub/src/index.ts) throws when the principal row
  // is missing — a fail-loud invariant, not a fallback. A registered enricher
  // must let that throw propagate rather than catching it and proceeding with
  // an unenriched (and therefore argMap-breaking) payload: a run that can't
  // resolve who it's firing for must fail the start, not silently deliver a
  // trigger payload missing enabledSources/userAddress/userDisplayName.
  test("propagates a resolveUserIdentity failure instead of falling back to an unenriched payload", async () => {
    const identityError = new Error("principal not found: prn-ghost");
    await expect(
      enrichTriggerPayloadForStart(
        {
          db: makeDb(undefined) as HubDb,
          resolveUserIdentity: async () => {
            throw identityError;
          },
        },
        { kind: "heartbeat", tenantId: "tn-1", principalId: "prn-ghost" },
        { reason: "manual-brief" },
      ),
    ).rejects.toThrow("principal not found: prn-ghost");
  });
});
