// Tests the layout-mode predicates the shell renders from. Each function is
// pure — no DOM, no matchMedia — so the decision tree is covered directly.

import { describe, expect, test } from "bun:test";

import { canvasColumnAllowed, shellLayoutModeForWidth } from "./breakpoints";

describe("breakpoints", () => {
  test("canvas column is allowed only in expanded mode", () => {
    expect(canvasColumnAllowed("expanded")).toBe(true);
    expect(canvasColumnAllowed("compact")).toBe(false);
    expect(canvasColumnAllowed("narrow")).toBe(false);
  });

  test("width boundaries map to the expected modes", () => {
    // 1280px laptop — expanded (canvas available).
    expect(shellLayoutModeForWidth(1280)).toBe("expanded");
    // 1024px laptop — compact (no canvas).
    expect(shellLayoutModeForWidth(1024)).toBe("compact");
    // 600px phone — narrow. The boundary is strictly < 700.
    expect(shellLayoutModeForWidth(600)).toBe("narrow");
  });
});
