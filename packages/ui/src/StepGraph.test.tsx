/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { StepGraph, type StepGraphStep } from "./StepGraph";

const steps: StepGraphStep[] = [
  { id: "s1", title: "Gather Sources", kind: "auto" },
  { id: "s2", title: "Synthesize Brief", kind: "agent", status: "running" },
  { id: "s3", title: "Review Draft", kind: "human", status: "pending" },
];

afterEach(cleanup);

describe("StepGraph", () => {
  it("renders steps in order with kind labels", () => {
    render(<StepGraph steps={steps} animationKey="wf" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    within(items[0]!).getByText("Gather Sources");
    within(items[0]!).getByText("Automated");
    within(items[1]!).getByText("Synthesize Brief");
    within(items[2]!).getByText("Your input");
  });

  it("draws one connector per sequential edge", () => {
    render(<StepGraph steps={steps} animationKey="wf" />);
    const paths = screen
      .getByTestId("step-graph-edges")
      .querySelectorAll("path.step-graph-edge");
    expect(paths.length).toBe(2);
  });

  it("shows status overlay on the node badge", () => {
    render(<StepGraph steps={steps} animationKey="wf" />);
    const items = screen.getAllByRole("listitem");
    within(items[1]!).getByText("…");
  });

  it("renders empty state without list items", () => {
    render(<StepGraph steps={[]} animationKey="wf" />);
    expect(screen.queryByRole("listitem")).toBeNull();
    screen.getByTestId("step-graph-empty");
  });
});
