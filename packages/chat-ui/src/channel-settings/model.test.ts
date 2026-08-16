import { describe, expect, test } from "bun:test";

import { channelSettingsSections } from "./model";

describe("channelSettingsSections", () => {
  test("channels expose the full settings surface", () => {
    expect(channelSettingsSections("channel").map((s) => s.id)).toEqual([
      "general",
      "members",
      "agents",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
      "danger",
    ]);
  });

  test("1:1 chats trim Members and Danger zone", () => {
    expect(channelSettingsSections("chat").map((s) => s.id)).toEqual([
      "general",
      "agents",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
    ]);
  });

  test("a DM chat additionally trims Agents — no agent participant, nothing to invite", () => {
    expect(channelSettingsSections("chat", true).map((s) => s.id)).toEqual([
      "general",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
    ]);
  });

  test("an agent chat keeps Agents when isDm is explicitly false", () => {
    expect(channelSettingsSections("chat", false).map((s) => s.id)).toEqual([
      "general",
      "agents",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
    ]);
  });

  test("isDm is ignored for a channel — Agents stays regardless", () => {
    expect(channelSettingsSections("channel", true).map((s) => s.id)).toEqual([
      "general",
      "members",
      "agents",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
      "danger",
    ]);
  });

  test("Assistant is absent by default — no agent, nothing to edit", () => {
    expect(channelSettingsSections("chat").map((s) => s.id)).not.toContain(
      "assistant",
    );
    expect(channelSettingsSections("channel").map((s) => s.id)).not.toContain(
      "assistant",
    );
  });

  test("Assistant appears right after Agents when the channel has one", () => {
    expect(
      channelSettingsSections("channel", false, true).map((s) => s.id),
    ).toEqual([
      "general",
      "members",
      "agents",
      "assistant",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
      "danger",
    ]);
  });

  test("an agent chat with hasAgent shows Assistant even though Members is trimmed", () => {
    expect(
      channelSettingsSections("chat", false, true).map((s) => s.id),
    ).toEqual([
      "general",
      "agents",
      "assistant",
      "keys-plugins",
      "inference",
      "access",
      "notifications",
    ]);
  });

  test("Keys & plugins and Inference are always present, regardless of channel kind", () => {
    expect(channelSettingsSections("channel").map((s) => s.id)).toContain(
      "keys-plugins",
    );
    expect(channelSettingsSections("channel").map((s) => s.id)).toContain(
      "inference",
    );
    expect(channelSettingsSections("chat", true).map((s) => s.id)).toContain(
      "keys-plugins",
    );
    expect(channelSettingsSections("chat", true).map((s) => s.id)).toContain(
      "inference",
    );
  });

  test("groups sections Shared / Personal / Danger for the nav", () => {
    const groups = channelSettingsSections("channel").map((s) => s.group);
    expect(groups).toEqual([
      "shared",
      "shared",
      "shared",
      "shared",
      "shared",
      "shared",
      "personal",
      "danger",
    ]);
  });
});
