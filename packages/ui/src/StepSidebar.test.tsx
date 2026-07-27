/// <reference types="bun" />
import "./test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// framer-motion is not compatible with Happy DOM; replace motion.* with plain
// elements and pass AnimatePresence children straight through.
mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          const {
            initial: _i,
            animate: _a,
            exit: _e,
            transition: _t,
            whileTap: _wt,
            ...rest
          } = props as Record<string, unknown>;
          return React.createElement(tag, rest, children);
        },
    },
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

import StepSidebar from "./StepSidebar";
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

const LABELS: Record<StepName, string> = {
  intake: "Call source",
  analyze: "Agent review",
  generate: "Generate collateral",
  approve: "Approve",
};

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

describe("StepSidebar", () => {
  beforeEach(() => setViewport(1280));
  afterEach(cleanup);

  it("renders the studio title and every step label when expanded", () => {
    render(<StepSidebar steps={buildSteps("generate", LABELS)} />);
    expect(screen.getByText("Call Collateral Studio")).toBeDefined();
    for (const label of Object.values(LABELS)) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("shows a checkmark for completed steps and the number for later steps", () => {
    render(<StepSidebar steps={buildSteps("generate", LABELS)} />);
    // intake + analyze completed -> two checkmarks.
    expect(screen.getAllByText("✓").length).toBe(2);
    // approve is pending -> its number (4) renders.
    expect(screen.getByText("4")).toBeDefined();
  });

  it("toggles collapse, hiding the title and labels and updating the control label", () => {
    render(<StepSidebar steps={buildSteps("intake", LABELS)} />);
    expect(screen.getByText("Call Collateral Studio")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.queryByText("Call Collateral Studio")).toBeNull();
    expect(screen.queryByText("Call source")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toBeDefined();
  });

  it("starts collapsed on narrow viewports", () => {
    setViewport(500);
    render(<StepSidebar steps={buildSteps("intake", LABELS)} />);
    expect(screen.queryByText("Call Collateral Studio")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toBeDefined();
  });

  it("renders the stage source and pluralizes the selection count", () => {
    render(
      <StepSidebar
        steps={buildSteps("analyze", LABELS)}
        sourceLabel="Acme call"
        selectionCount={3}
      />,
    );
    expect(screen.getByText("Stage source")).toBeDefined();
    expect(screen.getByText("Acme call")).toBeDefined();
    expect(screen.getByText("3 pain points selected")).toBeDefined();
  });

  it("uses the singular form for a single selection", () => {
    render(
      <StepSidebar
        steps={buildSteps("analyze", LABELS)}
        sourceLabel="Acme call"
        selectionCount={1}
      />,
    );
    expect(screen.getByText("1 pain point selected")).toBeDefined();
  });

  it("omits the selection count line when undefined", () => {
    render(
      <StepSidebar
        steps={buildSteps("analyze", LABELS)}
        sourceLabel="Acme call"
      />,
    );
    expect(screen.getByText("Acme call")).toBeDefined();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("omits the stage source block when no sourceLabel is given", () => {
    render(<StepSidebar steps={buildSteps("intake", LABELS)} />);
    expect(screen.queryByText("Stage source")).toBeNull();
  });

  it("renders no sign-out control when onSignOut is omitted", () => {
    render(<StepSidebar steps={buildSteps("intake", LABELS)} />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("emits the sign-out intent when the control is activated", () => {
    const onSignOut = mock(() => {});
    render(
      <StepSidebar
        steps={buildSteps("intake", LABELS)}
        onSignOut={onSignOut}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
