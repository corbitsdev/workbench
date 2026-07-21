import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  CreateScheduledTriggerBodySchema,
  HEARTBEAT_WORKFLOW_KIND,
  HeartbeatTriggerPayloadSchema,
  scheduleScopesForKind,
  ScheduledTriggerSchema,
} from "./scheduled-trigger";

describe("HEARTBEAT_WORKFLOW_KIND", () => {
  it("is the single shared literal for the heartbeat workflow kind", () => {
    expect(HEARTBEAT_WORKFLOW_KIND).toBe("heartbeat");
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
      hourUtc: 9,
      scope: "tenant",
    });
    expect(body).not.toBeInstanceOf(type.errors);
  });

  it("rejects invalid scope", () => {
    expect(
      CreateScheduledTriggerBodySchema({
        kind: "morning-brief",
        hourUtc: 9,
        scope: "team",
      }),
    ).toBeInstanceOf(type.errors);
  });
});

describe("ScheduledTriggerSchema", () => {
  it("requires scope and ownerMemberPrincipalId", () => {
    const ok = ScheduledTriggerSchema({
      id: "sch-1",
      workflowKind: "heartbeat",
      hourUtc: 13,
      enabled: true,
      scope: "personal",
      ownerMemberPrincipalId: "prn-1",
      triggerPayload: {},
      createdAt: "2026-01-02T00:00:00.000Z",
      lastFiredDayUtc: null,
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
