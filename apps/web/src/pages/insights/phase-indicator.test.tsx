/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { LogStepState } from "../../lib/run-state-adapter";
import { PhaseIndicator } from "./phase-indicator";

const CASES: [LogStepState["phase"], string][] = [
  ["in-flight", "In flight"],
  ["awaiting-signal", "Awaiting approval"],
  ["awaiting-timer", "Waiting"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

afterEach(() => {
  cleanup();
});

describe("PhaseIndicator", () => {
  it("gives every phase a distinct labelled glyph, never color alone", () => {
    for (const [phase, label] of CASES) {
      const { unmount } = render(<PhaseIndicator phase={phase} />);
      const el = screen.getByLabelText(label);
      // A glyph (icon svg or the cancelled "×") must accompany the color so
      // the phase is distinguishable without relying on hue.
      expect(el.querySelector("svg") ?? el.textContent).toBeTruthy();
      unmount();
    }
  });
});
