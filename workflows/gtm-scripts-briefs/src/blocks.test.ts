import { describe, expect, test } from "bun:test";
import {
  buildGtmScriptsBriefsBlocks,
  INTAKE_SIGNAL,
  type GtmScriptsBriefsBlockInput,
} from "./blocks";

function intakeGateInput(
  overrides: Partial<GtmScriptsBriefsBlockInput> = {},
): GtmScriptsBriefsBlockInput {
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

describe("gtm-scripts-briefs dock blocks", () => {
  test("emits a complete intake form at the intake gate", () => {
    const form = buildGtmScriptsBriefsBlocks(intakeGateInput()).find(
      (block) => block.kind === "form",
    );
    if (form === undefined || form.kind !== "form") {
      throw new Error("expected an intake form");
    }

    expect(form.signalName).toBe(INTAKE_SIGNAL);
    expect(form.fields.map((field) => field.name)).toEqual([
      "topic",
      "days",
      "audience",
      "objective",
    ]);
    const days = form.fields.find((field) => field.name === "days");
    if (days?.kind !== "number") {
      throw new Error("expected a numeric research window");
    }
    expect(days.defaultValue).toBe(30);

    for (const name of ["topic", "days"]) {
      const field = form.fields.find((candidate) => candidate.name === name);
      expect(field?.kind !== "group" && field?.required).toBe(true);
    }
    for (const name of ["audience", "objective"]) {
      const field = form.fields.find((candidate) => candidate.name === name);
      expect(field?.kind !== "group" && field?.required).not.toBe(true);
    }
  });

  test("renders progress and terminal state blocks", () => {
    const completed = buildGtmScriptsBriefsBlocks({
      runId: "run_2",
      phase: "completed",
      steps: [{ stepId: "persist", phase: "completed" }],
      stepOutputs: {},
      completedLink: { url: "/artifacts/art_1", title: "Open deliverable" },
    });
    expect(completed.some((block) => block.kind === "progress")).toBe(true);
    const link = completed.find((block) => block.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");

    const failed = buildGtmScriptsBriefsBlocks({
      runId: "run_3",
      phase: "failed",
      steps: [{ stepId: "write", phase: "failed" }],
      stepOutputs: {},
      errorMessage: "writer unavailable",
    });
    const error = failed.find((block) => block.kind === "error");
    expect(error?.kind === "error" && error.message).toBe("writer unavailable");
  });

  test("links to the run page rather than guessing an unsupported gate", () => {
    const blocks = buildGtmScriptsBriefsBlocks({
      runId: "run_4",
      phase: "running",
      steps: [
        {
          stepId: "review",
          phase: "awaiting-signal",
          awaitingSignalName: "review",
        },
      ],
      stepOutputs: {},
    });
    const link = blocks.find((block) => block.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/workflows/run_4");
  });
});
