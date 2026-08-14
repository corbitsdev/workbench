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

  test("a DM chat additionally trims Agents — no agent participant, nothing to invite", () => {
    expect(channelSettingsSections("chat", true).map((s) => s.id)).toEqual([
      "general",
      "access",
      "notifications",
    ]);
  });

  test("an agent chat keeps Agents when isDm is explicitly false", () => {
    expect(channelSettingsSections("chat", false).map((s) => s.id)).toEqual([
      "general",
      "agents",
      "access",
      "notifications",
    ]);
  });

  test("isDm is ignored for a channel — Agents stays regardless", () => {
    expect(channelSettingsSections("channel", true).map((s) => s.id)).toEqual([
      "general",
      "members",
      "agents",
      "access",
      "notifications",
      "danger",
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
