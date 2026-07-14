import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  BriefSourceFetchInputSchema,
  HeartbeatRunTriggerPayloadSchema,
} from "@workbench/shared";
import {
  computeHeartbeatCreatedAfter,
  computeManualBriefCreatedAfter,
  enrichHeartbeatTriggerPayload,
} from "./heartbeat-trigger-payload";

const MS_PER_DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 9, 9, 0, 0);
const TODAY = Math.floor(NOW / MS_PER_DAY);
const MEMBER_IDENTITY = {
  userAddress: "usr_1@d",
  userRefId: "ref-1",
};

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

describe("computeManualBriefCreatedAfter", () => {
  it("uses the full 7-day lookback for on-demand briefs", () => {
    expect(computeManualBriefCreatedAfter(NOW)).toBe(
      new Date(NOW - 7 * MS_PER_DAY).toISOString(),
    );
  });
});

describe("enrichHeartbeatTriggerPayload", () => {
  it("adds the resolved enabledSources and createdAfter when the fire kind matches the heartbeat kind", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat", userAddress: "usr_stale@d" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
      "scheduled",
      MEMBER_IDENTITY,
    );
    expect(result).toEqual({
      reason: "scheduled-heartbeat",
      userAddress: "usr_1@d",
      userRefId: "ref-1",
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
      "scheduled",
      MEMBER_IDENTITY,
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
      "scheduled",
      MEMBER_IDENTITY,
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
      "scheduled",
      MEMBER_IDENTITY,
    );
    expect(result.createdAfter).toBe(
      new Date(yesterday * MS_PER_DAY + 9 * 3_600_000).toISOString(),
    );
  });

  it("overwrites stale mail identity from the stored schedule row at fire time", () => {
    const result = enrichHeartbeatTriggerPayload(
      {
        reason: "scheduled-heartbeat",
        userAddress: "usr_old@workbench.local",
        userRefId: "old",
      },
      "heartbeat",
      "heartbeat",
      [],
      NOW,
      null,
      9,
      "scheduled",
      { userAddress: "usr_new@workbench.local", userRefId: "new" },
    );
    expect(result.userAddress).toBe("usr_new@workbench.local");
    expect(result.userRefId).toBe("new");
  });

  it("injects mail identity at fire time when the stored schedule row omitted it", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
      "scheduled",
      { userAddress: "usr_abc@workbench.local", userRefId: "abc" },
    );
    expect(result.userAddress).toBe("usr_abc@workbench.local");
    expect(result.userRefId).toBe("abc");
  });

  it("carries userDisplayName into the payload when the identity resolver knows it", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
      "scheduled",
      {
        userAddress: "usr_abc@d",
        userRefId: "abc",
        userDisplayName: "Jordan Lee",
      },
    );
    expect(result.userDisplayName).toBe("Jordan Lee");
  });

  it("omits userDisplayName when the identity resolver has none", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
      "scheduled",
      MEMBER_IDENTITY,
    );
    expect("userDisplayName" in result).toBe(false);
  });

  it("manual-refresh ignores last fire and uses the 7-day window", () => {
    const yesterday = TODAY - 1;
    const result = enrichHeartbeatTriggerPayload(
      { reason: "manual-brief" },
      "heartbeat",
      "heartbeat",
      ["granola", "linear"],
      NOW,
      yesterday,
      9,
      "manual-refresh",
      MEMBER_IDENTITY,
    );
    expect(result.createdAfter).toBe(
      new Date(NOW - 7 * MS_PER_DAY).toISOString(),
    );
    expect(result.enabledSources).toEqual(["granola", "linear"]);
  });

  // Contract-conformance seam: every wired brief source's fetch tool
  // validates its args through `BriefSourceFetchInputSchema`
  // (`@workbench/shared`). This proves the hub's enriched trigger payload —
  // what every heartbeat intake step actually receives as
  // `{ from: "trigger.payload" }` — satisfies that same schema, so the
  // producer (this file) and every consumer (each source's fetch tool)
  // cannot silently drift on the enabledSources/createdAfter shape.
  it("the enriched payload satisfies BriefSourceFetchInputSchema and HeartbeatRunTriggerPayloadSchema", () => {
    const result = enrichHeartbeatTriggerPayload(
      { reason: "scheduled-heartbeat" },
      "heartbeat",
      "heartbeat",
      ["granola"],
      NOW,
      null,
      9,
      "scheduled",
      MEMBER_IDENTITY,
    );
    expect(BriefSourceFetchInputSchema(result) instanceof type.errors).toBe(
      false,
    );
    expect(
      HeartbeatRunTriggerPayloadSchema(result) instanceof type.errors,
    ).toBe(false);
  });
});
