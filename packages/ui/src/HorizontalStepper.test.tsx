/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import HorizontalStepper from "./HorizontalStepper";

afterEach(() => {
  cleanup();
  mockReducedMotion.current = false;
});
import { type WorkflowStep } from "./workflow-step-types";

type StepName = "intake" | "analyze" | "generate" | "approve";
const STEP_ORDER: StepName[] = ["intake", "analyze", "generate", "approve"];

function buildSteps(
  currentStep: StepName,
  labels: Record<StepName, string>,
  isDone?: boolean,
): WorkflowStep[] {
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  return STEP_ORDER.map((name, index) => {
    let status: WorkflowStep["status"];
    if (isDone || index < currentIndex) {
      status = "completed";
    } else if (index === currentIndex) {
      status = "current";
    } else {
      status = "pending";
    }
    return { number: index + 1, label: labels[name] ?? name, status };
  });
}

// framer-motion is not compatible with Happy DOM; replace motion.div/span with
// plain elements. `mockReducedMotion` is mutated per-test so we can assert
// both the animated and the reduced-motion static fallback from one mock.
const mockReducedMotion = { current: false };
const MOTION_ONLY = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
]);
function motionMock(tag: string) {
  return ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (!MOTION_ONLY.has(key)) domProps[key] = value;
    }
    return React.createElement(tag, domProps, children);
  };
}
mock.module("framer-motion", () => ({
  motion: { div: motionMock("div"), span: motionMock("span") },
  useReducedMotion: () => mockReducedMotion.current,
}));

const LABELS: Record<StepName, string> = {
  intake: "Call source",
  analyze: "Agent review",
  generate: "Generate collateral",
  approve: "Approve",
};

describe("HorizontalStepper", () => {
  it("renders a label for every step", () => {
    render(<HorizontalStepper steps={buildSteps("intake", LABELS)} />);
    for (const label of Object.values(LABELS)) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("shows a checkmark for completed steps and the number for the current step", () => {
    // At the "generate" step, intake + analyze are completed (checkmarks),
    // and generate is current (renders its number).
    render(<HorizontalStepper steps={buildSteps("generate", LABELS)} />);
    expect(screen.getAllByText("✓").length).toBe(2);
    expect(screen.getByText("3")).toBeDefined();
  });

  it("renders all checkmarks when the workflow is done", () => {
    render(<HorizontalStepper steps={buildSteps("approve", LABELS, true)} />);
    expect(screen.getAllByText("✓").length).toBe(4);
  });

  it("only fills the connecting rail behind a phase that has actually completed", () => {
    // At "generate": intake + analyze are completed, generate is current —
    // only the first two rail segments should read as filled.
    const { container } = render(
      <HorizontalStepper steps={buildSteps("generate", LABELS)} />,
    );
    const segments = container.querySelectorAll(".bg-border-strong > div");
    expect(segments.length).toBe(3);
    expect(segments[0]?.getAttribute("data-filled")).toBe("true");
    expect(segments[1]?.getAttribute("data-filled")).toBe("true");
    // The segment right after the current step must not be pre-filled — the
    // highlight never runs ahead of real progress.
    expect(segments[2]?.getAttribute("data-filled")).toBe("false");
  });

  it('marks the current step with aria-current="step"', () => {
    const { container } = render(
      <HorizontalStepper steps={buildSteps("generate", LABELS)} />,
    );
    const current = container.querySelector('[aria-current="step"]');
    expect(current).not.toBeNull();
    expect(current?.textContent).toContain("Generate collateral");
  });

  it("renders the static fallback with no pulsing ring when reduced motion is preferred", () => {
    mockReducedMotion.current = true;
    const { container } = render(
      <HorizontalStepper steps={buildSteps("generate", LABELS)} />,
    );
    // The current step still renders, but without the infinite-repeat
    // pulsing-ring element (PulsingRing returns null under reduced motion).
    expect(screen.getByText("3")).toBeDefined();
    expect(container.querySelector(".bg-blue\\/30")).toBeNull();
  });

  // CL-4569: at high step counts the rail must compress rather than overflow.
  // Real long labels straight from workflows/*/src/display-steps.ts so this
  // reproduces the actual clipped-4th-step bug, not a synthetic shape.
  const TEN_STEPS: WorkflowStep[] = [
    { number: 1, label: "Fetch the transcript", status: "completed" },
    { number: 2, label: "Save the raw transcript", status: "completed" },
    { number: 3, label: "Extract working notes", status: "completed" },
    { number: 4, label: "Task setup", status: "completed" },
    { number: 5, label: "Analyze", status: "completed" },
    { number: 6, label: "Act", status: "completed" },
    { number: 7, label: "Review", status: "current" },
    { number: 8, label: "Write back", status: "pending" },
    { number: 9, label: "Verify and write call notes", status: "pending" },
    { number: 10, label: "Done", status: "pending" },
  ];

  describe("overflow behavior at high step counts (CL-4569)", () => {
    it("keeps every step's label in the DOM even when compressed to numbers-only", () => {
      render(<HorizontalStepper steps={TEN_STEPS} />);
      for (const step of TEN_STEPS) {
        expect(screen.getByText(step.label)).toBeDefined();
      }
    });

    it("compresses non-current labels to sr-only past the visible-label threshold, keeping only the current step's label on screen", () => {
      render(<HorizontalStepper steps={TEN_STEPS} />);
      const current = screen.getByText("Review");
      const completed = screen.getByText("Fetch the transcript");
      const pending = screen.getByText("Write back");
      expect(current.className).not.toContain("sr-only");
      expect(completed.className).toContain("sr-only");
      expect(pending.className).toContain("sr-only");
    });

    it("does not compress labels below the threshold — every label stays visible", () => {
      render(<HorizontalStepper steps={buildSteps("generate", LABELS)} />);
      for (const label of Object.values(LABELS)) {
        expect(screen.getByText(label).className).not.toContain("sr-only");
      }
    });

    it("scrolls the current step into view without user interaction", () => {
      const scrollIntoView = mock(() => {});
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        render(<HorizontalStepper steps={TEN_STEPS} />);
        expect(scrollIntoView).toHaveBeenCalled();
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it("marks the scroll rail with an edge-fade mask, never a bare unaffordanced scroll", () => {
      const { container } = render(<HorizontalStepper steps={TEN_STEPS} />);
      const rail = container.querySelector(".overflow-x-auto");
      expect(rail).not.toBeNull();
      expect(rail?.className).toContain("mask-image");
    });
  });
});
