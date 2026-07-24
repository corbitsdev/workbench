import { describe, expect, test } from "bun:test";
import { blocksFromStepUIHints, type StepUIHints } from "./step-ui-hints";
import type { DockRunInput } from "./run-dock-blocks";

const INTAKE_HINTS: StepUIHints = {
  intake: {
    kind: "form",
    prompt: "What should we research?",
    submitLabel: "Start research",
    fields: [
      { kind: "text", name: "topic", label: "Topic", required: true },
      { kind: "textarea", name: "focus", label: "Focus (optional)" },
    ],
  },
};

function runAt(overrides: Partial<DockRunInput> = {}): DockRunInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [],
    ...overrides,
  };
}

describe("blocksFromStepUIHints", () => {
  test("stamps the declared form hint with the gate's live signalName", () => {
    const blocks = blocksFromStepUIHints(
      INTAKE_HINTS,
      runAt({
        steps: [
          {
            stepId: "intake",
            phase: "awaiting-signal",
            awaitingSignalName: "intake",
          },
        ],
      }),
    );
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe("intake");
    expect(form.fields.map((f) => f.name)).toEqual(["topic", "focus"]);
    expect(form.prompt).toBe("What should we research?");
  });

  test("falls back to the generic single-button choice when no hint is declared for the gate", () => {
    const blocks = blocksFromStepUIHints(
      {},
      runAt({
        steps: [
          {
            stepId: "approve",
            phase: "awaiting-signal",
            awaitingSignalName: "approve",
          },
        ],
      }),
    );
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");
    expect(choice.signalName).toBe("approve");
    expect(choice.options).toEqual([
      { id: "continue", label: "Continue", value: "" },
    ]);
  });

  test("renders a progress block over the run's steps, no gate block when nothing is pending", () => {
    const blocks = blocksFromStepUIHints(
      INTAKE_HINTS,
      runAt({ steps: [{ stepId: "ground", phase: "in-flight" }] }),
    );
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
  });

  test("surfaces the completed link on a completed run", () => {
    const blocks = blocksFromStepUIHints(
      INTAKE_HINTS,
      runAt({
        phase: "completed",
        steps: [{ stepId: "persist", phase: "completed" }],
        completedLink: { url: "/artifacts/art_1", title: "Open the brief" },
      }),
    );
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");
  });

  test("surfaces an error block on a failed run", () => {
    const blocks = blocksFromStepUIHints(
      INTAKE_HINTS,
      runAt({
        phase: "failed",
        steps: [{ stepId: "ground", phase: "failed" }],
        errorMessage: "grounding turn failed",
      }),
    );
    const error = blocks.find((b) => b.kind === "error");
    expect(error?.kind === "error" && error.message).toBe(
      "grounding turn failed",
    );
  });

  test("does not mutate the declared hint object across calls (no shared signalName leakage)", () => {
    blocksFromStepUIHints(
      INTAKE_HINTS,
      runAt({
        steps: [
          {
            stepId: "intake",
            phase: "awaiting-signal",
            awaitingSignalName: "intake",
          },
        ],
      }),
    );
    expect("signalName" in INTAKE_HINTS.intake!).toBe(false);
  });
});
