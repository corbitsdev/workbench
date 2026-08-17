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

describe("agentsTyping copy", () => {
  test("one name reads as a single typist", () => {
    expect(CHAT_STRINGS.agentsTyping(["Myra"])).toBe("Myra is typing…");
  });

  test("two names are joined with 'and'", () => {
    expect(CHAT_STRINGS.agentsTyping(["Myra", "Scribe"])).toBe(
      "Myra and Scribe are typing…",
    );
  });

  test("three or more collapse the rest into 'and N others'", () => {
    expect(CHAT_STRINGS.agentsTyping(["Myra", "Scribe", "Tally"])).toBe(
      "Myra, Scribe and 1 other are typing…",
    );
    expect(
      CHAT_STRINGS.agentsTyping(["Myra", "Scribe", "Tally", "Nova"]),
    ).toBe("Myra, Scribe and 2 others are typing…");
  });

  test("no names renders nothing to say", () => {
    expect(CHAT_STRINGS.agentsTyping([])).toBe("");
  });
});
