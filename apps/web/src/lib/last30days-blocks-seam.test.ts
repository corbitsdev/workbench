import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { blocksFromStepUI } from "@workbench/blocks";
import { STEP_UI } from "@workbench/workflow-last30days-research/browser";
import { Last30daysIntakePayloadSchema } from "@workbench/shared";
import {
  logRunStateSchema,
  runStateFromLog,
  type LogRunState,
} from "./run-state-adapter";

// Drives a real log-derived run state through the production
// `runStateFromLog` decoder — exactly what WorkflowDock does — and only THEN
// into `blocksFromStepUI` fed the workflow's declared `STEP_UI`, so the test
// starts from wire-shaped data, not a pre-trusted object (mirrors the
// gamma/ab-compare seam tests). Asserts the emitted intake FORM payload
// validates at the /resume boundary schema the hub enforces (CL-2765).

function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

function toSteps(log: LogRunState) {
  return log.steps.map((step) => ({
    stepId: step.stepId,
    phase: step.phase,
    ...(step.awaitingSignalName !== undefined
      ? { awaitingSignalName: step.awaitingSignalName }
      : {}),
  }));
}

describe("last30days-research blocks — real log→state→blocks seam (CL-2765)", () => {
  const rawIntakeLog = {
    runId: "run_l30",
    phase: "running" as const,
    lastSeq: 1,
    steps: [
      {
        stepId: "intake",
        phase: "awaiting-signal" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        awaitingSignalName: "intake",
      },
    ],
  };

  it("emits a topic+focus form whose verbatim payload validates at the resume boundary", () => {
    const log = parseLog(rawIntakeLog);

    const blocks = blocksFromStepUI(STEP_UI, {
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
    });

    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe("intake");

    const topicField = form.fields.find((f) => f.name === "topic");
    const focusField = form.fields.find((f) => f.name === "focus");
    if (topicField === undefined || focusField === undefined) {
      throw new Error("expected topic + focus fields");
    }

    // The payload the FormBlock emits from THESE field names, verbatim — a wrong
    // field name would produce a payload the /resume boundary rejects.
    const payload: Record<string, unknown> = {
      [topicField.name]: "AI coding agents",
      [focusField.name]: "enterprise procurement risks",
    };
    expect(Last30daysIntakePayloadSchema(payload) instanceof type.errors).toBe(
      false,
    );

    // Topic alone (focus left blank / omitted) is still a valid submit.
    expect(
      Last30daysIntakePayloadSchema({ topic: "AI coding agents" }) instanceof
        type.errors,
    ).toBe(false);

    // A topic-less submit is rejected at the boundary, not written into the run.
    expect(
      Last30daysIntakePayloadSchema({ topic: "", focus: "angle" }) instanceof
        type.errors,
    ).toBe(true);
  });
});
