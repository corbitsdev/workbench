import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  CreateScheduledTriggerBodySchema,
  DAILY_INTERVAL_MINUTES,
  defaultScheduleName,
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
  it("requires scope, ownerMemberPrincipalId, and a non-empty name", () => {
    const ok = ScheduledTriggerSchema({
      id: "sch-1",
      workflowKind: "heartbeat",
      name: "Morning brief",
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

  it("rejects an empty name", () => {
    const invalid = ScheduledTriggerSchema({
      id: "sch-1",
      workflowKind: "heartbeat",
      name: "",
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
    expect(invalid).toBeInstanceOf(type.errors);
  });
});

describe("CreateScheduledTriggerBodySchema name", () => {
  it("accepts an omitted name", () => {
    const body = CreateScheduledTriggerBodySchema({
      kind: "morning-brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
    });
    expect(body).not.toBeInstanceOf(type.errors);
  });

  it("accepts a caller-supplied name", () => {
    const body = CreateScheduledTriggerBodySchema({
      kind: "morning-brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
      name: "Client research — Acme",
    });
    expect(body).not.toBeInstanceOf(type.errors);
  });

  it("rejects an empty name", () => {
    expect(
      CreateScheduledTriggerBodySchema({
        kind: "morning-brief",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
        name: "",
      }),
    ).toBeInstanceOf(type.errors);
  });
});

describe("defaultScheduleName", () => {
  it("uses the bare kind for the first schedule of that kind", () => {
    expect(defaultScheduleName("heartbeat", 0)).toBe("heartbeat");
  });

  it("numbers subsequent schedules of the same kind", () => {
    expect(defaultScheduleName("heartbeat", 1)).toBe("heartbeat 2");
    expect(defaultScheduleName("heartbeat", 2)).toBe("heartbeat 3");
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
