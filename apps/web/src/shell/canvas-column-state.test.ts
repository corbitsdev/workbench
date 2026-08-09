import { describe, expect, test } from "bun:test";

import {
  applyChannelPathToCanvas,
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
    expect(openChannelInCanvas("ch_1")).toEqual({
      open: true,
      channelId: "ch_1",
    });
  });

  test("toggle preserves the loaded channel", () => {
    const open = openChannelInCanvas("ch_1");
    const closed = toggleCanvasColumn(open);
    expect(closed).toEqual({ open: false, channelId: "ch_1" });
    expect(toggleCanvasColumn(closed)).toEqual(open);
  });

  test("a /c deep link opens the canvas onto that channel", () => {
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/c/ch_deep"),
    ).toEqual({ open: true, channelId: "ch_deep" });
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/chat/ch_legacy"),
    ).toEqual({ open: true, channelId: "ch_legacy" });
  });

  test("non-channel paths leave canvas state alone", () => {
    const open = openChannelInCanvas("ch_1");
    expect(applyChannelPathToCanvas(open, "/agents")).toEqual(open);
    expect(applyChannelPathToCanvas(initialCanvasColumnState(), "/")).toEqual(
      initialCanvasColumnState(),
    );
  });

  test("visibility is gated by the viewport allow flag", () => {
    const open = openChannelInCanvas("ch_1");
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(initialCanvasColumnState(), true)).toBe(
      false,
    );
  });
});
