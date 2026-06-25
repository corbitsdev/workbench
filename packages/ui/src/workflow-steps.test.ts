/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { buildSteps } from "./workflow-steps";
import { type WorkflowStepName } from "./workflow-step-types";

describe("buildSteps", () => {
  const allLabels: Record<WorkflowStepName, string> = {
    intake: "Call source",
    analyze: "Agent review",
    generate: "Generate collateral",
    approve: "Approve",
  };

  it("marks intake as current for intake step", () => {
    const steps = buildSteps("intake", allLabels);
    expect(steps[0]?.status).toBe("current");
    expect(steps[1]?.status).toBe("pending");
  });

  it("marks completed steps before analyze and current at analyze", () => {
    const steps = buildSteps("analyze", allLabels);
    expect(steps[0]?.status).toBe("completed");
    expect(steps[1]?.status).toBe("current");
    expect(steps[2]?.status).toBe("pending");
  });

  it("marks completed steps before generate and current at generate", () => {
    const steps = buildSteps("generate", allLabels);
    expect(steps[0]?.status).toBe("completed");
    expect(steps[1]?.status).toBe("completed");
    expect(steps[2]?.status).toBe("current");
    expect(steps[3]?.status).toBe("pending");
  });

  it("includes a fourth approve step that is current while reviewing", () => {
    const steps = buildSteps("approve", allLabels);
    expect(steps).toHaveLength(4);
    expect(steps[2]?.status).toBe("completed");
    expect(steps[3]?.label).toBe("Approve");
    expect(steps[3]?.status).toBe("current");
  });

  it("marks all completed when workflow is done", () => {
    const steps = buildSteps("approve", allLabels, true);
    expect(steps.every((s) => s.status === "completed")).toBe(true);
  });
});
