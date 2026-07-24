/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { DisplayFlowStep } from "../types";
import { GateBlock } from "./GateBlock";
import { stepListFromDisplayFlow, StepList } from "./StepList";
import type { StepListItem } from "./types";

afterEach(() => {
  cleanup();
});

describe("StepList", () => {
  test("renders step names and active state", () => {
    const steps: StepListItem[] = [
      { id: "a", name: "Discover", status: "done", meta: "ok" },
      { id: "b", name: "Review", status: "active", meta: "Waiting" },
      { id: "c", name: "Export", status: "pending" },
    ];
    render(<StepList steps={steps} />);
    expect(screen.getByText("Steps")).toBeTruthy();
    expect(screen.getByText("Discover")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
  });
});

describe("stepListFromDisplayFlow", () => {
  test("maps display-flow steps with optional status overlay", () => {
    const flow: DisplayFlowStep[] = [
      {
        stepId: "discover",
        label: "Discover recent calls",
        character: "deterministic",
        after: [],
      },
      {
        stepId: "spawn",
        label: "Start per-call processing",
        character: "deterministic",
        after: ["discover"],
      },
    ];
    const items = stepListFromDisplayFlow(flow, { discover: "done" });
    expect(items).toEqual([
      {
        id: "discover",
        name: "Discover recent calls",
        status: "done",
        character: "deterministic",
      },
      {
        id: "spawn",
        name: "Start per-call processing",
        status: "pending",
        character: "deterministic",
      },
    ]);
  });
});

describe("GateBlock", () => {
  test("renders kicker, title, prompt, and children", () => {
    render(
      <GateBlock
        gate={{
          kind: "choice",
          title: "Depth",
          prompt: "How deep should research go?",
        }}
        footer={<button type="button">Continue</button>}
      >
        <button type="button">Quick</button>
      </GateBlock>,
    );
    expect(screen.getByText("Needs you · choice")).toBeTruthy();
    expect(screen.getByText("Depth")).toBeTruthy();
    expect(screen.getByText("How deep should research go?")).toBeTruthy();
    expect(screen.getByText("Quick")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });
});
