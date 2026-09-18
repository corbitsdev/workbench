import { describe, expect, test } from "bun:test";

import {
  canvasColumnAllowed,
  shellLayoutModeForWidth,
  shellLayoutModeFromMatches,
} from "./breakpoints";
import {
  initialCanvasColumnState,
  openProfileInCanvas,
  resolveCanvasVisibility,
} from "./canvas-column-state";

type TestProfile = { readonly id: string };
type TestArtifact = { readonly id: string };
type TestRoutine = { readonly id: string };

const sampleProfile: TestProfile = { id: "profile-1" };

function initial() {
  return initialCanvasColumnState<TestProfile, TestArtifact, TestRoutine>();
}

describe("shellLayoutModeForWidth", () => {
  test("wide desktop widths are expanded", () => {
    expect(shellLayoutModeForWidth(1920)).toBe("expanded");
    expect(shellLayoutModeForWidth(1100)).toBe("expanded");
  });

  test("tablet widths are compact", () => {
    expect(shellLayoutModeForWidth(1099)).toBe("compact");
    expect(shellLayoutModeForWidth(700)).toBe("compact");
  });

  test("phone widths are narrow", () => {
    expect(shellLayoutModeForWidth(699)).toBe("narrow");
    expect(shellLayoutModeForWidth(320)).toBe("narrow");
  });
});

describe("shellLayoutModeFromMatches", () => {
  test("gives every combination of the two queries one mode, narrow first", () => {
    expect(shellLayoutModeFromMatches(true, true)).toBe("narrow");
    expect(shellLayoutModeFromMatches(false, true)).toBe("compact");
    expect(shellLayoutModeFromMatches(false, false)).toBe("expanded");
    // Not reachable through the real queries — nothing is narrower than 700px
    // without also being narrower than 1100px — but the function takes two
    // independent booleans, so the narrower answer has to win regardless.
    expect(shellLayoutModeFromMatches(true, false)).toBe("narrow");
  });
});

describe("canvasColumnAllowed", () => {
  test("only expanded has room for a fourth column", () => {
    expect(canvasColumnAllowed("expanded")).toBe(true);
    expect(canvasColumnAllowed("compact")).toBe(false);
    expect(canvasColumnAllowed("narrow")).toBe(false);
  });
});

describe("canvas column state", () => {
  test("starts closed", () => {
    expect(initial().open).toBe(false);
  });

  test("visibility requires both demand-driven open and the viewport", () => {
    const open = openProfileInCanvas(initial(), sampleProfile);
    const closed = initial();
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(closed, true)).toBe(false);
    expect(resolveCanvasVisibility(closed, false)).toBe(false);
  });
});
