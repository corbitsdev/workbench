import { describe, expect, test } from "bun:test";

import { channelSettingsSections } from "./model";

describe("channelSettingsSections", () => {
  test("channels expose the full settings surface", () => {
    expect(channelSettingsSections("channel").map((s) => s.id)).toEqual([
      "general",
      "members",
      "agents",
      "access",
      "notifications",
      "danger",
    ]);
  });

  test("1:1 chats trim Members and Danger zone", () => {
    expect(channelSettingsSections("chat").map((s) => s.id)).toEqual([
      "general",
      "agents",
      "access",
      "notifications",
    ]);
  });

  test("groups sections Shared / Personal / Danger for the nav", () => {
    const groups = channelSettingsSections("channel").map((s) => s.group);
    expect(groups).toEqual([
      "shared",
      "shared",
      "shared",
      "shared",
      "personal",
      "danger",
    ]);
  });
});
