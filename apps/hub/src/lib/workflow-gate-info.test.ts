import { describe, expect, it } from "bun:test";
import {
  deriveWorkflowGateInfo,
  isKindStructurallyAttachable,
} from "./workflow-gate-info";

function def(steps: Record<string, { kind?: string; name?: string }>): unknown {
  return { id: "wf", steps, stepOrder: Object.keys(steps) };
}

describe("deriveWorkflowGateInfo", () => {
  it("flags a workflow whose only gate is an intake awaitSignal", () => {
    const info = deriveWorkflowGateInfo(
      def({
        intake: { kind: "awaitSignal", name: "intake" },
        work: { kind: "step" },
      }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 1 });
  });

  it("counts every awaitSignal gate and detects a non-intake first gate", () => {
    const info = deriveWorkflowGateInfo(
      def({
        config: { kind: "awaitSignal", name: "config" },
        run: { kind: "step" },
        decision: { kind: "awaitSignal", name: "decision" },
      }),
    );
    expect(info).toEqual({ requiresIntake: false, humanGateCount: 2 });
  });

  it("counts multiple gates including an intake one", () => {
    const info = deriveWorkflowGateInfo(
      def({
        intake: { kind: "awaitSignal", name: "intake" },
        review: { kind: "awaitSignal", name: "review" },
      }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 2 });
  });

  it("reports zero gates for a fully deterministic workflow", () => {
    const info = deriveWorkflowGateInfo(
      def({ emit: { kind: "step" }, save: { kind: "step" } }),
    );
    expect(info).toEqual({ requiresIntake: false, humanGateCount: 0 });
  });

  it("falls back to the step id when an awaitSignal has no name", () => {
    const info = deriveWorkflowGateInfo(
      def({ intake: { kind: "awaitSignal" } }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 1 });
  });

  it("returns zero gates for a malformed definition rather than throwing", () => {
    expect(deriveWorkflowGateInfo(null)).toEqual({
      requiresIntake: false,
      humanGateCount: 0,
    });
    expect(deriveWorkflowGateInfo({ steps: "nope" })).toEqual({
      requiresIntake: false,
      humanGateCount: 0,
    });
  });
});

describe("isKindStructurallyAttachable", () => {
  it("attaches a fully unattended workflow", () => {
    expect(
      isKindStructurallyAttachable({
        requiresIntake: false,
        humanGateCount: 0,
      }),
    ).toBe(true);
  });

  it("attaches an intake-only workflow", () => {
    expect(
      isKindStructurallyAttachable({ requiresIntake: true, humanGateCount: 1 }),
    ).toBe(true);
  });

  it("does not attach a workflow with a human gate beyond intake", () => {
    expect(
      isKindStructurallyAttachable({ requiresIntake: true, humanGateCount: 2 }),
    ).toBe(false);
  });

  it("does not attach a workflow whose gate is not an intake gate", () => {
    expect(
      isKindStructurallyAttachable({
        requiresIntake: false,
        humanGateCount: 1,
      }),
    ).toBe(false);
  });
});
