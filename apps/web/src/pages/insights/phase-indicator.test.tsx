/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { LogStepState } from "../../lib/run-state-adapter";
import { PhaseIndicator } from "./phase-indicator";

const TERMINAL_CASES: [LogStepState["phase"], string][] = [
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
  it("gives every terminal phase a distinct labelled glyph, never color alone", () => {
    for (const [phase, label] of TERMINAL_CASES) {
      const { unmount } = render(<PhaseIndicator phase={phase} />);
      const el = screen.getByLabelText(label);
      // A glyph (icon svg or the cancelled "×") must accompany the color so
      // the phase is distinguishable without relying on hue.
      expect(el.querySelector("svg") ?? el.textContent).toBeTruthy();
      unmount();
    }
  });

  it("pulses only the in-flight phase, reusing the shared PulsingRing primitive", () => {
    const { unmount } = render(<PhaseIndicator phase="in-flight" />);
    const el = screen.getByLabelText("In flight");
    // CL-4394's PulsingRing renders an absolutely inset motion.span layered
    // behind the phase glyph; its presence (not a spinner svg) is the
    // falsifiable signal that the live-phase treatment was reused, not
    // re-inlined as a separate spinner.
    expect(el.querySelector(".absolute")).not.toBeNull();
    expect(el.querySelector("svg")).toBeNull();
    unmount();
  });

  it("keeps terminal phases free of the pulsing ring", () => {
    for (const [phase, label] of TERMINAL_CASES) {
      const { unmount } = render(<PhaseIndicator phase={phase} />);
      const el = screen.getByLabelText(label);
      // Only in-flight carries the ring's absolutely positioned span; terminal
      // glyphs never do.
      expect(el.querySelector(".absolute")).toBeNull();
      unmount();
    }
  });
});
