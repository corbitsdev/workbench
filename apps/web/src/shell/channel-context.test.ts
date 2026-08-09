import { describe, expect, test } from "bun:test";

import type { Channel } from "@corbits/chat-ui";

import { resolveChannelTitle } from "./channel-context";
import type { BenchActivityQuery } from "./bench-activity";

const channel = (partial: {
  id: string;
  title: string;
  kind?: string;
}): Channel =>
  ({
    id: partial.id,
    title: partial.title,
    kind: partial.kind ?? "channel",
    pinned: false,
    participants: [],
  }) as Channel;

const ready: BenchActivityQuery = {
  kind: "ready",
  channels: [channel({ id: "ch_1", title: "Myra" })],
  chats: [channel({ id: "ch_2", title: "  ", kind: "chat" })],
  routines: [],
};

describe("resolveChannelTitle", () => {
  test("returns null without a channel id", () => {
    expect(resolveChannelTitle(ready, null)).toBeNull();
  });

  test("returns null while activity is loading", () => {
    expect(resolveChannelTitle({ kind: "loading" }, "ch_1")).toBeNull();
  });

  test("returns the channel title when found", () => {
    expect(resolveChannelTitle(ready, "ch_1")).toBe("Myra");
  });

  test("falls back to Untitled channel for blank titles", () => {
    expect(resolveChannelTitle(ready, "ch_2")).toBe("Untitled channel");
  });

  test("returns null when the channel is not in the list", () => {
    expect(resolveChannelTitle(ready, "ch_missing")).toBeNull();
  });
});
