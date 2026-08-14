import { describe, expect, test } from "bun:test";

import {
  channelIdFromPath,
  channelPath,
  channelSettingsPath,
  channelSettingsSectionFromPath,
  isChannelPath,
  isChannelSettingsPath,
} from "./channel-path";

describe("channelPath helpers", () => {
  test("builds canonical /c paths", () => {
    expect(channelPath(null)).toBe("/c");
    expect(channelPath("ch_1")).toBe("/c/ch_1");
    expect(channelPath("ch/with/slash")).toBe("/c/ch%2Fwith%2Fslash");
  });

  test("parses /c and legacy /chat deep links", () => {
    expect(channelIdFromPath("/c")).toBeNull();
    expect(channelIdFromPath("/c/ch_1")).toBe("ch_1");
    expect(channelIdFromPath("/chat/ch_1")).toBe("ch_1");
    expect(channelIdFromPath("/routines")).toBeNull();
  });

  test("isChannelPath covers both prefixes", () => {
    expect(isChannelPath("/c")).toBe(true);
    expect(isChannelPath("/c/ch_1")).toBe(true);
    expect(isChannelPath("/chat")).toBe(true);
    expect(isChannelPath("/chat/ch_1")).toBe(true);
    expect(isChannelPath("/")).toBe(false);
  });
});

describe("channel settings path helpers", () => {
  test("builds the settings stage surface path", () => {
    expect(channelSettingsPath("ch_1")).toBe("/c/ch_1/settings");
  });

  test("builds a section-scoped settings path", () => {
    expect(channelSettingsPath("ch_1", "members")).toBe(
      "/c/ch_1/settings/members",
    );
  });

  test("channelIdFromPath resolves ids under /settings", () => {
    expect(channelIdFromPath("/c/ch_1/settings")).toBe("ch_1");
    expect(channelIdFromPath("/chat/ch_1/settings")).toBe("ch_1");
  });

  test("channelIdFromPath resolves ids under a section-scoped /settings path", () => {
    expect(channelIdFromPath("/c/ch_1/settings/members")).toBe("ch_1");
    expect(channelIdFromPath("/chat/ch_1/settings/agents")).toBe("ch_1");
  });

  test("isChannelSettingsPath is true for /settings and /settings/:section", () => {
    expect(isChannelSettingsPath("/c/ch_1/settings")).toBe(true);
    expect(isChannelSettingsPath("/c/ch_1/settings/members")).toBe(true);
    expect(isChannelSettingsPath("/c/ch_1")).toBe(false);
    expect(isChannelSettingsPath("/c")).toBe(false);
  });

  test("channelSettingsSectionFromPath extracts the trailing section segment", () => {
    expect(channelSettingsSectionFromPath("/c/ch_1/settings/members")).toBe(
      "members",
    );
    expect(channelSettingsSectionFromPath("/chat/ch_1/settings/agents")).toBe(
      "agents",
    );
    expect(channelSettingsSectionFromPath("/c/ch_1/settings")).toBeUndefined();
    expect(channelSettingsSectionFromPath("/c/ch_1")).toBeUndefined();
  });
});
