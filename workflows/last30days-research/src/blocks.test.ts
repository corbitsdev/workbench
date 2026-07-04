import { describe, expect, test } from "bun:test";
import {
  buildLast30daysBlocks,
  INTAKE_SIGNAL,
  type Last30daysBlockInput,
} from "./blocks";

function intakeGateInput(
  overrides: Partial<Last30daysBlockInput> = {},
): Last30daysBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      {
        stepId: "intake",
        phase: "awaiting-signal",
        awaitingSignalName: INTAKE_SIGNAL,
      },
    ],
    stepOutputs: {},
    ...overrides,
  };
}

describe("last30days-research intake gate blocks (CL-2765)", () => {
  test("emits a topic+focus form at the intake gate", () => {
    const blocks = buildLast30daysBlocks(intakeGateInput());

    const form = blocks.find((b) => b.kind === "form");
    if (form === undefined || form.kind !== "form") {
      throw new Error("expected a form at the intake gate");
    }
    expect(form.signalName).toBe(INTAKE_SIGNAL);

    const topic = form.fields.find((f) => f.name === "topic");
    if (topic?.kind !== "text") throw new Error("expected a text topic field");
    expect(topic.required).toBe(true);

    const focus = form.fields.find((f) => f.name === "focus");
    if (focus?.kind !== "textarea") {
      throw new Error("expected a textarea focus field");
    }
    // Focus is optional — a required-less field so the run can start on topic alone.
    expect(focus.required ?? false).toBe(false);
  });

  test("renders a progress block over the run's steps", () => {
    const blocks = buildLast30daysBlocks(intakeGateInput());
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
  });

  test("no gate, running: progress only, no form", () => {
    const blocks = buildLast30daysBlocks({
      runId: "run_2",
      phase: "running",
      steps: [{ stepId: "ground", phase: "in-flight" }],
      stepOutputs: {},
    });
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
  });

  test("surfaces the completed link when the run finishes", () => {
    const blocks = buildLast30daysBlocks({
      runId: "run_3",
      phase: "completed",
      steps: [{ stepId: "persist", phase: "completed" }],
      stepOutputs: {},
      completedLink: {
        url: "/artifacts/art_1",
        title: "Open the brief",
        description: "Saved to your workbench",
      },
    });
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");
  });

  test("surfaces an error block on a failed run", () => {
    const blocks = buildLast30daysBlocks({
      runId: "run_4",
      phase: "failed",
      steps: [{ stepId: "ground", phase: "failed" }],
      stepOutputs: {},
      errorMessage: "grounding turn failed",
    });
    const error = blocks.find((b) => b.kind === "error");
    expect(error?.kind === "error" && error.message).toBe(
      "grounding turn failed",
    );
  });
});
