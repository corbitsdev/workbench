import { describe, expect, test } from "bun:test";

import {
  applyChannelPathToCanvas,
  channelIdForTenant,
  clearCanvasForTenantSwitch,
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
      channelTenantId: null,
      profile: null,
    });
  });

  test("opening a channel stamps the workbench and opens the canvas", () => {
    expect(openChannelInCanvas("ch_1", "tnt_a")).toEqual({
      open: true,
      channelId: "ch_1",
      channelTenantId: "tnt_a",
      profile: null,
    });
  });

  test("toggle preserves the loaded channel and workbench stamp", () => {
    const open = openChannelInCanvas("ch_1", "tnt_a");
    const closed = toggleCanvasColumn(open);
    expect(closed).toEqual({
      open: false,
      channelId: "ch_1",
      channelTenantId: "tnt_a",
      profile: null,
    });
    expect(toggleCanvasColumn(closed)).toEqual(open);
  });

  test("a /c deep link opens the canvas onto that channel for the workbench", () => {
    expect(
      applyChannelPathToCanvas(
        initialCanvasColumnState(),
        "/c/ch_deep",
        "tnt_a",
      ),
    ).toEqual({
      open: true,
      channelId: "ch_deep",
      channelTenantId: "tnt_a",
      profile: null,
    });
    expect(
      applyChannelPathToCanvas(
        initialCanvasColumnState(),
        "/chat/ch_legacy",
        "tnt_a",
      ),
    ).toEqual({
      open: true,
      channelId: "ch_legacy",
      channelTenantId: "tnt_a",
      profile: null,
    });
  });

  test("deep link without a workbench does not open a channel", () => {
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/c/ch_deep", null),
    ).toEqual(initialCanvasColumnState());
  });

  test("non-channel paths leave canvas state alone", () => {
    const open = openChannelInCanvas("ch_1", "tnt_a");
    expect(applyChannelPathToCanvas(open, "/agents", "tnt_a")).toEqual(open);
    expect(
      applyChannelPathToCanvas(initialCanvasColumnState(), "/", "tnt_a"),
    ).toEqual(initialCanvasColumnState());
  });

  test("visibility is gated by the viewport allow flag", () => {
    const open = openChannelInCanvas("ch_1", "tnt_a");
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(initialCanvasColumnState(), true)).toBe(
      false,
    );
  });

  test("opening a profile keeps the channel and sets profile", () => {
    const open = openChannelInCanvas("ch_1", "tnt_a");
    const withProfile = openProfileInCanvas(open, sampleProfile);
    expect(withProfile).toEqual({
      open: true,
      channelId: "ch_1",
      channelTenantId: "tnt_a",
      profile: sampleProfile,
    });
    expect(clearProfileInCanvas(withProfile)).toEqual({
      open: true,
      channelId: "ch_1",
      channelTenantId: "tnt_a",
      profile: null,
    });
  });

  test("opening a channel clears any profile", () => {
    const withProfile = openProfileInCanvas(
      openChannelInCanvas("ch_1", "tnt_a"),
      sampleProfile,
    );
    expect(openChannelInCanvas("ch_2", "tnt_a").profile).toBe(null);
    expect(withProfile.channelId).toBe("ch_1");
  });

  test("channel id is only visible for the workbench it was opened under", () => {
    const open = openChannelInCanvas("ch_1", "tnt_a");
    expect(channelIdForTenant(open, "tnt_a")).toBe("ch_1");
    expect(channelIdForTenant(open, "tnt_b")).toBeNull();
    expect(channelIdForTenant(open, null)).toBeNull();
    expect(channelIdForTenant(initialCanvasColumnState(), "tnt_a")).toBeNull();
  });

  test("workbench switch clears channel, profile, and open flag", () => {
    const open = openProfileInCanvas(
      openChannelInCanvas("ch_1", "tnt_a"),
      sampleProfile,
    );
    expect(clearCanvasForTenantSwitch()).toEqual(initialCanvasColumnState());
    expect(
      channelIdForTenant(clearCanvasForTenantSwitch(), "tnt_b"),
    ).toBeNull();
    expect(open.channelTenantId).toBe("tnt_a");
  });
});
