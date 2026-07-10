/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  detectShortcutPlatform,
  formatChord,
  modifierKeyLabel,
  PALETTE_GLOBAL_SHORTCUT_HINTS,
  PALETTE_LOCAL_SHORTCUT_HINTS,
} from "./keyboard-shortcut-display";

describe("keyboard-shortcut-display", () => {
  it("detects mac vs non-mac from platform string", () => {
    expect(detectShortcutPlatform("MacIntel")).toBe("mac");
    expect(detectShortcutPlatform("Win32")).toBe("non-mac");
  });

  it("formats modifier labels per platform", () => {
    expect(modifierKeyLabel("mac")).toBe("⌘");
    expect(modifierKeyLabel("non-mac")).toBe("Ctrl");
  });

  it("formats mod chords", () => {
    expect(formatChord("k", "mac")).toBe("⌘K");
    expect(formatChord("i", "non-mac")).toBe("Ctrl+I");
  });

  it("lists global palette hints for Cmd+K and Cmd+I only", () => {
    expect(PALETTE_GLOBAL_SHORTCUT_HINTS.map((h) => h.keys)).toEqual([
      "K",
      "I",
    ]);
  });

  it("lists in-palette navigation hints", () => {
    expect(PALETTE_LOCAL_SHORTCUT_HINTS.length).toBeGreaterThan(0);
    expect(PALETTE_LOCAL_SHORTCUT_HINTS.some((h) => h.keys === "Esc")).toBe(
      true,
    );
  });
});
