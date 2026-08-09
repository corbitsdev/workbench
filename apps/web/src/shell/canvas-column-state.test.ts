import { describe, expect, test } from "bun:test";

import {
  closeCanvasColumn,
  initialCanvasColumnState,
  openChannelInCanvas,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "./canvas-column-state";

describe("canvas column state", () => {
  test("starts closed with no channel", () => {
    expect(initialCanvasColumnState()).toEqual({
      open: false,
      channelId: null,
    });
  });

  test("opening a channel loads it and opens the canvas", () => {
    const next = openChannelInCanvas(initialCanvasColumnState(), "ch_1");
    expect(next).toEqual({ open: true, channelId: "ch_1" });
  });

  test("toggle preserves the loaded channel", () => {
    const open = openChannelInCanvas(initialCanvasColumnState(), "ch_1");
    const closed = toggleCanvasColumn(open);
    expect(closed).toEqual({ open: false, channelId: "ch_1" });
    expect(toggleCanvasColumn(closed)).toEqual(open);
  });

  test("close drops the channel", () => {
    const open = openChannelInCanvas(initialCanvasColumnState(), "ch_1");
    expect(closeCanvasColumn(open)).toEqual({ open: false, channelId: null });
  });

  test("visibility is gated by the viewport allow flag", () => {
    const open = openChannelInCanvas(initialCanvasColumnState(), "ch_1");
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(initialCanvasColumnState(), true)).toBe(
      false,
    );
  });
});
