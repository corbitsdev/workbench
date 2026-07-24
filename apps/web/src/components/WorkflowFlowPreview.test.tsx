/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { WorkflowFlowStep } from "@workbench/shared";
import { WorkflowFlowPreview } from "./WorkflowFlowPreview";

const steps: WorkflowFlowStep[] = [
  { id: "s1", title: "Gather Sources", kind: "auto", stepIds: ["s1"] },
  { id: "s2", title: "Synthesize Brief", kind: "agent", stepIds: ["s2"] },
  { id: "s3", title: "Review Draft", kind: "human", stepIds: ["s3"] },
];

afterEach(cleanup);

describe("WorkflowFlowPreview", () => {
  it("renders the steps in order with their classification labels", () => {
    render(<WorkflowFlowPreview steps={steps} animationKey="wf" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    within(items[0]!).getByText("Gather Sources");
    within(items[0]!).getByText("Automated");
    within(items[1]!).getByText("Synthesize Brief");
    within(items[1]!).getByText("AI agent");
    within(items[2]!).getByText("Review Draft");
    within(items[2]!).getByText("Your input");
  });

  it("numbers each step by its run order", () => {
    render(<WorkflowFlowPreview steps={steps} animationKey="wf" />);
    const items = screen.getAllByRole("listitem");
    within(items[0]!).getByText("1");
    within(items[1]!).getByText("2");
    within(items[2]!).getByText("3");
  });

  it("shows a no-preview message when there are no steps", () => {
    render(<WorkflowFlowPreview steps={[]} animationKey="wf" />);
    expect(screen.queryByRole("listitem")).toBeNull();
    screen.getByText(/no preview available/i);
  });
});
