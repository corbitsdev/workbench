import { describe, expect, test } from "bun:test";

import {
  clearArtifactInCanvas,
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  closeCanvasContent,
  focusCanvas,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  unfocusCanvas,
  type CanvasColumnState,
} from "./canvas-column-state";

type TestProfile = { readonly id: string };
type TestArtifact = { readonly id: string };

function initial(): CanvasColumnState<TestProfile, TestArtifact> {
  return initialCanvasColumnState<TestProfile, TestArtifact>();
}

const sampleProfile: TestProfile = { id: "profile-1" };
const otherProfile: TestProfile = { id: "profile-2" };
const sampleArtifact: TestArtifact = { id: "artifact-1" };

describe("canvas column state", () => {
  test("starts closed with no profile or artifact, not focused", () => {
    expect(initial()).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("opening a profile stamps the subject, opens the canvas, and clears any artifact", () => {
    const withArtifact = openArtifactInCanvas(initial(), sampleArtifact);
    expect(openProfileInCanvas(withArtifact, sampleProfile)).toEqual({
      open: true,
      profile: sampleProfile,
      artifact: null,
      focus: false,
    });
  });

  test("opening a profile replaces any prior profile", () => {
    const withFirst = openProfileInCanvas(initial(), sampleProfile);
    expect(openProfileInCanvas(withFirst, otherProfile)).toEqual({
      open: true,
      profile: otherProfile,
      artifact: null,
      focus: false,
    });
  });

  test("clearing a profile closes the canvas and drops focus", () => {
    const withProfile = focusCanvas(
      openProfileInCanvas(initial(), sampleProfile),
    );
    expect(clearProfileInCanvas(withProfile)).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("opening an artifact stamps the content, opens the canvas, and clears any profile", () => {
    const withProfile = openProfileInCanvas(initial(), sampleProfile);
    expect(openArtifactInCanvas(withProfile, sampleArtifact)).toEqual({
      open: true,
      profile: null,
      artifact: sampleArtifact,
      focus: false,
    });
  });

  test("clearing an artifact closes the canvas and drops focus", () => {
    const withArtifact = focusCanvas(
      openArtifactInCanvas(initial(), sampleArtifact),
    );
    expect(clearArtifactInCanvas(withArtifact)).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("focusCanvas opens the canvas and enters focus", () => {
    expect(focusCanvas(initial())).toEqual({
      open: true,
      profile: null,
      artifact: null,
      focus: true,
    });
  });

  test("unfocusCanvas exits focus without closing the canvas", () => {
    const focused = focusCanvas(initial());
    expect(unfocusCanvas(focused)).toEqual({
      open: true,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("toggleCanvasFocus is a no-op when nothing is open", () => {
    expect(toggleCanvasFocus(initial())).toEqual(initial());
  });

  test("toggleCanvasFocus cycles focus on and off once content is open", () => {
    const open = openProfileInCanvas(initial(), sampleProfile);
    const focused = toggleCanvasFocus(open);
    expect(focused.focus).toBe(true);
    expect(toggleCanvasFocus(focused).focus).toBe(false);
  });

  test("closeCanvasContent clears whichever of profile or artifact is open", () => {
    const withProfile = openProfileInCanvas(initial(), sampleProfile);
    expect(closeCanvasContent(withProfile)).toEqual(initial());

    const withArtifact = openArtifactInCanvas(initial(), sampleArtifact);
    expect(closeCanvasContent(withArtifact)).toEqual(initial());
  });

  test("canvas focus is gated by the viewport allow flag, same as visibility", () => {
    const focused = focusCanvas(initial());
    expect(resolveCanvasFocus(focused, true)).toBe(true);
    expect(resolveCanvasFocus(focused, false)).toBe(false);
    expect(resolveCanvasFocus(initial(), true)).toBe(false);
  });

  test("visibility is gated by the viewport allow flag", () => {
    const open = openProfileInCanvas(initial(), sampleProfile);
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(initial(), true)).toBe(false);
  });

  test("workbench switch clears profile, artifact, and open flag", () => {
    const open = openProfileInCanvas(initial(), sampleProfile);
    expect(clearCanvasForTenantSwitch<TestProfile, TestArtifact>()).toEqual(
      initial(),
    );
    expect(open.profile).toEqual(sampleProfile);
    expect(
      clearCanvasForTenantSwitch<TestProfile, TestArtifact>().profile,
    ).toBeNull();
  });
});
