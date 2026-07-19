/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

let runsResult: {
  data?: unknown[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = { data: [], isLoading: false, isError: false, refetch: () => {} };

let activeTenantId: string | null = "ten-1";
let lastArchivedRunId: string | null = null;

mock.module("../../hooks/use-workflow", () => ({
  useWorkflowRuns: () => runsResult,
  useArchiveWorkflowRun: () => ({
    isPending: false,
    isError: false,
    variables: undefined,
    mutateAsync: (runId: string) => {
      lastArchivedRunId = runId;
      return Promise.resolve(undefined);
    },
  }),
}));

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: null,
    activeTenantId,
    setActiveWorkbench: () => {},
  }),
}));

const { WorkflowRunHistory } = require("./WorkflowRunHistory");

afterEach(() => {
  cleanup();
  activeTenantId = "ten-1";
  lastArchivedRunId = null;
  runsResult = {
    data: [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  };
});

function renderHistory(initialPath = "/insights/runs") {
  const router = createMemoryRouter(
    [
      {
        path: "/insights/runs",
        element: React.createElement(WorkflowRunHistory),
      },
      {
        path: "/insights/trace/:runId",
        element: React.createElement("div", { "data-testid": "trace" }),
      },
      {
        path: "/workflows",
        element: React.createElement("div", null, "catalog"),
      },
      {
        path: "/workflows/:workflowId",
        element: React.createElement("div", { "data-testid": "run-pane" }),
      },
    ],
    { initialEntries: [initialPath] },
  );
  const view = render(React.createElement(RouterProvider, { router }));
  return { router, ...view };
}

const TWO_RUNS = [
  {
    runId: "run-1",
    kind: "deck-build",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    runId: "run-2",
    kind: "last30days",
    status: "failed",
    createdAt: "2026-01-02T00:00:00Z",
  },
];

describe("WorkflowRunHistory", () => {
  it("shows an empty state when there are no runs", () => {
    renderHistory();
    screen.getByText(/no workflow runs yet/i);
  });

  it("shows a loading state", () => {
    runsResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: () => {},
    };
    renderHistory();
    screen.getByText(/loading runs/i);
  });

  it("links each run row to its trace page", () => {
    runsResult = {
      data: TWO_RUNS,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderHistory();
    fireEvent.click(screen.getByText("Deck build", { selector: "span" }));
    expect(router.state.location.pathname).toBe("/insights/trace/run-1");
  });

  it("links an awaiting run row to its interactive gate pane", () => {
    runsResult = {
      data: [
        {
          runId: "run-3",
          kind: "pain",
          status: "awaiting",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderHistory();
    fireEvent.click(screen.getByText("Pain", { selector: "span" }));
    expect(router.state.location.pathname).toBe("/workflows/run-3");
  });

  it("filters the list by status", () => {
    runsResult = {
      data: TWO_RUNS,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderHistory();
    screen.getByText("Deck build", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });
  });

  it("offers a Stopped status filter and labels stopped runs as Stopped", () => {
    runsResult = {
      data: [
        ...TWO_RUNS,
        {
          runId: "run-stopped",
          kind: "pain",
          status: "stopped",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderHistory();
    // Row label is Stopped (not Failed).
    screen.getByText("Stopped", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "Stopped" }));
    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    expect(screen.queryByText("Last30days", { selector: "span" })).toBeNull();
    screen.getByText("Pain", { selector: "span" });
  });

  it("searches by workflow kind", () => {
    runsResult = {
      data: TWO_RUNS,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderHistory();
    fireEvent.change(screen.getByLabelText("Search runs"), {
      target: { value: "last30" },
    });
    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });
  });

  it("archives a run only after an explicit confirm", () => {
    runsResult = {
      data: TWO_RUNS,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderHistory();
    fireEvent.click(screen.getByLabelText("Archive deck-build run"));
    expect(lastArchivedRunId).toBeNull();
    fireEvent.click(
      screen.getByLabelText(/confirm: stop and remove deck-build run/i),
    );
    expect(lastArchivedRunId).toBe("run-1");
  });
});
