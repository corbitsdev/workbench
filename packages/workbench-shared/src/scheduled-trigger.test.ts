import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  CreateScheduledTriggerBodySchema,
  DAILY_INTERVAL_MINUTES,
  HEARTBEAT_WORKFLOW_KIND,
  HeartbeatTriggerPayloadSchema,
  isRecurrenceAllowedForKind,
  scheduleScopesForKind,
  ScheduledTriggerSchema,
} from "./scheduled-trigger";

describe("HEARTBEAT_WORKFLOW_KIND", () => {
  it("is the single shared literal for the heartbeat workflow kind", () => {
    expect(HEARTBEAT_WORKFLOW_KIND).toBe("heartbeat");
  });
});

describe("isRecurrenceAllowedForKind", () => {
  it("rejects a non-daily interval for heartbeat", () => {
    expect(
      isRecurrenceAllowedForKind("heartbeat", {
        intervalMinutes: 5,
        anchorMinuteUtc: 0,
      }),
    ).toBe(false);
    expect(
      isRecurrenceAllowedForKind("heartbeat", {
        intervalMinutes: 60,
        anchorMinuteUtc: 0,
      }),
    ).toBe(false);
  });

  it("allows the daily interval for heartbeat", () => {
    expect(
      isRecurrenceAllowedForKind("heartbeat", {
        intervalMinutes: DAILY_INTERVAL_MINUTES,
        anchorMinuteUtc: 9 * 60,
      }),
    ).toBe(true);
  });

  it("allows any interval for a non-heartbeat kind", () => {
    expect(
      isRecurrenceAllowedForKind("granola-call", {
        intervalMinutes: 5,
        anchorMinuteUtc: 0,
      }),
    ).toBe(true);
  });
});

describe("scheduleScopesForKind", () => {
  it("keeps heartbeat personal-only even when attachable", () => {
    expect(scheduleScopesForKind("heartbeat", true)).toEqual({
      allowedScopes: ["personal"],
      defaultScope: "personal",
    });
  });

  it("offers personal + tenant for other attachable kinds", () => {
    expect(scheduleScopesForKind("morning-brief", true)).toEqual({
      allowedScopes: ["personal", "tenant"],
      defaultScope: "personal",
    });
  });

  it("defaults non-attachable kinds to personal-only", () => {
    expect(scheduleScopesForKind("gated-workflow", false)).toEqual({
      allowedScopes: ["personal"],
      defaultScope: "personal",
    });
  });
});

describe("CreateScheduledTriggerBodySchema", () => {
  it("accepts optional scope", () => {
    const body = CreateScheduledTriggerBodySchema({
      kind: "morning-brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
      scope: "tenant",
    });
    expect(body).not.toBeInstanceOf(type.errors);
  });

  it("rejects invalid scope", () => {
    expect(
      CreateScheduledTriggerBodySchema({
        kind: "morning-brief",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
        scope: "team",
      }),
    ).toBeInstanceOf(type.errors);
  });

  it("rejects a non-positive interval", () => {
    expect(
      CreateScheduledTriggerBodySchema({
        kind: "morning-brief",
        recurrence: { intervalMinutes: 0, anchorMinuteUtc: 0 },
      }),
    ).toBeInstanceOf(type.errors);
  });

  it("accepts a sub-hourly interval", () => {
    const body = CreateScheduledTriggerBodySchema({
      kind: "granola-call",
      recurrence: { intervalMinutes: 5, anchorMinuteUtc: 0 },
    });
    expect(body).not.toBeInstanceOf(type.errors);
  });
});

describe("ScheduledTriggerSchema", () => {
  it("requires scope and ownerMemberPrincipalId", () => {
    const ok = ScheduledTriggerSchema({
      id: "sch-1",
      workflowKind: "heartbeat",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      enabled: true,
      scope: "personal",
      ownerMemberPrincipalId: "prn-1",
      triggerPayload: {},
      createdAt: "2026-01-02T00:00:00.000Z",
      lastRunId: null,
      recentFires: [],
      nextFireAt: null,
    });
    expect(ok).not.toBeInstanceOf(type.errors);
  });
});

describe("HeartbeatTriggerPayloadSchema", () => {
  it("accepts a well-formed heartbeat payload", () => {
    const payload = HeartbeatTriggerPayloadSchema({
      reason: "scheduled-heartbeat",
      userAddress: "usr_abc@workbench.example",
      userRefId: "usr_abc",
    });
    expect(payload).not.toBeInstanceOf(type.errors);
  });

  it("accepts an optional createdAfter timestamp", () => {
    const payload = HeartbeatTriggerPayloadSchema({
      reason: "scheduled-heartbeat",
      userAddress: "usr_abc@workbench.example",
      userRefId: "usr_abc",
      createdAfter: "2026-07-04T00:00:00Z",
    });
    expect(payload).not.toBeInstanceOf(type.errors);
  });

  it("rejects any reason other than scheduled-heartbeat", () => {
    const payload = HeartbeatTriggerPayloadSchema({
      reason: "scheduled",
      userAddress: "usr_abc@workbench.example",
      userRefId: "usr_abc",
    });
    expect(payload).toBeInstanceOf(type.errors);
  });

  it("rejects an empty userAddress or userRefId", () => {
    expect(
      HeartbeatTriggerPayloadSchema({
        reason: "scheduled-heartbeat",
        userAddress: "",
        userRefId: "usr_abc",
      }),
    ).toBeInstanceOf(type.errors);
    expect(
      HeartbeatTriggerPayloadSchema({
        reason: "scheduled-heartbeat",
        userAddress: "usr_abc@workbench.example",
        userRefId: "",
      }),
    ).toBeInstanceOf(type.errors);
  });
});
