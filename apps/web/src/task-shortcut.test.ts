import { describe, expect, test } from "bun:test";

import { isNewTaskShortcutEvent } from "./task-shortcut";

function event(
  overrides: Partial<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    repeat: boolean;
    target: EventTarget | null;
  }> = {},
) {
  return {
    key: "t",
    metaKey: true,
    ctrlKey: false,
    repeat: false,
    target: null,
    ...overrides,
  };
}

describe("isNewTaskShortcutEvent", () => {
  test("fires on Cmd+T", () => {
    expect(
      isNewTaskShortcutEvent(event({ metaKey: true, ctrlKey: false })),
    ).toBe(true);
  });

  test("fires on Ctrl+T without OS-sniffing", () => {
    expect(
      isNewTaskShortcutEvent(event({ metaKey: false, ctrlKey: true })),
    ).toBe(true);
  });

  test("is case-insensitive on the key", () => {
    expect(isNewTaskShortcutEvent(event({ key: "T" }))).toBe(true);
  });

  test("ignores a plain 't' with no modifier", () => {
    expect(
      isNewTaskShortcutEvent(event({ metaKey: false, ctrlKey: false })),
    ).toBe(false);
  });

  test("ignores a repeated keydown from holding the key", () => {
    expect(isNewTaskShortcutEvent(event({ repeat: true }))).toBe(false);
  });

  test("ignores every other key", () => {
    expect(isNewTaskShortcutEvent(event({ key: "k" }))).toBe(false);
  });

  test("ignores the shortcut while typing in an input", () => {
    const input = document.createElement("input");
    expect(isNewTaskShortcutEvent(event({ target: input }))).toBe(false);
  });

  test("ignores the shortcut while typing in a textarea", () => {
    const textarea = document.createElement("textarea");
    expect(isNewTaskShortcutEvent(event({ target: textarea }))).toBe(false);
  });

  test("ignores the shortcut inside a contentEditable element", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    expect(isNewTaskShortcutEvent(event({ target: div }))).toBe(false);
  });

  test("fires when focus is on an ordinary element", () => {
    const div = document.createElement("div");
    expect(isNewTaskShortcutEvent(event({ target: div }))).toBe(true);
  });
});
