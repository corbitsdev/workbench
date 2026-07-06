/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
let logStateResponse: unknown = LOG_STATE;

mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: (_method: string, path: string) => {
    if (apiError) return Promise.reject(apiError);
    if (path.includes("/state")) return Promise.resolve(logStateResponse);
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
  logStateResponse = LOG_STATE;
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
    // The completed step's phase label shows inside its row (the stat strip also
    // has a "Completed" stat, so scope to the step rows).
    expect(rows.some((r) => /Completed/.test(r.textContent ?? ""))).toBe(true);
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

  it("renders a sibling's decoded output even when another step's inline blob is malformed", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "completed",
      lastSeq: 4,
      steps: [
        {
          stepId: "good_step",
          phase: "completed",
          stepType: "deterministic",
          currentAttempt: 1,
          outputRef: `inline:${JSON.stringify({ marker: "decoded-ok" })}`,
        },
        {
          stepId: "broken_step",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
          outputRef: "inline:{not json",
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      expect(screen.getAllByTestId("trace-step").length).toBe(2);
    });
    // The good sibling still decodes and its output opens.
    fireEvent.click(screen.getByText("Output"));
    await waitFor(() => {
      expect(screen.getByTestId("trace-payload").textContent).toContain(
        "decoded-ok",
      );
    });
    // The malformed step is not decoded — it honestly shows the out-of-line note
    // with its raw ref, never a crash or a silent blank.
    screen.getByText(/Output stored out of line/);
    screen.getByText(/inline:\{not json/);
  });

  it("surfaces the out-of-line note for a blob: (non-inline) outputRef", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "completed",
      lastSeq: 2,
      steps: [
        {
          stepId: "huge_step",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
          outputRef: "blob:" + "a".repeat(40),
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Output stored out of line/);
    });
    // No Output expander for an unresolvable ref.
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("renders the retry attempt count for a step past its first attempt", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "flaky_step",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 3,
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      screen.getByText("Attempt 3");
    });
  });

  it("aggregates the run's deterministic (tool) steps on the Tools facet", async () => {
    renderTrace();
    await waitFor(() => screen.getByText(/Intake/));
    fireEvent.click(screen.getByRole("tab", { name: /Tools/ }));
    const facet = await waitFor(() => screen.getByTestId("facet-tools"));
    // Only the deterministic "intake" step is a tool step; the agent "curate"
    // step is not counted.
    within(facet).getByText("Intake");
    expect(within(facet).queryByText("Curate")).toBeNull();
    // The concrete records touched are an honest gap, never invented.
    within(facet).getByText("which records?");
  });

  it("shows '—' (not a fabricated 0) in the stat strip when the run can't load", async () => {
    apiError = new Error("HTTP 403");
    renderTrace();
    const strip = await waitFor(() => screen.getByTestId("trace-stat-strip"));
    await waitFor(() => within(strip).getByText("Steps"));
    expect(within(strip).getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(within(strip).queryByText("0")).toBeNull();
  });

  it("renders the parked signal name for an awaiting-signal step", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "review_step",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "approve-draft",
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Parked on signal/);
    });
    screen.getByText("approve-draft");
  });
});
