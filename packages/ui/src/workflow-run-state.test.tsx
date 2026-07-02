import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { RunState } from "@intx/workflow";
import {
  activeDisplayStep,
  activeDisplayStepIndex,
  buildStepperSteps as buildRunStepperSteps,
  displayStepPhase,
  liveStatusLabel,
  LiveStatus,
  LiveStatusSlot,
  type DisplayStep,
} from "./workflow-run-state";

const STEPS: DisplayStep[] = [
  { key: "intake", label: "Topic", stepIds: ["intake"] },
  {
    key: "research",
    label: "Research",
    stepIds: ["ground", "brief"],
    activityLabel: "Gathering signal",
  },
  {
    key: "report",
    label: "Report",
    stepIds: ["write"],
    activityLabel: "Writing the report",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist"],
    activityLabel: "Saving to workbench",
  },
];

function stateFrom(entries: [string, string][]): RunState {
  return {
    phase: "running",
    steps: new Map(entries.map(([id, phase]) => [id, { phase }])),
  } as unknown as RunState;
}

describe("workflow-run-state", () => {
  test("first step is active with no run state", () => {
    expect(activeDisplayStepIndex(null, STEPS)).toBe(0);
    expect(activeDisplayStep(null, STEPS)?.key).toBe("intake");
  });

  test("a gate whose output is absent does not rewind once a later step runs", () => {
    // intake (an awaitSignal gate) is missing from the synthesized state, but a
    // research step is in-flight: the run is on Research, never back on Topic.
    const state = stateFrom([["ground", "in-flight"]]);
    expect(activeDisplayStep(state, STEPS)?.key).toBe("research");
    const stepper = buildRunStepperSteps(state, STEPS);
    expect(stepper[0]?.status).toBe("completed"); // intake shown as done
    expect(stepper[1]?.status).toBe("current");
  });

  test("parked on the intake gate stays on the first step", () => {
    const state = stateFrom([["intake", "awaiting-signal"]]);
    expect(activeDisplayStep(state, STEPS)?.key).toBe("intake");
    expect(buildRunStepperSteps(state, STEPS)[0]?.status).toBe("current");
  });

  test("a clustered display step reads completed only when its terminal step completes", () => {
    const midRun = stateFrom([
      ["intake", "completed"],
      ["ground", "completed"],
    ]);
    // ground done but brief (terminal) not started → research still in-flight
    expect(displayStepPhase(midRun, ["ground", "brief"])).toBe("in-flight");
    const done = stateFrom([
      ["ground", "completed"],
      ["brief", "completed"],
    ]);
    expect(displayStepPhase(done, ["ground", "brief"])).toBe("completed");
  });

  test("all steps complete lands on the last step", () => {
    const state = {
      phase: "completed",
      steps: new Map([
        ["intake", { phase: "completed" }],
        ["brief", { phase: "completed" }],
        ["write", { phase: "completed" }],
        ["persist", { phase: "completed" }],
      ]),
    } as unknown as RunState;
    expect(activeDisplayStep(state, STEPS)?.key).toBe("done");
    expect(buildRunStepperSteps(state, STEPS).at(-1)?.status).toBe("completed");
  });

  test("live label uses the active step's activityLabel but is silent on gate and first step", () => {
    // first step in-flight → silent (its screen owns the indicator)
    expect(
      liveStatusLabel(stateFrom([["intake", "in-flight"]]), STEPS),
    ).toBeNull();
    // report in-flight → surfaces its verb activityLabel, not the stepper noun
    expect(liveStatusLabel(stateFrom([["write", "in-flight"]]), STEPS)).toBe(
      "Writing the report",
    );
    // parked on a later awaitSignal gate → silent
    const gated = stateFrom([
      ["brief", "completed"],
      ["write", "awaiting-signal"],
    ]);
    expect(liveStatusLabel(gated, STEPS)).toBeNull();
    // terminal run → silent
    expect(
      liveStatusLabel(
        { phase: "completed", steps: new Map() } as unknown as RunState,
        STEPS,
      ),
    ).toBeNull();
  });

  test("live label is silent when the active step has no activityLabel", () => {
    // An active machine step without an activityLabel shows NO line rather than
    // a misleading stepper noun.
    const NO_LABEL: DisplayStep[] = [
      { key: "intake", label: "Topic", stepIds: ["intake"] },
      { key: "build", label: "Build", stepIds: ["build"] },
    ];
    const state = stateFrom([
      ["intake", "completed"],
      ["build", "in-flight"],
    ]);
    expect(liveStatusLabel(state, NO_LABEL)).toBeNull();
  });

  test("buildStepperSteps marks the active step failed when its runtime phase is failed, instead of leaving it as current", () => {
    // research's terminal step (brief) failed while ground already completed —
    // the display step must render as "failed", not fall through to "current"
    // (CL-2654: a failed step looked identical to a still-running one).
    const state = stateFrom([
      ["intake", "completed"],
      ["ground", "completed"],
      ["brief", "failed"],
    ]);
    const stepper = buildRunStepperSteps(state, STEPS);
    expect(stepper[1]?.status).toBe("failed");
  });

  test("a failed step is never skipped over as 'passed' just because a later, independently-running step progressed", () => {
    // research (index 1) fails while report (index 2) is concurrently
    // in-flight — a real DAG shape, not hypothetical (AGENTS.md: independent
    // steps run concurrently). The old `laterProgressed` rule treated ANY
    // non-completed step as passed once a later step moved, silently
    // re-labeling the failed step "completed" (CL-2654 follow-up).
    const state = stateFrom([
      ["intake", "completed"],
      ["ground", "completed"],
      ["brief", "failed"],
      ["write", "in-flight"],
    ]);
    expect(activeDisplayStepIndex(state, STEPS)).toBe(1);
    const stepper = buildRunStepperSteps(state, STEPS);
    expect(stepper[1]?.status).toBe("failed");
  });

  test("buildStepperSteps marks every step completed once the run is completed, even if the terminal step output is absent", () => {
    // brief (research terminal) and persist are missing from the synthesized
    // record, but the run reports completed — nothing should linger as "current".
    const state = {
      phase: "completed",
      steps: new Map([
        ["intake", { phase: "completed" }],
        ["ground", { phase: "completed" }],
        ["write", { phase: "completed" }],
      ]),
    } as unknown as RunState;
    const stepper = buildRunStepperSteps(state, STEPS);
    expect(stepper.every((step) => step.status === "completed")).toBe(true);
  });

  test("LiveStatus renders the label with an ellipsis", () => {
    render(<LiveStatus label="Searching GitHub" />);
    screen.getByText(/Searching GitHub…/);
  });

  test("LiveStatusSlot renders the live line when a label is present", () => {
    render(<LiveStatusSlot label="Searching GitHub" />);
    screen.getByText(/Searching GitHub…/);
  });

  test("LiveStatusSlot renders nothing when the label is null", () => {
    render(<LiveStatusSlot label={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
