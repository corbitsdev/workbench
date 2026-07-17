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
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    // Both steps render as timeline entries.
    screen.getByText("intake");
    screen.getByText("select");
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
        onRespond={() => undefined}
        onClose={() => undefined}
      />,
    );

    screen.getByText("Waiting for run activity…");
  });
});
