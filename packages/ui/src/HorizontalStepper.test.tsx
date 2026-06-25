/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import HorizontalStepper from "./HorizontalStepper";

afterEach(cleanup);
import { buildSteps } from "./workflow-steps";
import { type WorkflowStepName } from "./workflow-step-types";

// framer-motion is not compatible with Happy DOM; replace motion.div with a plain div
mock.module("framer-motion", () => ({
  motion: {
    div: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => React.createElement("div", { className }, children),
  },
}));

const LABELS: Record<WorkflowStepName, string> = {
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
});
