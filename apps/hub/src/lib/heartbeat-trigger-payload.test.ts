import { describe, expect, it } from "bun:test";
import { enrichHeartbeatTriggerPayload } from "./heartbeat-trigger-payload";

describe("enrichHeartbeatTriggerPayload", () => {
  it("adds the resolved enabledSources when the fire kind matches the heartbeat kind", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat", userAddress: "usr_1@d" },
      "heartbeat",
      "heartbeat",
      ["granola"],
    );
    expect(result).toEqual({
      reason: "scheduled-heartbeat",
      userAddress: "usr_1@d",
      enabledSources: ["granola"],
    });
  });

  it("leaves a non-heartbeat schedule's payload untouched", () => {
    const original = { reason: "some-other-trigger" };
    const result = enrichHeartbeatTriggerPayload(
      original,
      "some-attached-workflow",
      "heartbeat",
      ["granola"],
    );
    expect(result).toBe(original);
  });

  it("overwrites a stale enabledSources from a previously-stored payload", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat", enabledSources: ["granola"] },
      "heartbeat",
      "heartbeat",
      [],
    );
    expect(result.enabledSources).toEqual([]);
  });
});
