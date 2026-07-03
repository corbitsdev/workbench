/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  DOCKED_BAR_HEIGHT,
  DOCKED_BAR_BOTTOM,
  DOCKED_BAR_TOTAL_HEIGHT,
} from "./DockedChatBar";

describe("DockedChatBar height constants", () => {
  it("uses a fluid, viewport-relative dock height rather than a fixed pixel squeeze", () => {
    // The old 340px fixed height crushed the thread; the fluid value must scale
    // with the viewport so the message thread gets real room.
    expect(DOCKED_BAR_HEIGHT).toContain("vh");
    expect(DOCKED_BAR_HEIGHT).not.toBe("340px");
  });

  it("degrades on a short viewport instead of eating the whole screen", () => {
    // A fixed 360px floor would occupy >75% of a 500px-tall viewport. The height
    // must cap against available height (calc(100vh - …)) so the dock shrinks on
    // short screens rather than holding the floor.
    expect(DOCKED_BAR_HEIGHT).toContain("100vh");
    expect(DOCKED_BAR_HEIGHT).toContain("min(");
  });

  it("derives the layout spacer height from the same source (no double-bookkeeping)", () => {
    // The content-push spacer must be computed from the dock height + bottom
    // offset, not a hand-copied magic number that can drift.
    expect(DOCKED_BAR_TOTAL_HEIGHT).toBe(
      `calc(${DOCKED_BAR_HEIGHT} + ${DOCKED_BAR_BOTTOM})`,
    );
  });
});
