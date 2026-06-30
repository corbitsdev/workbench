import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunState } from "@intx/workflow";
import { Panel } from "./ui";

type StepPhase =
  | "in-flight"
  | "awaiting-signal"
  | "awaiting-timer"
  | "completed"
  | "failed"
  | "cancelled";

function makeState(
  phases: Record<string, StepPhase>,
  runPhase: RunState["phase"] = "running",
): RunState {
  const steps = new Map<
    string,
    { stepId: string; phase: StepPhase; currentAttempt: number }
  >();
  for (const [stepId, phase] of Object.entries(phases)) {
    steps.set(stepId, { stepId, phase, currentAttempt: 1 });
  }
  return {
    runId: "run_test",
    phase: runPhase,
    lastSeq: 0,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  } as unknown as RunState;
}

function toolEnvelope(callId: string, value: unknown): unknown {
  return { callId, content: JSON.stringify(value) };
}

const noop = () => {};

const sourceLists = {
  "list-templates": toolEnvelope("c1", [
    { gammaId: "tmpl_pro", name: "Investor Deck" },
  ]),
  "list-artifacts": toolEnvelope("c2", [{ id: "art_1", title: "Q3 Brief" }]),
  "list-notes": toolEnvelope("c3", {
    notes: [{ id: "note_1", title: "Acme call" }],
    hasMore: false,
  }),
};

describe("artifact → gamma deck Panel", () => {
  it("submits an artifact-sourced intake with the deck title and template", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    screen.getByText("Build a deck");
    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await userEvent.type(screen.getByLabelText("Deck title"), "Q3 Deck");
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({
        artifactId: "art_1",
        deckTitle: "Q3 Deck",
        gammaId: "tmpl_pro",
      }),
    );
  });

  it("does not submit intake without a deck title", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("submits a pasted-text intake from the paste tab", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await userEvent.type(screen.getByLabelText("Pasted text"), "raw notes");
    await userEvent.type(screen.getByLabelText("Deck title"), "Pasted Deck");
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ text: "raw notes", deckTitle: "Pasted Deck" }),
    );
  });

  it("submits a granola-sourced intake from the call tab", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Granola call" }));
    await userEvent.click(screen.getByRole("button", { name: "Acme call" }));
    await userEvent.type(screen.getByLabelText("Deck title"), "Call Deck");
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ noteId: "note_1", deckTitle: "Call Deck" }),
    );
  });

  it("shows the rendered deck and approves the round", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const frame = screen.getByTitle("Generated Gamma presentation");
    expect(frame.getAttribute("src")).toBe("https://gamma.app/docs/deck-1");

    await userEvent.click(
      screen.getByRole("button", { name: "Looks good — approve" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", { approved: true });
  });

  it("sends refine feedback from a non-final round", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.type(
      screen.getByLabelText("Refine feedback"),
      "make it shorter",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refine with these notes" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", {
      approved: false,
      feedback: "make it shorter",
    });
  });

  it("offers no refine on the final round", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-3": "completed",
          "preview-3": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-3": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-3",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("This is the final draft — approve to save it.");
    expect(
      screen.queryByRole("button", { name: "Refine with these notes" }),
    ).toBeNull();
  });

  it("disables approval while a signal is pending", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={true}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Looks good — approve",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("does not render an unsafe (non-https) deck url but keeps the gate answerable", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", { gammaUrl: "http://insecure/deck" }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // No iframe for an unsafe URL, and no "Open in Gamma" link to it...
    expect(screen.queryByTitle("Generated Gamma presentation")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Gamma" })).toBeNull();
    screen.getByText(/deck preview couldn't be loaded/i);
    // ...but the preview gate is still answerable so the run can't deadlock.
    await userEvent.click(
      screen.getByRole("button", { name: "Looks good — approve" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", { approved: true });
  });

  it("resolves the approved round, not a gate-skipped later round, on the done screen", () => {
    // Approving round 1 prunes rounds 2-3; the gate commits a real
    // StepCompleted (phase `completed`) with a `{ skipped: true }` sentinel for
    // every pruned step, including persist-2/persist-3. The done screen must
    // resolve to the round that actually persisted (1) and show ITS deck — not
    // the highest completed persist (a skipped 3 with no rendered deck).
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            "render-1": "completed",
            "persist-1": "completed",
            "render-3": "completed",
            "persist-2": "completed",
            "persist-3": "completed",
          },
          "completed",
        )}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
          "persist-1": toolEnvelope("c5", { artifactId: "art_out" }),
          "persist-2": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-2",
          },
          "persist-3": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-3",
          },
          "render-3": { skipped: true, gateId: "check-1", branch: "render-3" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Saved to workbench");
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
    ).toBe("https://gamma.app/docs/deck-1");
  });

  it("stays on the preview during a refine even though the pruned persist is completed", () => {
    // Refusing round 1 routes to generate-2 and prunes the persist-1 branch, so
    // persist-1 lands in `completed` with a skip sentinel. The panel must NOT
    // mistake that for a finished run and show the done screen mid-refine.
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "persist-1": "completed",
          "render-2": "completed",
          "preview-2": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "persist-1": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-1",
          },
          "render-2": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-2",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByText("Saved to workbench")).toBeNull();
    screen.getByRole("button", { name: "Looks good — approve" });
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
    ).toBe("https://gamma.app/docs/deck-2");
  });

  it("distinguishes a failed source load from an empty list", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          // A malformed (unparseable) artifacts envelope — an outage, not "no
          // artifacts" — must read as a load failure, not a calm empty state.
          "list-artifacts": { callId: "c2", content: "not json" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText(/couldn't load artifacts/i);
    expect(screen.queryByText("No saved artifacts available.")).toBeNull();
  });

  it("shows the saved-to-workbench done screen once a round is persisted", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          { "render-1": "completed", "persist-1": "completed" },
          "completed",
        )}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Saved to workbench");
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
    ).toBe("https://gamma.app/docs/deck-1");
  });

  it("shows the generation-failed banner when the run failed", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ "generate-1": "failed" }, "failed")}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Generation failed");
  });
});
