/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, expect, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  reconcileRunState,
  runStateFromLog,
  runStateFromRecord,
  type LogRunState,
  type RunRecord,
} from "../lib/run-state-adapter";
import { WorkflowRunBlocks, blockKey } from "./WorkflowRunBlocks";
import type { UIBlock } from "@workbench/blocks";

function makeState(log: LogRunState, status: RunRecord["status"]) {
  const record: RunRecord = { runId: log.runId, kind: "note-picker", status };
  return reconcileRunState(record, runStateFromLog(log));
}

describe("blockKey", () => {
  it("keys a comparison block stably as its variant set grows", () => {
    // The single comparison block updates in place across polls: its key must
    // NOT change when the streaming variant count / statuses change, or the
    // block remounts every poll and re-fires its entrance animation.
    const running: UIBlock = {
      kind: "comparison",
      status: "running",
      blind: true,
      result: {
        ranking: [],
        variants: [{ label: "Variant 1", content: "", status: "streaming" }],
      },
    };
    const final: UIBlock = {
      kind: "comparison",
      status: "final",
      blind: true,
      result: {
        ranking: [],
        variants: [
          { label: "Variant 1", content: "x", status: "responded" },
          { label: "Variant 2", content: "y", status: "responded" },
        ],
      },
    };
    expect(blockKey(running, 0)).toBe(blockKey(final, 0));
  });

  it("keys distinct block kinds distinctly", () => {
    const progress: UIBlock = {
      kind: "progress",
      steps: [{ state: "running" }],
    };
    const error: UIBlock = { kind: "error", message: "boom" };
    expect(blockKey(progress, 0)).not.toBe(blockKey(error, 1));
  });

  it("keys gates by their signal name, not their index", () => {
    const choice: UIBlock = {
      kind: "choice",
      signalName: "ab-decision",
      options: [{ id: "a", label: "A" }],
    };
    expect(blockKey(choice, 5)).toBe(blockKey(choice, 9));
  });
});

describe("WorkflowRunBlocks", () => {
  afterEach(cleanup);

  it("renders a step timeline instead of the raw run output", () => {
    // The run page used to render a completed step's output as a raw
    // `Output: inline:{…}` string; the blocks view shows a progress timeline
    // built from the run's steps instead.
    const log: LogRunState = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "intake",
          phase: "completed",
          stepType: "inline",
          currentAttempt: 1,
        },
        {
          stepId: "select",
          phase: "in-flight",
          stepType: "human",
          currentAttempt: 1,
        },
      ],
    };
    render(
      <WorkflowRunBlocks
        runId="wfr_1"
        kind="note-picker"
        state={makeState(log, "running")}
        logState={log}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={undefined}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    // Both steps render as timeline entries.
    screen.getByText("intake");
    screen.getByText("select");
  });

  it("renders the FULL workflow-definition step sequence immediately, even when only the first two of eight steps have materialized in the log (CL-4285)", () => {
    const log: LogRunState = {
      runId: "wfr_full",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "intake",
          phase: "completed",
          stepType: "inline",
          currentAttempt: 1,
        },
        {
          stepId: "select",
          phase: "in-flight",
          stepType: "human",
          currentAttempt: 1,
        },
      ],
    };
    const catalogSteps = [
      {
        id: "intake",
        title: "Intake",
        kind: "auto" as const,
        stepIds: ["intake"],
      },
      {
        id: "select",
        title: "Select",
        kind: "human" as const,
        stepIds: ["select"],
      },
      {
        id: "fetch",
        title: "Fetch",
        kind: "auto" as const,
        stepIds: ["fetch"],
      },
      {
        id: "context",
        title: "Context",
        kind: "human" as const,
        stepIds: ["context"],
      },
      {
        id: "analyze",
        title: "Analyze",
        kind: "agent" as const,
        stepIds: ["analyze"],
      },
      {
        id: "review",
        title: "Review",
        kind: "human" as const,
        stepIds: ["review"],
      },
      {
        id: "generate",
        title: "Generate",
        kind: "agent" as const,
        stepIds: ["generate"],
      },
      {
        id: "persist",
        title: "Persist",
        kind: "auto" as const,
        stepIds: ["persist"],
      },
    ];

    render(
      <WorkflowRunBlocks
        runId="wfr_full"
        kind="pain-point-collateral"
        state={makeState(log, "running")}
        logState={log}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={catalogSteps}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    // The header reads against the DEFINITION's full step count — never
    // truncated to however many steps have merely started in the log.
    screen.getByText(/step 2 of 8/i);

    // Every step in the definition is visible up front, including the six that
    // have not started yet — never blank, never omitted.
    for (const label of [
      "Intake",
      "Select",
      "Fetch",
      "Context",
      "Analyze",
      "Review",
      "Generate",
      "Persist",
    ]) {
      screen.getByText(label);
    }
  });

  // Models a grouped DISPLAY_STEPS kind with no bespoke Panel (e.g.
  // prospect-engine): each catalog entry's `id` is a SYNTHETIC group key
  // ("prelude", "discover"), never itself a runtime step id — the group's
  // real runtime ids live in `stepIds`. Regression guard for CL-4285: reading
  // a step's phase off `[catalogStep.id]` instead of `catalogStep.stepIds`
  // means `getStepPhase` never matches anything in `RunState.steps`, so the
  // active index freezes at 0 for the entire run.
  const GROUPED_CATALOG_STEPS = [
    {
      id: "prelude",
      title: "Load budget and exclusion lists",
      kind: "auto" as const,
      stepIds: ["initBudget", "readLedger"],
    },
    {
      // Deliberately NOT "discover" — the group's synthetic key must differ
      // from its underlying runtime step id, or a buggy `[catalogStep.id]`
      // mapping would coincidentally still match this one group and hide the
      // regression (the id/stepId collision that let this slip through
      // review once already).
      id: "candidates",
      title: "Discover candidates",
      kind: "agent" as const,
      stepIds: ["discover"],
    },
    {
      id: "deliver",
      title: "Deliver",
      kind: "auto" as const,
      stepIds: ["mail", "notify"],
    },
  ];

  it("advances the active display step as a grouped kind's underlying runtime steps complete (CL-4285)", () => {
    const early: LogRunState = {
      runId: "wfr_group_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "initBudget",
          phase: "in-flight",
          stepType: "deterministic",
          currentAttempt: 1,
        },
      ],
    };
    const { unmount } = render(
      <WorkflowRunBlocks
        runId="wfr_group_1"
        kind="prospect-engine"
        state={makeState(early, "running")}
        logState={early}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={GROUPED_CATALOG_STEPS}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );
    screen.getByText(/step 1 of 3/i);
    unmount();

    // The prelude group's runtime steps have both completed and the group's
    // NEXT runtime step ("discover") is now in-flight — the active display
    // step must advance to the second group, not stay frozen on the first.
    const later: LogRunState = {
      runId: "wfr_group_1",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "initBudget",
          phase: "completed",
          stepType: "deterministic",
          currentAttempt: 1,
        },
        {
          stepId: "readLedger",
          phase: "completed",
          stepType: "deterministic",
          currentAttempt: 1,
        },
        {
          stepId: "discover",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
        },
      ],
    };
    render(
      <WorkflowRunBlocks
        runId="wfr_group_1"
        kind="prospect-engine"
        state={makeState(later, "running")}
        logState={later}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={GROUPED_CATALOG_STEPS}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );
    screen.getByText(/step 2 of 3/i);
    expect(screen.queryByText(/step 1 of 3/i)).toBeNull();
  });

  it("renders a grouped display step as failed when one of its underlying runtime steps fails (CL-4285)", () => {
    const log: LogRunState = {
      runId: "wfr_group_2",
      phase: "failed",
      lastSeq: 3,
      steps: [
        {
          stepId: "initBudget",
          phase: "completed",
          stepType: "deterministic",
          currentAttempt: 1,
        },
        {
          stepId: "readLedger",
          phase: "completed",
          stepType: "deterministic",
          currentAttempt: 1,
        },
        {
          stepId: "discover",
          phase: "failed",
          stepType: "agent",
          currentAttempt: 1,
          lastError: { message: "boom" },
        },
      ],
    };
    render(
      <WorkflowRunBlocks
        runId="wfr_group_2"
        kind="prospect-engine"
        state={makeState(log, "failed")}
        logState={log}
        stepOutputs={{}}
        terminal={true}
        interrupted={false}
        catalogSteps={GROUPED_CATALOG_STEPS}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );
    // The failing group ("Discover candidates" — the SECOND group) must read
    // as the active/failed step, never the frozen first group.
    screen.getByText(/step 2 of 3/i);
  });

  it("renders the sanitized failure message and never the raw step error (CL-2660)", () => {
    // A failed step's raw error can carry internal identifiers / provider status
    // codes; only the classified, plain-language message may reach the surface.
    const log: LogRunState = {
      runId: "wfr_err",
      phase: "failed",
      lastSeq: 3,
      steps: [
        {
          stepId: "publish",
          phase: "failed",
          stepType: "deterministic",
          currentAttempt: 1,
          lastError: { message: "Attio API error: 429 rate limited ins_ses_x" },
        },
      ],
    };
    render(
      <WorkflowRunBlocks
        runId="wfr_err"
        kind="note-picker"
        state={makeState(log, "failed")}
        logState={log}
        stepOutputs={{}}
        terminal={true}
        interrupted={false}
        catalogSteps={undefined}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    screen.getByText(/Attio is rate-limiting requests right now/i);
    expect(screen.queryByText(/ins_ses_x/)).toBeNull();
    expect(screen.queryByText(/API error: 429/)).toBeNull();
  });

  it("renders the gate choice and resumes with the step's signal name on click", async () => {
    const log: LogRunState = {
      runId: "wfr_2",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "select",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "note-selection",
        },
      ],
    };
    const onRespond = mock(
      async (_response: { signalName?: string }) => undefined,
    );
    render(
      <WorkflowRunBlocks
        runId="wfr_2"
        kind="note-picker"
        state={makeState(log, "awaiting")}
        logState={log}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={undefined}
        onRespond={onRespond}
        onClose={() => undefined}
      />,
    );

    // A gate-parked run reports phase `running`; the header must surface the
    // HITL "Needs you" cue rather than a bare "Running".
    screen.getByText("Needs you");

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]?.[0]?.signalName).toBe("note-selection");
  });

  it("shows a legible failure with a restart affordance for a failed run", () => {
    const onClose = mock(() => undefined);
    render(
      <WorkflowRunBlocks
        runId="wfr_3"
        kind="note-picker"
        state={runStateFromRecord({
          runId: "wfr_3",
          kind: "note-picker",
          status: "failed",
        })}
        logState={undefined}
        stepOutputs={{}}
        terminal={true}
        interrupted={false}
        catalogSteps={undefined}
        onRespond={() => undefined}
        onClose={onClose}
      />,
    );

    screen.getByText(/this run failed\. start a new run to try again\./i);
    fireEvent.click(screen.getByText("Back to workflows"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses interrupted copy when the run was killed externally", () => {
    render(
      <WorkflowRunBlocks
        runId="wfr_4"
        kind="note-picker"
        state={runStateFromRecord({
          runId: "wfr_4",
          kind: "note-picker",
          status: "failed",
        })}
        logState={undefined}
        stepOutputs={{}}
        terminal={true}
        interrupted={true}
        catalogSteps={undefined}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    screen.getByText(/this run was interrupted and can't continue/i);
    expect(
      screen.queryByText(/this run failed\. start a new run to try again\./i),
    ).toBeNull();
  });

  it("shows a waiting state before any step has started", () => {
    const log: LogRunState = {
      runId: "wfr_5",
      phase: "running",
      lastSeq: 0,
      steps: [],
    };
    render(
      <WorkflowRunBlocks
        runId="wfr_5"
        kind="note-picker"
        state={makeState(log, "running")}
        logState={log}
        stepOutputs={{}}
        terminal={false}
        interrupted={false}
        catalogSteps={undefined}
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    screen.getByText("Waiting for run activity…");
  });
});
