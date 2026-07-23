import { describe, expect, it } from "bun:test";
import {
  deriveEntryStepRequiredTriggerFields,
  deriveWorkflowGateInfo,
  isKindStructurallyAttachable,
  kindAllowsScheduledPostIntakeDrive,
  SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST,
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
      isKindStructurallyAttachable(
        {
          requiresIntake: false,
          humanGateCount: 0,
        },
        "heartbeat",
      ),
    ).toBe(true);
  });

  it("attaches an intake-only workflow", () => {
    expect(
      isKindStructurallyAttachable(
        { requiresIntake: true, humanGateCount: 1 },
        "last30days-research",
      ),
    ).toBe(true);
  });

  it("does not attach multi-gate intake workflows without explicit allowance (CL-3528)", () => {
    expect(
      isKindStructurallyAttachable(
        { requiresIntake: true, humanGateCount: 2 },
        "gamma",
      ),
    ).toBe(false);
  });

  it("attaches multi-gate workflows on the hub allowlist", () => {
    const kind = [...SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST][0]!;
    expect(
      isKindStructurallyAttachable(
        { requiresIntake: true, humanGateCount: 2 },
        kind,
      ),
    ).toBe(true);
  });

  it("attaches multi-gate workflows when the catalog sets allowsScheduledPostIntakeDrive", () => {
    expect(
      isKindStructurallyAttachable(
        {
          requiresIntake: true,
          humanGateCount: 2,
          allowsScheduledPostIntakeDrive: true,
        },
        "custom-multi",
      ),
    ).toBe(true);
  });

  it("does not attach a workflow whose gate is not an intake gate", () => {
    expect(
      isKindStructurallyAttachable(
        {
          requiresIntake: false,
          humanGateCount: 1,
        },
        "config-first",
      ),
    ).toBe(false);
  });
});

describe("deriveEntryStepRequiredTriggerFields", () => {
  function stepDef(steps: Record<string, unknown>): unknown {
    return { id: "wf", steps, stepOrder: Object.keys(steps) };
  }

  it("extracts the trigger-payload keys named in the entry step's arg map (granola-call's noteId)", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        fetch: {
          kind: "step",
          input: { from: "trigger.payload" },
          agent: {
            tags: { "workbench.argMap": '{"noteId":{"from":"noteId"}}' },
          },
        },
      }),
    );
    expect(fields).toEqual(["noteId"]);
  });

  it("returns no required fields for an entry step with no arg map (prospect-engine's initBudget)", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        initBudget: {
          kind: "step",
          input: { from: "trigger.payload" },
          agent: { tags: { "workbench.argMap": "{}" } },
        },
      }),
    );
    expect(fields).toEqual([]);
  });

  it("returns no required fields when the entry is an intake gate, not a direct trigger read", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        intake: { kind: "awaitSignal", name: "intake" },
        work: { kind: "step" },
      }),
    );
    expect(fields).toEqual([]);
  });

  it("returns no required fields for a malformed definition rather than throwing", () => {
    expect(deriveEntryStepRequiredTriggerFields(null)).toEqual([]);
    expect(deriveEntryStepRequiredTriggerFields({})).toEqual([]);
  });
});

describe("kindAllowsScheduledPostIntakeDrive", () => {
  it("requires intake, more than one gate, and allowlist or catalog flag", () => {
    expect(
      kindAllowsScheduledPostIntakeDrive("gamma", {
        requiresIntake: true,
        humanGateCount: 2,
      }),
    ).toBe(false);
    expect(
      kindAllowsScheduledPostIntakeDrive("gamma", {
        requiresIntake: true,
        humanGateCount: 2,
        allowsScheduledPostIntakeDrive: true,
      }),
    ).toBe(true);
    const allowlisted = [...SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST][0]!;
    expect(
      kindAllowsScheduledPostIntakeDrive(allowlisted, {
        requiresIntake: true,
        humanGateCount: 2,
      }),
    ).toBe(true);
  });
});
