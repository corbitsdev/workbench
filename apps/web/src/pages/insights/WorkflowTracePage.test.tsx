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
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

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

const TOKEN_COUNTS = {
  turnCount: 1,
  toolCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
};

let apiError: Error | null = null;
let logStateResponse: unknown = LOG_STATE;
let recordResponse: typeof RECORD = RECORD;
let tokensResponse: {
  runId: string;
  available: boolean;
  totals?: typeof TOKEN_COUNTS & { inputTokens: number; outputTokens: number };
  steps?: ({ stepId: string } & typeof TOKEN_COUNTS)[];
} = { runId: "run-1", available: false };

mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: (_method: string, path: string) => {
    if (apiError) return Promise.reject(apiError);
    if (path.includes("/state")) return Promise.resolve(logStateResponse);
    if (path.includes("/tokens")) return Promise.resolve(tokensResponse);
    if (path.includes("/records/")) {
      const runId = path.split("/records/")[1]?.split("/")[0] ?? "run-1";
      return Promise.resolve({ ...recordResponse, runId });
    }
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

import {
  WorkflowTracePage,
  formatStepDuration,
  workflowRunContextFreshness,
} from "./WorkflowTracePage";

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
  recordResponse = RECORD;
  tokensResponse = { runId: "run-1", available: false };
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

  it("shows Stopped (not Failed) in the status pill for a user-stopped run", async () => {
    recordResponse = {
      runId: "run-1",
      kind: "reddit_scanner",
      status: "stopped",
      deploymentId: "dep-1",
    };
    logStateResponse = {
      ...LOG_STATE,
      phase: "cancelled",
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
          phase: "cancelled",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: "2026-07-01T10:00:02.000Z",
          endedAt: "2026-07-01T10:00:05.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      expect(screen.getByTestId("trace-status-pill").textContent).toMatch(
        /Stopped/i,
      );
    });
    expect(screen.getByTestId("trace-status-pill").textContent).not.toMatch(
      /Failed/i,
    );
  });

  it("shows per-step token counts on the timeline when the tokens API returns step rows", async () => {
    tokensResponse = {
      runId: "run-1",
      available: true,
      totals: {
        ...TOKEN_COUNTS,
        inputTokens: 150,
        outputTokens: 30,
      },
      steps: [
        {
          stepId: "intake",
          ...TOKEN_COUNTS,
          inputTokens: 100,
          outputTokens: 20,
        },
        {
          stepId: "curate",
          ...TOKEN_COUNTS,
          inputTokens: 50,
          outputTokens: 10,
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      expect(screen.getAllByTestId("trace-step-tokens").length).toBe(2);
    });
    screen.getByText(/100 in \/ 20 out/);
    screen.getByText(/50 in \/ 10 out/);
  });

  it("shows the decoded output on the selected step without an extra expander", async () => {
    renderTrace();
    await waitFor(() => {
      screen.getByText(/Intake/);
    });
    await waitFor(() => {
      screen.getByTestId("trace-output-tree");
    });
    const payload = screen.getByTestId("trace-output-tree");
    expect(payload.textContent).toContain("items");
    expect(payload.textContent).toContain("collected");
    expect(screen.getAllByTestId("trace-step-decomposition").length).toBe(1);
  });

  it("shows the sanitized failure message with the raw error behind Operator details", async () => {
    renderTrace();
    await waitFor(() => {
      screen.getByRole("listbox");
    });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
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
    await waitFor(() => {
      expect(screen.getByTestId("trace-output-tree").textContent).toContain(
        "decoded-ok",
      );
    });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    // The malformed step is not decoded — it honestly shows the out-of-line note
    // with its raw ref, never a crash or a silent blank.
    await waitFor(() => {
      screen.getByText(/Output stored out of line/);
    });
    screen.getByText(/inline:\{not json/);
  });

  it("surfaces a live inference issue on a still-running step without requiring selection", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "draft",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 2,
          startedAt: "2026-07-01T10:00:00.000Z",
          liveIssue: {
            category: "timeout",
            occurredAt: "2026-07-01T10:01:00.000Z",
          },
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      screen.getByTestId("trace-step-live-issue");
    });
    expect(screen.getByTestId("trace-step-live-issue").textContent).toBe(
      "Model provider timed out — retrying",
    );
  });

  it("does not show a live-issue line for an in-flight step with no reported issue", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "draft",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      expect(screen.getAllByTestId("trace-step").length).toBe(1);
    });
    expect(screen.queryByTestId("trace-step-live-issue")).toBeNull();
  });

  it("shows a live elapsed indicator for an in-flight step with startedAt", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "draft",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: new Date(Date.now() - 42_000).toISOString(),
        },
      ],
    };
    renderTrace();
    await waitFor(() => {
      screen.getByTestId("trace-step-elapsed");
    });
    expect(screen.getByTestId("trace-step-elapsed").textContent).toMatch(
      /^Running · \d+s$/,
    );
  });

  it("does not show an elapsed indicator for a completed step", async () => {
    renderTrace();
    await waitFor(() => {
      expect(screen.getAllByTestId("trace-step").length).toBe(2);
    });
    expect(screen.queryByTestId("trace-step-elapsed")).toBeNull();
  });

  it("steps the run timeline with keyboard and expands only the selected step", async () => {
    renderTrace();
    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-0");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await waitFor(() => {
      expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-1");
    });
    expect(screen.getAllByTestId("trace-step-decomposition").length).toBe(1);
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
    // Data touched is unknown — show an em dash, never invent records.
    within(facet).getByText("—");
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

  it("workflowRunContextFreshness changes when step output changes without a phase change", () => {
    const steps = [
      {
        stepId: "intake",
        phase: "completed" as const,
        stepType: "deterministic" as const,
        currentAttempt: 1,
        outputRef: 'inline:{"v":1}',
      },
    ];
    const before = workflowRunContextFreshness("run-1", "running", steps, {});
    const after = workflowRunContextFreshness("run-1", "running", steps, {
      intake: { v: 2 },
    });
    expect(before).not.toBe(after);
  });

  it("toggles to waterfall overview and back", async () => {
    renderTrace();
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall"));
    expect(screen.queryByRole("listbox")).toBeNull();
    const rows = screen.getAllByTestId("trace-waterfall-row");
    expect(rows.map((r) => r.getAttribute("data-phase"))).toEqual([
      "completed",
      "failed",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Steps" }));
    await waitFor(() => screen.getByRole("listbox"));
    expect(screen.queryByTestId("trace-waterfall")).toBeNull();
  });

  it("clicking a waterfall span focuses that step in the step list", async () => {
    renderTrace();
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall"));
    const spans = screen.getAllByTestId("trace-waterfall-span");
    fireEvent.click(spans[1]!);
    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-1");
    expect(screen.getAllByTestId("trace-step-decomposition").length).toBe(1);
  });

  it("shows no end time for an in-flight step in waterfall view", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "live",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall-missing-time"));
    expect(screen.getByTestId("trace-waterfall-missing-time").textContent).toBe(
      "No end time",
    );
  });

  it("keeps an in-flight step with no end time selectable from the waterfall", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "live",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall-missing-time"));

    // The row with no end time must still be the selectable control — an
    // operator has to be able to open the active step's detail from the
    // overview, which is exactly the step that has no end timestamp yet.
    fireEvent.click(screen.getByTestId("trace-waterfall-span"));
    await waitFor(() => screen.getByRole("listbox"));
    expect(
      screen.getByRole("listbox").getAttribute("aria-activedescendant"),
    ).toBe("run-step-0");
  });

  it("labels and keeps selectable a step missing its start timestamp", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "no-start",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
          endedAt: "2026-07-01T10:00:02.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall-missing-time"));
    expect(screen.getByTestId("trace-waterfall-missing-time").textContent).toBe(
      "No start time",
    );
    fireEvent.click(screen.getByTestId("trace-waterfall-span"));
    await waitFor(() => screen.getByRole("listbox"));
    expect(
      screen.getByRole("listbox").getAttribute("aria-activedescendant"),
    ).toBe("run-step-0");
  });

  it("labels a step whose end precedes its start as timing unavailable", async () => {
    logStateResponse = {
      runId: "run-1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "reversed",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
          startedAt: "2026-07-01T10:00:05.000Z",
          endedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
    };
    renderTrace();
    await waitFor(() => screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    await waitFor(() => screen.getByTestId("trace-waterfall-missing-time"));
    expect(screen.getByTestId("trace-waterfall-missing-time").textContent).toBe(
      "Timing unavailable",
    );
  });

  it("keeps the same listbox selection when Raw is toggled inside the expanded step", async () => {
    renderTrace();
    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-0");
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-0");
  });

  it("resets facet and step selection when navigating to a different run", async () => {
    function TraceNavHarness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() => navigate("/insights/trace/run-2")}
          >
            other-run
          </button>
          <WorkflowTracePage />
        </>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/insights/trace/run-1"]}>
          <Routes>
            <Route
              path="/insights/trace/:runId"
              element={<TraceNavHarness />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.click(screen.getByRole("tab", { name: /Cost/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /Cost/ }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "other-run" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: /Timeline/ })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("run-step-0");
  });
});
