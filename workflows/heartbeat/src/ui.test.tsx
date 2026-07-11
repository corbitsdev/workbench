import { describe, expect, test } from "bun:test";
import type { RunState } from "@intx/workflow";
import { render, screen } from "@testing-library/react";
import { Panel } from "./ui";

const baseProps = {
  deploymentId: "run-1",
  logRead: true,
  state: null,
  connected: true,
  stepOutputs: {},
  signalPending: false,
  onSignal: () => {},
  onClose: () => {},
};

function stateWith(
  phase: RunState["phase"],
  steps: Record<string, { phase: string }>,
): RunState {
  return {
    phase,
    steps: new Map(Object.entries(steps)),
  } as unknown as RunState;
}

describe("heartbeat Panel", () => {
  test("shows a preparing state while the brief is still being written", () => {
    render(
      <Panel
        {...baseProps}
        state={stateWith("running", {
          intake: { phase: "completed" },
          brief: { phase: "in-flight" },
        })}
      />,
    );
    expect(screen.getByText(/preparing your morning brief/i)).toBeDefined();
    expect(screen.getAllByText(/writing your brief/i).length).toBeGreaterThan(
      0,
    );
    // The delivered-brief body must not appear yet.
    expect(screen.queryByText(/all clear today/i)).toBeNull();
  });

  test("renders the delivered brief markdown once the run completes", () => {
    render(
      <Panel
        {...baseProps}
        state={stateWith("completed", {
          intake: { phase: "completed" },
          brief: { phase: "completed" },
          notify: { phase: "completed" },
          persist: { phase: "completed" },
        })}
        stepOutputs={{
          brief: { reply: "# Morning brief\n\nAll clear today." },
        }}
      />,
    );
    expect(screen.getByText(/all clear today/i)).toBeDefined();
    expect(
      screen.getByText(/sent to your inbox and saved to your workbench/i),
    ).toBeDefined();
  });

  test("shows the failure notice and no brief when a step fails", () => {
    render(
      <Panel
        {...baseProps}
        state={stateWith("failed", {
          intake: { phase: "completed" },
          brief: { phase: "failed" },
        })}
        stepOutputs={{
          brief: { reply: "# Morning brief\n\nAll clear today." },
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Run failed");
    // A failed run must not render the brief body, even if an output is present.
    expect(screen.queryByText(/all clear today/i)).toBeNull();
  });
});
