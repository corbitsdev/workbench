import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { HeartbeatTriggerPayloadSchema } from "./scheduled-trigger";

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
