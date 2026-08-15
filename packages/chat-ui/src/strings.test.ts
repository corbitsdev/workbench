import { describe, expect, test } from "bun:test";

import { CHAT_STRINGS } from "./strings";

describe("toast confirmation copy", () => {
  test("channel create carries the new channel's title", () => {
    expect(CHAT_STRINGS.channelCreatedToast("Launch planning")).toBe(
      "Created · Launch planning",
    );
  });

  test("rename confirms the title the channel now has", () => {
    expect(CHAT_STRINGS.channelRenamedToast("Growth")).toBe(
      "Renamed to Growth",
    );
  });

  test("pin copy follows the state the channel just entered", () => {
    expect(CHAT_STRINGS.channelPinnedToast(true, "Deploy notes")).toBe(
      "Pinned Deploy notes",
    );
    expect(CHAT_STRINGS.channelPinnedToast(false, "Deploy notes")).toBe(
      "Unpinned Deploy notes",
    );
  });
});
