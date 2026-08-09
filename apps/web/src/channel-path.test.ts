import { describe, expect, test } from "bun:test";

import { channelIdFromPath, channelPath, isChannelPath } from "./channel-path";

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
