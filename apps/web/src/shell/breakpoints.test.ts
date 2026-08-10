// Tests the layout-mode predicates the shell renders from. Each function is
// pure — no DOM, no matchMedia — so the full decision tree is covered by a
// table over the three modes.

import { describe, expect, test } from "bun:test";

import {
  canvasColumnAllowed,
  contextualPanelIsDrawer,
  contextualPanelVisible,
  railShowLabels,
  shellLayoutModeForWidth,
  type ShellLayoutMode,
} from "./breakpoints";

const MODES: readonly ShellLayoutMode[] = ["expanded", "compact", "narrow"];

describe("breakpoints", () => {
  test("canvas column is allowed only in expanded mode", () => {
    expect(canvasColumnAllowed("expanded")).toBe(true);
    expect(canvasColumnAllowed("compact")).toBe(false);
    expect(canvasColumnAllowed("narrow")).toBe(false);
  });

  test("contextual panel is an inline column in expanded and compact", () => {
    expect(contextualPanelVisible("expanded")).toBe(true);
    expect(contextualPanelVisible("compact")).toBe(true);
    expect(contextualPanelVisible("narrow")).toBe(false);
  });

  test("contextual panel becomes a drawer overlay only in narrow mode", () => {
    expect(contextualPanelIsDrawer("expanded")).toBe(false);
    expect(contextualPanelIsDrawer("compact")).toBe(false);
    expect(contextualPanelIsDrawer("narrow")).toBe(true);
  });

  test("rail drops labels only in narrow mode", () => {
    expect(railShowLabels("expanded")).toBe(true);
    expect(railShowLabels("compact")).toBe(true);
    expect(railShowLabels("narrow")).toBe(false);
  });

  test("every mode either shows the column inline or as a drawer — never both, never neither", () => {
    for (const mode of MODES) {
      const inline = contextualPanelVisible(mode);
      const drawer = contextualPanelIsDrawer(mode);
      expect(inline === !drawer).toBe(true);
    }
  });

  test("width boundaries map to the expected modes", () => {
    // 1280px laptop — expanded (canvas available, inline panel, labels on).
    expect(shellLayoutModeForWidth(1280)).toBe("expanded");
    // 1024px laptop — compact (no canvas, inline panel, labels on).
    expect(shellLayoutModeForWidth(1024)).toBe("compact");
    // 600px phone — narrow (no canvas, panel as drawer, labels off).
    // The narrow boundary is strictly < 700, so 699 and below is narrow.
    expect(shellLayoutModeForWidth(600)).toBe("narrow");
  });
});
