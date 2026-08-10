import { describe, expect, test } from "bun:test";

import {
  canvasColumnAllowed,
  contextualPanelVisible,
  shellLayoutModeForWidth,
  shellLayoutModeFromMatches,
} from "../src/shell/breakpoints";
import {
  initialCanvasColumnState,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "../src/shell/canvas-column-state";

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

describe("contextualPanelVisible", () => {
  test("shows in expanded and compact, hides in narrow", () => {
    expect(contextualPanelVisible("expanded")).toBe(true);
    expect(contextualPanelVisible("compact")).toBe(true);
    expect(contextualPanelVisible("narrow")).toBe(false);
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
    expect(initialCanvasColumnState().open).toBe(false);
  });

  test("toggle flips open, and flips back", () => {
    const opened = toggleCanvasColumn(initialCanvasColumnState());
    expect(opened.open).toBe(true);
    expect(toggleCanvasColumn(opened).open).toBe(false);
  });

  test("rapid toggling always lands on the correct parity", () => {
    let state = initialCanvasColumnState();
    for (let toggle = 0; toggle < 7; toggle += 1) {
      state = toggleCanvasColumn(state);
    }
    expect(state.open).toBe(true);
  });

  test("visibility requires both the toggle and the viewport to agree", () => {
    const open = {
      open: true,
      channelId: "ch_1" as string | null,
      profile: null,
    };
    const closed = {
      open: false,
      channelId: null as string | null,
      profile: null,
    };
    expect(resolveCanvasVisibility(open, true)).toBe(true);
    expect(resolveCanvasVisibility(open, false)).toBe(false);
    expect(resolveCanvasVisibility(closed, true)).toBe(false);
    expect(resolveCanvasVisibility(closed, false)).toBe(false);
  });
});
