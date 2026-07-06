import { describe, expect, test } from "bun:test";

import {
  buildGammaBlocks,
  INTAKE_SIGNAL,
  type GammaBlockInput,
} from "./blocks";

// A run parked on the intake gate — the point where the deck's template + source
// (all opaque ids the dock cannot resolve) are chosen.
function intakeGateInput(): GammaBlockInput {
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
  };
}

describe("gamma intake gate (CL-2684)", () => {
  test("emits a run-page link, never a form demanding opaque template/artifact/note ids", () => {
    const blocks = buildGammaBlocks(intakeGateInput());

    // The dock is a visibility surface here: no intake FORM (which demanded ids
    // the user can't obtain in the dock).
    expect(blocks.some((b) => b.kind === "form")).toBe(false);

    const link = blocks.find((b) => b.kind === "link");
    if (link === undefined || link.kind !== "link") {
      throw new Error("expected a run-page link at the intake gate");
    }
    expect(link.url).toBe("/workflows/run_1");
  });
});
