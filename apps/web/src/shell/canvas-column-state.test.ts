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
  type CanvasArtifactContent,
} from "./canvas-column-state";

const sampleArtifact: CanvasArtifactContent = {
  id: "art_1",
  title: "Q1 Parity",
  rendererKind: "sheet",
  content: "A,B\n1,2",
};

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
  test("starts closed with no profile or artifact, not focused", () => {
    expect(initialCanvasColumnState()).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("opening a profile stamps the subject and opens the canvas", () => {
    expect(
      openProfileInCanvas(initialCanvasColumnState(), sampleProfile),
    ).toEqual({
      open: true,
      profile: sampleProfile,
      artifact: null,
      focus: false,
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
      artifact: null,
      focus: false,
    });
  });

  test("opening a profile drops any open artifact", () => {
    const withArtifact = openArtifactInCanvas(
      initialCanvasColumnState(),
      sampleArtifact,
    );
    expect(
      openProfileInCanvas(withArtifact, sampleProfile).artifact,
    ).toBeNull();
  });

  test("clearing a profile closes the canvas and drops focus", () => {
    const withProfile = focusCanvas(
      openProfileInCanvas(initialCanvasColumnState(), sampleProfile),
    );
    expect(clearProfileInCanvas(withProfile)).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("opening an artifact stamps the content and opens the canvas", () => {
    expect(
      openArtifactInCanvas(initialCanvasColumnState(), sampleArtifact),
    ).toEqual({
      open: true,
      profile: null,
      artifact: sampleArtifact,
      focus: false,
    });
  });

  test("opening an artifact drops any open profile", () => {
    const withProfile = openProfileInCanvas(
      initialCanvasColumnState(),
      sampleProfile,
    );
    expect(
      openArtifactInCanvas(withProfile, sampleArtifact).profile,
    ).toBeNull();
  });

  test("clearing an artifact closes the canvas and drops focus", () => {
    const withArtifact = focusCanvas(
      openArtifactInCanvas(initialCanvasColumnState(), sampleArtifact),
    );
    expect(clearArtifactInCanvas(withArtifact)).toEqual({
      open: false,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("closeCanvasContent closes whichever content is open", () => {
    const withProfile = openProfileInCanvas(
      initialCanvasColumnState(),
      sampleProfile,
    );
    expect(closeCanvasContent(withProfile).open).toBe(false);

    const withArtifact = openArtifactInCanvas(
      initialCanvasColumnState(),
      sampleArtifact,
    );
    expect(closeCanvasContent(withArtifact).open).toBe(false);
    expect(closeCanvasContent(withArtifact).artifact).toBeNull();
  });

  test("toggleCanvasFocus cycles open content between the even split and focus", () => {
    const withArtifact = openArtifactInCanvas(
      initialCanvasColumnState(),
      sampleArtifact,
    );
    const focused = toggleCanvasFocus(withArtifact);
    expect(focused.focus).toBe(true);
    const unfocused = toggleCanvasFocus(focused);
    expect(unfocused.focus).toBe(false);
    expect(unfocused.artifact).toEqual(sampleArtifact);
  });

  test("toggleCanvasFocus is a no-op when the canvas has nothing open", () => {
    expect(toggleCanvasFocus(initialCanvasColumnState()).focus).toBe(false);
  });

  test("focusCanvas opens the canvas and enters focus", () => {
    expect(focusCanvas(initialCanvasColumnState())).toEqual({
      open: true,
      profile: null,
      artifact: null,
      focus: true,
    });
  });

  test("unfocusCanvas exits focus without closing the canvas", () => {
    const focused = focusCanvas(initialCanvasColumnState());
    expect(unfocusCanvas(focused)).toEqual({
      open: true,
      profile: null,
      artifact: null,
      focus: false,
    });
  });

  test("canvas focus is gated by the viewport allow flag, same as visibility", () => {
    const focused = focusCanvas(initialCanvasColumnState());
    expect(resolveCanvasFocus(focused, true)).toBe(true);
    expect(resolveCanvasFocus(focused, false)).toBe(false);
    expect(resolveCanvasFocus(initialCanvasColumnState(), true)).toBe(false);
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
