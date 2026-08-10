import { describe, expect, test } from "bun:test";

import {
  applyChannelPathToCanvas,
  clearProfileInCanvas,
  initialCanvasColumnState,
  openChannelInCanvas,
  openProfileInCanvas,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "./canvas-column-state";

const sampleProfile = {
  kind: "member" as const,
  address: "u1@example.com",
  handle: "ada",
  displayName: "Ada",
  initials: "AD",
};

describe("canvas column state", () => {
  test("starts closed with no channel or profile", () => {
    expect(initialCanvasColumnState()).toEqual({
      open: false,
      channelId: null,
      profile: null,
    });
  });

  test("opening a channel loads it and opens the canvas", () => {
    expect(openChannelInCanvas("ch_1")).toEqual({
      open: true,
      channelId: "ch_1",
      profile: null,
    });
  });

  test("toggle preserves the loaded channel", () => {
    const open = openChannelInCanvas("ch_1");
    const closed = toggleCanvasColumn(open);
    expect(closed).toEqual({ open: false, channelId: "ch_1", profile: null });
    expect(toggleCanvasColumn(closed)).toEqual(open);
  });

  test("a /c deep link opens the canvas onto that channel", () => {
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/c/ch_deep"),
    ).toEqual({ open: true, channelId: "ch_deep", profile: null });
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/chat/ch_legacy"),
    ).toEqual({ open: true, channelId: "ch_legacy", profile: null });
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

  test("opening a profile keeps the channel and sets profile", () => {
    const open = openChannelInCanvas("ch_1");
    const withProfile = openProfileInCanvas(open, sampleProfile);
    expect(withProfile).toEqual({
      open: true,
      channelId: "ch_1",
      profile: sampleProfile,
    });
    expect(clearProfileInCanvas(withProfile)).toEqual({
      open: true,
      channelId: "ch_1",
      profile: null,
    });
  });

  test("opening a channel clears any profile", () => {
    const withProfile = openProfileInCanvas(
      openChannelInCanvas("ch_1"),
      sampleProfile,
    );
    expect(openChannelInCanvas("ch_2").profile).toBe(null);
    expect(withProfile.channelId).toBe("ch_1");
  });
});
