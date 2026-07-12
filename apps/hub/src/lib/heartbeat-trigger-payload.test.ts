import { describe, expect, it } from "bun:test";
import {
  computeHeartbeatCreatedAfter,
  enrichHeartbeatTriggerPayload,
} from "./heartbeat-trigger-payload";

const MS_PER_DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 9, 9, 0, 0);
const TODAY = Math.floor(NOW / MS_PER_DAY);

describe("computeHeartbeatCreatedAfter", () => {
  it("uses the last fire's exact instant when it is known and recent", () => {
    const yesterday = TODAY - 1;
    const result = computeHeartbeatCreatedAfter(NOW, yesterday, 9);
    expect(result).toBe(
      new Date(yesterday * MS_PER_DAY + 9 * 3_600_000).toISOString(),
    );
  });

  it("falls back to now minus 24h when the schedule has never fired", () => {
    const result = computeHeartbeatCreatedAfter(NOW, null, 9);
    expect(result).toBe(new Date(NOW - 24 * 3_600_000).toISOString());
  });

  it("clamps a stale last fire to at most 7 days back", () => {
    const staleDay = TODAY - 30;
    const result = computeHeartbeatCreatedAfter(NOW, staleDay, 9);
    expect(result).toBe(new Date(NOW - 7 * MS_PER_DAY).toISOString());
  });
});

describe("enrichHeartbeatTriggerPayload", () => {
  it("adds the resolved enabledSources and createdAfter when the fire kind matches the heartbeat kind", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat", userAddress: "usr_1@d" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
    );
    expect(result).toEqual({
      reason: "scheduled-heartbeat",
      userAddress: "usr_1@d",
      enabledSources: ["granola"],
      createdAfter: new Date(NOW - 24 * 3_600_000).toISOString(),
    });
  });

  it("leaves a non-heartbeat schedule's payload untouched", () => {
    const original = { reason: "some-other-trigger" };
    const result = enrichHeartbeatTriggerPayload(
      original,
      "some-attached-workflow",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
    );
    expect(result).toBe(original);
  });

  it("overwrites a stale enabledSources from a previously-stored payload", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat", enabledSources: ["granola"] },
      "heartbeat",
      "heartbeat",
      [],
      NOW,
      null,
      9,
    );
    expect(result.enabledSources).toEqual([]);
  });

  it("derives createdAfter from the last fire's day and hour", () => {
    const yesterday = TODAY - 1;
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat" },
      "heartbeat",
      "heartbeat",
      [],
      NOW,
      yesterday,
      9,
    );
    expect(result.createdAfter).toBe(
      new Date(yesterday * MS_PER_DAY + 9 * 3_600_000).toISOString(),
    );
  });
});
