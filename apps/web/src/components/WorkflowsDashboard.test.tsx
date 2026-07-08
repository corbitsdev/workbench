import { describe, expect, it, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowsDashboard } from "./WorkflowsDashboard";
import type { WorkflowRun } from "../hooks/use-workflow";
import { DEFAULT_RUN_FILTERS } from "../lib/workflow-run-filters";

function run(partial: Partial<WorkflowRun> & { status: string }): WorkflowRun {
  return {
    runId: partial.runId ?? `run-${partial.status}-${Math.random()}`,
    kind: partial.kind ?? "last30days",
    status: partial.status,
    createdAt: partial.createdAt ?? "2026-07-01T00:00:00.000Z",
  } as WorkflowRun;
}

function renderDashboard(overrides: {
  runs?: WorkflowRun[];
  onFilterStatus?: (status: WorkflowRun["status"]) => void;
}) {
  return render(
    <WorkflowsDashboard
      runs={overrides.runs ?? []}
      isLoading={false}
      isError={false}
      pinned={false}
      statusFilter={DEFAULT_RUN_FILTERS.status}
      selectedRunMissing={false}
      onSelectRun={mock(() => {})}
      onFilterStatus={overrides.onFilterStatus ?? mock(() => {})}
      onShowAll={mock(() => {})}
      catalog={<div data-testid="catalog" />}
    />,
  );
}

describe("WorkflowsDashboard status summary", () => {
  it("shows the four run statuses with their counts", () => {
    renderDashboard({
      runs: [
        run({ status: "completed" }),
        run({ status: "completed" }),
        run({ status: "running" }),
      ],
    });
    expect(
      screen.getByRole("button", { name: /2 completed runs/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /1 running runs/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /0 starting runs/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /0 awaiting runs/i }),
    ).toBeTruthy();
  });

  it("never surfaces a failed count anywhere", () => {
    renderDashboard({
      runs: [run({ status: "completed" }), run({ status: "failed" })],
    });
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /failed/i })).toBeNull();
  });

  it("renders no New run button", () => {
    renderDashboard({ runs: [run({ status: "completed" })] });
    expect(screen.queryByRole("button", { name: /new run/i })).toBeNull();
  });

  it("filters when a status metric is clicked", () => {
    const onFilterStatus = mock(() => {});
    renderDashboard({
      runs: [run({ status: "completed" })],
      onFilterStatus,
    });
    fireEvent.click(screen.getByRole("button", { name: /completed runs/i }));
    expect(onFilterStatus).toHaveBeenCalledWith("completed");
  });

  it("folds an empty active state into a quiet line with no Active heading", () => {
    renderDashboard({ runs: [run({ status: "completed" })] });
    expect(
      screen.queryByRole("heading", { name: /^active$/i, level: 2 }),
    ).toBeNull();
    expect(screen.getByText(/no active runs/i)).toBeTruthy();
  });
});
