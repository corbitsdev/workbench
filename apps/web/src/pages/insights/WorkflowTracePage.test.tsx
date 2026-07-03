/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";

const INTAKE_OUTPUT = { items: 3, note: "collected" };

const LOG_STATE = {
  runId: "run-1",
  phase: "failed",
  lastSeq: 6,
  startedAt: "2026-07-01T10:00:00.000Z",
  endedAt: "2026-07-01T10:00:05.000Z",
  steps: [
    {
      stepId: "intake",
      phase: "completed",
      stepType: "deterministic",
      currentAttempt: 1,
      startedAt: "2026-07-01T10:00:00.000Z",
      endedAt: "2026-07-01T10:00:02.000Z",
      outputRef: `inline:${JSON.stringify(INTAKE_OUTPUT)}`,
    },
    {
      stepId: "curate",
      phase: "failed",
      stepType: "agent",
      currentAttempt: 1,
      startedAt: "2026-07-01T10:00:02.000Z",
      endedAt: "2026-07-01T10:00:05.000Z",
      lastError: {
        message: "Reddit API error: 429 too many requests (ins_secret_abc)",
      },
    },
  ],
};

const RECORD = {
  runId: "run-1",
  kind: "reddit_scanner",
  status: "failed",
  deploymentId: "dep-1",
};

let apiError: Error | null = null;

mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: (_method: string, path: string) => {
    if (apiError) return Promise.reject(apiError);
    if (path.includes("/state")) return Promise.resolve(LOG_STATE);
    if (path.includes("/records/")) return Promise.resolve(RECORD);
    return Promise.reject(new Error(`unexpected path ${path}`));
  },
}));

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: {
      id: "p1",
      tenantId: "t1",
      tenantSlug: "",
      tenantName: "",
    },
    activeTenantId: "t1",
    setActiveWorkbench: () => {},
  }),
}));

import { WorkflowTracePage, formatStepDuration } from "./WorkflowTracePage";

function renderTrace(runId = "run-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/insights/trace/${runId}`]}>
        <Routes>
          <Route
            path="/insights/trace/:runId"
            element={<WorkflowTracePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiError = null;
});

afterEach(() => {
  cleanup();
});

describe("formatStepDuration", () => {
  it("returns null unless both boundaries are present", () => {
    expect(
      formatStepDuration(undefined, "2026-07-01T10:00:02.000Z"),
    ).toBeNull();
    expect(
      formatStepDuration("2026-07-01T10:00:00.000Z", undefined),
    ).toBeNull();
  });

  it("never invents a negative span", () => {
    expect(
      formatStepDuration(
        "2026-07-01T10:00:05.000Z",
        "2026-07-01T10:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("formats a real span honestly", () => {
    expect(
      formatStepDuration(
        "2026-07-01T10:00:00.000Z",
        "2026-07-01T10:00:02.000Z",
      ),
    ).toBe("2.0s");
  });
});

describe("WorkflowTracePage", () => {
  it("renders each step with its status and honest duration", async () => {
    renderTrace();
    await waitFor(() => {
      expect(screen.getAllByTestId("trace-step").length).toBe(2);
    });
    const rows = screen.getAllByTestId("trace-step");
    expect(rows.map((r) => r.getAttribute("data-phase"))).toEqual([
      "completed",
      "failed",
    ]);
    screen.getByText(/Intake/);
    screen.getByText(/Curate/);
    screen.getByText("Completed");
    // completed intake ran 2s; only steps with both timestamps show a duration.
    const durations = screen.getAllByTestId("trace-step-duration");
    expect(durations.map((d) => d.textContent)).toContain("2.0s");
  });

  it("shows the decoded output payload behind the Output expander", async () => {
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Intake/);
    });
    // Collapsed by default — the payload is not dumped inline.
    expect(screen.queryByTestId("trace-payload")).toBeNull();
    fireEvent.click(screen.getByText("Output"));
    await waitFor(() => {
      screen.getByTestId("trace-payload");
    });
    const payload = screen.getByTestId("trace-payload");
    expect(payload.textContent).toContain("items");
    expect(payload.textContent).toContain("collected");
  });

  it("shows the sanitized failure message with the raw error behind Operator details", async () => {
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Curate/);
    });
    // Sanitized, plain-language message — never the raw provider text.
    expect(screen.getAllByText(/rate-limiting/i).length).toBeGreaterThanOrEqual(
      1,
    );
    // Raw operator text is hidden until explicitly expanded.
    expect(screen.queryByTestId("trace-operator-details")).toBeNull();
    expect(screen.queryByText(/ins_secret_abc/)).toBeNull();

    fireEvent.click(screen.getByText("Operator details"));
    await waitFor(() => {
      screen.getByTestId("trace-operator-details");
    });
    expect(screen.getByTestId("trace-operator-details").textContent).toContain(
      "ins_secret_abc",
    );
  });

  it("shows a legible error when the run can't be loaded", async () => {
    apiError = new Error("HTTP 403");
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Couldn’t load this run/);
    });
  });
});
