/**
 * Equivalence proof: `blocksFromStepUI` (this package) must reproduce
 * `gtm-scripts-briefs`' hand-written `blocks.ts` builder over the same run
 * state, using an equivalent `STEP_UI` map instead of bespoke code. That is
 * the deliverable that makes the workflow's later `blocks.ts` deletion safe.
 *
 * This slice is deliberately host-side only and must not touch
 * `workflows/*` — an in-flight PR touches the same workflow
 * packages. `referenceBuildGtmScriptsBriefsBlocks` below is copied VERBATIM
 * from `workflows/gtm-scripts-briefs/src/blocks.ts` (not imported) so this
 * test proves equivalence without adding a dependency edge from
 * `@workbench/blocks` onto a `workflows/*` package, and without editing that
 * package's own test suite while it is mid-rebase. The "drift guard" describe
 * block below reads the live file and asserts its load-bearing literals
 * (prompts, field definitions, the un-hinted-gate copy) still match this
 * transcription — if that ever fails, the fix is to re-copy the live file
 * here, not to weaken the guard.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { humanizeStepId, type StepUI } from "@workbench/shared";
import { blocksFromStepUI } from "./step-ui";
import type { DockRunInput, FormField, StepUIRunInput, UIBlock } from ".";
import { pendingGateForRun } from "./conversation-gates";
import { progressStateForStepPhase } from "./run-dock-blocks";
import type { ProgressStep } from "./ui-block";

const INTAKE_SIGNAL = "intake";

interface GtmScriptsBriefsBlockInput extends DockRunInput {
  stepOutputs: Record<string, unknown>;
}

const INTAKE_FIELDS: FormField[] = [
  {
    kind: "text",
    name: "topic",
    label: "Topic",
    placeholder: "e.g. Recent AI agent launches for revenue teams",
    required: true,
  },
  {
    kind: "number",
    name: "days",
    label: "Research window (days)",
    placeholder: "30",
    required: true,
    defaultValue: 30,
  },
  {
    kind: "text",
    name: "audience",
    label: "Audience (optional)",
    placeholder: "e.g. VP Sales at mid-market SaaS companies",
  },
  {
    kind: "textarea",
    name: "objective",
    label: "Objective (optional)",
    placeholder: "What should the artifact help the audience understand or do?",
  },
];

function intakeForm(signalName: string): UIBlock {
  return {
    kind: "form",
    prompt:
      "What current GTM story should we research and turn into a deliverable?",
    signalName,
    submitLabel: "Research and create deliverable",
    fields: INTAKE_FIELDS,
  };
}

function referenceBuildGtmScriptsBriefsBlocks(
  input: GtmScriptsBriefsBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === INTAKE_SIGNAL) {
      blocks.push(intakeForm(gate.signalName));
    } else {
      blocks.push({
        kind: "link",
        url: `/workflows/${input.runId}`,
        title: "Continue on the run page",
        description:
          "This run needs input the dock cannot collect yet. Continue on the run page.",
      });
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}

// The STEP_UI map a real migration of gtm-scripts-briefs would export next to
// `workflow = defineWorkflow(...)`, reproducing the reference builder above.
// Only the `intake` step needs an entry — every other step id renders with
// the same default (humanized-label progress row) both paths already produce.
const GTM_SCRIPTS_BRIEFS_STEP_UI: StepUI = {
  intake: {
    role: "intake",
    prompt:
      "What current GTM story should we research and turn into a deliverable?",
    submitLabel: "Research and create deliverable",
    input: [
      {
        kind: "text",
        name: "topic",
        label: "Topic",
        placeholder: "e.g. Recent AI agent launches for revenue teams",
        required: true,
      },
      {
        kind: "number",
        name: "days",
        label: "Research window (days)",
        placeholder: "30",
        required: true,
        defaultValue: 30,
      },
      {
        kind: "text",
        name: "audience",
        label: "Audience (optional)",
        placeholder: "e.g. VP Sales at mid-market SaaS companies",
      },
      {
        kind: "textarea",
        name: "objective",
        label: "Objective (optional)",
        placeholder:
          "What should the artifact help the audience understand or do?",
      },
    ],
  },
};

describe("STEP_UI equivalence: gtm-scripts-briefs", () => {
  test("intake gate: derived form matches the hand-written builder's form", () => {
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "running",
      stepOutputs: {},
      steps: [
        {
          stepId: "intake",
          phase: "awaiting-signal",
          awaitingSignalName: "intake",
        },
      ],
    };
    const expected = referenceBuildGtmScriptsBriefsBlocks(run);
    const actual = blocksFromStepUI(GTM_SCRIPTS_BRIEFS_STEP_UI, run);
    // Full-array equality: both sides now share the one sentence-case
    // `humanizeStepId` (`@workbench/shared`), so there is no longer a casing
    // divergence to work around.
    expect(actual).toEqual(expected);
  });

  test("mid-run, no gate: progress blocks match across every step phase", () => {
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "running",
      stepOutputs: {},
      steps: [
        { stepId: "intake", phase: "completed" },
        { stepId: "search", phase: "completed" },
        { stepId: "ground", phase: "completed" },
        { stepId: "curate", phase: "completed" },
        { stepId: "brief", phase: "in-flight" },
      ],
    };
    const expected = referenceBuildGtmScriptsBriefsBlocks(run);
    const actual = blocksFromStepUI(GTM_SCRIPTS_BRIEFS_STEP_UI, run);
    expect(actual).toEqual(expected);
  });

  test("completed run: link block matches", () => {
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "completed",
      stepOutputs: {},
      completedLink: { url: "/artifacts/1", title: "View deliverable" },
      steps: [
        { stepId: "intake", phase: "completed" },
        { stepId: "persist", phase: "completed" },
      ],
    };
    const expected = referenceBuildGtmScriptsBriefsBlocks(run);
    const actual = blocksFromStepUI(GTM_SCRIPTS_BRIEFS_STEP_UI, run);
    expect(actual).toEqual(expected);
  });

  test("failed run: error block matches", () => {
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "failed",
      stepOutputs: {},
      errorMessage: "the write step failed",
      steps: [
        { stepId: "intake", phase: "completed" },
        { stepId: "write", phase: "failed" },
      ],
    };
    const expected = referenceBuildGtmScriptsBriefsBlocks(run);
    const actual = blocksFromStepUI(GTM_SCRIPTS_BRIEFS_STEP_UI, run);
    expect(actual).toEqual(expected);
  });

  test("un-hinted gate (no STEP_UI entry): derivation's fallback now matches the hand-written link fallback", () => {
    // The generic fallback (`genericGateFallback` in step-ui.ts) is a run-page
    // redirect link, matching the hand-written builder exactly — a
    // single-button choice that resolves the gate with an empty payload is no
    // longer produced (that fallback advanced a run past a gate it couldn't
    // actually satisfy).
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "running",
      stepOutputs: {},
      steps: [
        {
          stepId: "some-other-gate",
          phase: "awaiting-signal",
          awaitingSignalName: "some-other-signal",
        },
      ],
    };
    const expected = referenceBuildGtmScriptsBriefsBlocks(run);
    const actual = blocksFromStepUI({}, run);
    expect(actual).toEqual(expected);
    expect(expected[1]).toEqual({
      kind: "link",
      url: "/workflows/run_1",
      title: "Continue on the run page",
      description:
        "This run needs input the dock cannot collect yet. Continue on the run page.",
    });
  });

  test("un-hinted gate: the fallback never resolves the gate with an empty payload", () => {
    const run: StepUIRunInput & GtmScriptsBriefsBlockInput = {
      runId: "run_1",
      phase: "running",
      stepOutputs: {},
      steps: [
        {
          stepId: "some-other-gate",
          phase: "awaiting-signal",
          awaitingSignalName: "some-other-signal",
        },
      ],
    };
    const actual = blocksFromStepUI({}, run);
    const gateBlock = actual.find((b) =>
      ["form", "choice", "multiSelect", "reviewList"].includes(b.kind),
    );
    expect(gateBlock).toBeUndefined();
  });
});

describe("drift guard: the copied reference builder vs the live file", () => {
  test("workflows/gtm-scripts-briefs/src/blocks.ts still matches the literals transcribed above", () => {
    const live = readFileSync(
      new URL(
        "../../../workflows/gtm-scripts-briefs/src/blocks.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(live).toContain(
      "What current GTM story should we research and turn into a deliverable?",
    );
    expect(live).toContain("Research and create deliverable");
    expect(live).toContain("e.g. Recent AI agent launches for revenue teams");
    expect(live).toContain(
      "What should the artifact help the audience understand or do?",
    );
    expect(live).toContain(
      "This run needs input the dock cannot collect yet. Continue on the run page.",
    );
    // If any of the above ever fails, re-copy the live file's
    // `buildGtmScriptsBriefsBlocks`/`INTAKE_FIELDS` into
    // `referenceBuildGtmScriptsBriefsBlocks`/`INTAKE_FIELDS` above before
    // trusting this equivalence proof again.
  });
});
