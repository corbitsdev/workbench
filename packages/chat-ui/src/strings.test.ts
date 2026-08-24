import { describe, expect, test } from "bun:test";

import { CHAT_STRINGS } from "./strings";

describe("toast confirmation copy", () => {
  test("workbench create carries the new workbench's title", () => {
    expect(CHAT_STRINGS.workbenchCreatedToast("Launch planning")).toBe(
      "Created · Launch planning",
    );
  });

  test("rename confirms the title the workbench now has", () => {
    expect(CHAT_STRINGS.workbenchRenamedToast("Growth")).toBe(
      "Renamed to Growth",
    );
  });

  test("pin copy follows the state the workbench just entered", () => {
    expect(CHAT_STRINGS.workbenchPinnedToast(true, "Deploy notes")).toBe(
      "Pinned Deploy notes",
    );
    expect(CHAT_STRINGS.workbenchPinnedToast(false, "Deploy notes")).toBe(
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
    expect(CHAT_STRINGS.agentsTyping(["Myra", "Scribe", "Tally", "Nova"])).toBe(
      "Myra, Scribe and 2 others are typing…",
    );
  });

  test("no names renders nothing to say", () => {
    expect(CHAT_STRINGS.agentsTyping([])).toBe("");
  });
});

describe("approve vs deny vs form action copy", () => {
  test("deny forbidden and error are distinct from approve copy", () => {
    expect(CHAT_STRINGS.blockDenyActionForbidden).toBe(
      "You do not have permission to deny this.",
    );
    expect(CHAT_STRINGS.blockDenyActionError).toBe(
      "Couldn't deny this request.",
    );
    expect(CHAT_STRINGS.blockDenyActionForbidden).not.toBe(
      CHAT_STRINGS.blockApproveActionForbidden,
    );
    expect(CHAT_STRINGS.blockDenyActionError).not.toBe(
      CHAT_STRINGS.blockApproveActionError,
    );
  });

  test("form submit forbidden is respond copy, not approve copy", () => {
    expect(CHAT_STRINGS.blockFormSubmitForbidden).toBe(
      "You do not have permission to respond in this conversation.",
    );
    expect(CHAT_STRINGS.blockFormSubmitForbidden).not.toBe(
      CHAT_STRINGS.blockApproveActionForbidden,
    );
  });
});
