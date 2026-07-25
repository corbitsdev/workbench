import { describe, expect, test } from "bun:test";
import type { StepUI } from "@workbench/shared";
import { blocksFromStepUI } from "./step-ui";
import type { DockRunStep, StepUIRunInput } from ".";

function step(
  overrides: Partial<DockRunStep> & { stepId: string },
): DockRunStep {
  return { phase: "completed", ...overrides };
}

describe("blocksFromStepUI - progress", () => {
  test("labels a step from STEP_UI title, falling back to a humanized step id", () => {
    const stepUI: StepUI = { intake: { title: "Sources" } };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({ stepId: "intake", phase: "completed" }),
        step({ stepId: "write-copy", phase: "in-flight" }),
      ],
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[0]).toEqual({
      kind: "progress",
      steps: [
        { state: "done", label: "Sources" },
        { state: "running", label: "Write copy" },
      ],
    });
  });
});

describe("blocksFromStepUI - gate", () => {
  test("renders a form block for a gate whose STEP_UI entry declares input", () => {
    const stepUI: StepUI = {
      intake: {
        role: "intake",
        prompt: "What should we research?",
        submitLabel: "Go",
        input: [{ kind: "text", name: "topic", required: true }],
      },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "intake",
          phase: "awaiting-signal",
          awaitingSignalName: "intake",
        }),
      ],
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "form",
      prompt: "What should we research?",
      signalName: "intake",
      submitLabel: "Go",
      fields: [{ kind: "text", name: "topic", required: true }],
    });
  });

  test("falls back to a run-page redirect (never a gate-resolving action) when the step has no STEP_UI entry", () => {
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "intake",
          phase: "awaiting-signal",
          awaitingSignalName: "intake",
        }),
      ],
    };
    const blocks = blocksFromStepUI({}, run);
    expect(blocks[1]).toEqual({
      kind: "link",
      url: "/workflows/run_1",
      title: "Continue on the run page",
      description:
        "This run needs input the dock cannot collect yet. Continue on the run page.",
    });
  });

  test("never resolves an unrecognized gate with an action that submits an empty payload", () => {
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "intake",
          phase: "awaiting-signal",
          awaitingSignalName: "intake",
        }),
      ],
    };
    const blocks = blocksFromStepUI({}, run);
    const gateResolvingKinds = new Set(["form", "choice", "multiSelect", "reviewList"]);
    for (const block of blocks) {
      expect(gateResolvingKinds.has(block.kind)).toBe(false);
    }
  });

  test("a gateFromOutput entry whose source output isn't a usable block yet falls back to the redirect, not a choice with an empty payload", () => {
    const stepUI: StepUI = {
      select: { gateFromOutput: true, gateSourceStep: "intake" },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({ stepId: "intake", phase: "in-flight" }),
        step({
          stepId: "select",
          phase: "awaiting-signal",
          awaitingSignalName: "note-selection",
        }),
      ],
      stepOutputs: {},
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "link",
      url: "/workflows/run_1",
      title: "Continue on the run page",
      description:
        "This run needs input the dock cannot collect yet. Continue on the run page.",
    });
  });

  test("a gateFromOutput entry renders the workflow-emitted block and stamps the live signalName", () => {
    const stepUI: StepUI = {
      select: { gateFromOutput: true, gateSourceStep: "intake" },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({ stepId: "intake", phase: "completed" }),
        step({
          stepId: "select",
          phase: "awaiting-signal",
          awaitingSignalName: "note-selection",
        }),
      ],
      stepOutputs: {
        intake: {
          kind: "choice",
          prompt: "Pick a note",
          options: [{ id: "n1", label: "Note 1" }],
        },
      },
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "choice",
      prompt: "Pick a note",
      signalName: "note-selection",
      options: [{ id: "n1", label: "Note 1" }],
    });
  });

  test("a static entry.gate declares a fixed choice with no data dependency", () => {
    const stepUI: StepUI = {
      approve: {
        gate: {
          kind: "choice",
          options: [
            { id: "yes", label: "Approve" },
            { id: "no", label: "Reject" },
          ],
        },
      },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "approve",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        }),
      ],
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "choice",
      signalName: "approve",
      options: [
        { id: "yes", label: "Approve" },
        { id: "no", label: "Reject" },
      ],
    });
  });

  test("a static entry.gate redirect kind renders the fixed run-page copy", () => {
    const stepUI: StepUI = {
      fmtSelection: {
        gate: {
          kind: "redirect",
          title: "Choose formats on the run page",
          description: "Pick formats there.",
        },
      },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "fmtSelection",
          phase: "awaiting-signal",
          awaitingSignalName: "format-selection",
        }),
      ],
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "link",
      url: "/workflows/run_1",
      title: "Choose formats on the run page",
      description: "Pick formats there.",
    });
  });

  test("throws for a select/multiSelect input field declared with no options", () => {
    const stepUI: StepUI = {
      intake: { input: [{ kind: "select", name: "channel" }] },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        step({
          stepId: "intake",
          phase: "awaiting-signal",
          awaitingSignalName: "intake",
        }),
      ],
    };
    expect(() => blocksFromStepUI(stepUI, run)).toThrow(/declares no options/u);
  });
});

describe("blocksFromStepUI - output block registry", () => {
  test("stamps a completed step's output onto its declared block kind", () => {
    const stepUI: StepUI = {
      review: { title: "Pain points", output: { block: "reviewList" } },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [step({ stepId: "review", phase: "completed" })],
      stepOutputs: {
        review: {
          displayFields: [{ key: "quote", label: "Quote" }],
          rows: [{ id: "1", fields: { quote: "hi" }, payload: { id: "1" } }],
        },
      },
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks[1]).toEqual({
      kind: "reviewList",
      title: "Pain points",
      displayFields: [{ key: "quote", label: "Quote" }],
      rows: [{ id: "1", fields: { quote: "hi" }, payload: { id: "1" } }],
    });
  });

  test("emits no output block when the step has not completed yet", () => {
    const stepUI: StepUI = {
      review: { output: { block: "reviewList" } },
    };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [step({ stepId: "review", phase: "in-flight" })],
      stepOutputs: { review: { displayFields: [], rows: [] } },
    };
    const blocks = blocksFromStepUI(stepUI, run);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("progress");
  });

  test("throws when the declared output block kind is unknown", () => {
    const stepUI: StepUI = { review: { output: { block: "bogus" } } };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [step({ stepId: "review", phase: "completed" })],
      stepOutputs: { review: {} },
    };
    expect(() => blocksFromStepUI(stepUI, run)).toThrow(
      /unknown output block kind/u,
    );
  });

  test("throws when the step's output does not match the declared block's shape", () => {
    const stepUI: StepUI = { review: { output: { block: "reviewList" } } };
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "running",
      steps: [step({ stepId: "review", phase: "completed" })],
      stepOutputs: { review: { nope: true } },
    };
    expect(() => blocksFromStepUI(stepUI, run)).toThrow(
      /does not match that block's shape/u,
    );
  });
});

describe("blocksFromStepUI - terminal blocks", () => {
  test("renders the error block on a failed run", () => {
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "failed",
      errorMessage: "boom",
      steps: [],
    };
    expect(blocksFromStepUI({}, run)).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });

  test("renders the link block on a completed run", () => {
    const run: StepUIRunInput = {
      runId: "run_1",
      phase: "completed",
      completedLink: { url: "/a", title: "Done" },
      steps: [],
    };
    expect(blocksFromStepUI({}, run)).toEqual([
      { kind: "link", url: "/a", title: "Done" },
    ]);
  });
});
