import { afterEach, describe, expect, test } from "bun:test";

import {
  findMyraChannel,
  isMyraChannelId,
  isMyraChannelTitle,
  MYRA_CHANNEL_TITLE,
  resetMyraChannelCache,
} from "./myra-channel";
import type { Channel } from "@corbits/chat-ui";

function channel(partial: {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
}): Channel {
  return {
    id: partial.id,
    title: partial.title,
    kind: partial.kind ?? "channel",
    pinned: false,
    participants: [],
  };
}

describe("myra-channel helpers", () => {
  afterEach(() => {
    resetMyraChannelCache();
  });

  test("isMyraChannelId is false until a channel id is cached", () => {
    expect(isMyraChannelId("chan-1")).toBe(false);
    expect(isMyraChannelId(null)).toBe(false);
  });

  test("MYRA_CHANNEL_TITLE is Myra", () => {
    expect(MYRA_CHANNEL_TITLE).toBe("Myra");
  });

  test("isMyraChannelTitle is case-insensitive and trims", () => {
    expect(isMyraChannelTitle("Myra")).toBe(true);
    expect(isMyraChannelTitle(" myra ")).toBe(true);
    expect(isMyraChannelTitle("MYRA")).toBe(true);
    expect(isMyraChannelTitle("Myra chat")).toBe(false);
    expect(isMyraChannelTitle("Assistant")).toBe(false);
  });

  test("findMyraChannel returns the first Myra-titled row", () => {
    const items = [
      channel({ id: "a", title: "general" }),
      channel({ id: "b", title: "myra" }),
      channel({ id: "c", title: "Myra" }),
    ];
    expect(findMyraChannel(items)?.id).toBe("b");
  });

  test("findMyraChannel returns undefined when none match", () => {
    expect(
      findMyraChannel([channel({ id: "a", title: "general" })]),
    ).toBeUndefined();
  });
});
