import { describe, expect, test } from "bun:test";

import type { Channel } from "@corbits/chat-ui";

import {
  channelIdForWorkbenchTenant,
  resolveChannelInsightsScope,
} from "./insights-channel-scope";

function channel(overrides: Partial<Channel> & { id: string }): Channel {
  return {
    title: "Growth",
    kind: "channel",
    pinned: false,
    participants: [],
    tenancy: null,
    ...overrides,
  } as Channel;
}

describe("resolveChannelInsightsScope", () => {
  test("resolves a channel's own workbench tenant", () => {
    const channels = [
      channel({ id: "ch_1", title: "Growth", tenancy: { tenantId: "tnt_1" } }),
    ];
    expect(resolveChannelInsightsScope(channels, "ch_1")).toEqual({
      kind: "ready",
      tenantId: "tnt_1",
      title: "Growth",
    });
  });

  test("reports a true legacy channel (tenancy null) distinctly", () => {
    const channels = [channel({ id: "ch_2", tenancy: null })];
    expect(resolveChannelInsightsScope(channels, "ch_2")).toEqual({
      kind: "legacy",
    });
  });

  test("reports not-found for an id absent from the bench's channel list", () => {
    const channels = [channel({ id: "ch_1", tenancy: { tenantId: "tnt_1" } })];
    expect(resolveChannelInsightsScope(channels, "tnt_stale")).toEqual({
      kind: "not-found",
    });
  });
});

describe("channelIdForWorkbenchTenant", () => {
  test("finds the channel that carries a given workbench tenant", () => {
    const channels = [
      channel({ id: "ch_1", tenancy: { tenantId: "tnt_1" } }),
      channel({ id: "ch_2", tenancy: { tenantId: "tnt_2" } }),
    ];
    expect(channelIdForWorkbenchTenant(channels, "tnt_2")).toBe("ch_2");
  });

  test("returns null when no channel carries that tenancy", () => {
    const channels = [channel({ id: "ch_1", tenancy: null })];
    expect(channelIdForWorkbenchTenant(channels, "tnt_9")).toBeNull();
  });
});
