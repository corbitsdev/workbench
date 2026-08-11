import { describe, expect, test } from "bun:test";

import {
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  initialCanvasColumnState,
  openProfileInCanvas,
  resolveCanvasVisibility,
} from "./canvas-column-state";

const sampleProfile = {
  kind: "member" as const,
  address: "u1@example.com",
  handle: "ada",
  displayName: "Ada",
  initials: "AD",
};

const otherProfile = {
  kind: "agent" as const,
  address: "ins_echo@agents.example",
  handle: "echo",
  displayName: "Echo",
  initials: "EC",
};

describe("canvas column state", () => {
  test("starts closed with no profile", () => {
    expect(initialCanvasColumnState()).toEqual({
      open: false,
      profile: null,
    });
  });

  test("opening a profile stamps the subject and opens the canvas", () => {
    expect(
      openProfileInCanvas(initialCanvasColumnState(), sampleProfile),
    ).toEqual({
      open: true,
      profile: sampleProfile,
    });
  });

  test("opening a profile replaces any prior profile", () => {
    const withFirst = openProfileInCanvas(
      initialCanvasColumnState(),
      sampleProfile,
    );
    expect(openProfileInCanvas(withFirst, otherProfile)).toEqual({
      open: true,
      profile: otherProfile,
    });
  });

  test("clearing a profile closes the canvas", () => {
    const withProfile = openProfileInCanvas(
      initialCanvasColumnState(),
      sampleProfile,
    );
    expect(clearProfileInCanvas(withProfile)).toEqual({
      open: false,
      profile: null,
    });
  });

  test("visibility is gated by the viewport allow flag", () => {
    const open = openProfileInCanvas(initialCanvasColumnState(), sampleProfile);
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(initialCanvasColumnState(), true)).toBe(
      false,
    );
  });

  test("workbench switch clears profile and open flag", () => {
    const open = openProfileInCanvas(initialCanvasColumnState(), sampleProfile);
    expect(clearCanvasForTenantSwitch()).toEqual(initialCanvasColumnState());
    expect(open.profile).toEqual(sampleProfile);
    expect(clearCanvasForTenantSwitch().profile).toBeNull();
  });
});
