/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

let runsResult: {
  data?: unknown[];
  isLoading: boolean;
  isError: boolean;
} = { data: [], isLoading: false, isError: false };

mock.module("../hooks/use-workflow", () => ({
  useWorkflowRuns: () => runsResult,
}));

const { ActiveWorkflowRuns } = require("./ActiveWorkflowRuns");

afterEach(() => {
  cleanup();
  runsResult = { data: [], isLoading: false, isError: false };
});

function renderStrip() {
  const router = createMemoryRouter(
    [
      {
        path: "/workflows",
        element: React.createElement(ActiveWorkflowRuns, {
          tenantId: "ten-1",
        }),
      },
      {
        path: "/workflows/:workflowId",
        element: React.createElement("div", { "data-testid": "run-pane" }),
      },
    ],
    { initialEntries: ["/workflows"] },
  );
  const view = render(React.createElement(RouterProvider, { router }));
  return { router, ...view };
}

const MIXED_RUNS = [
  {
    runId: "run-provisioning",
    kind: "deck-build",
    status: "provisioning",
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    runId: "run-running",
    kind: "last30days",
    status: "running",
    createdAt: "2026-01-02T00:00:00Z",
  },
  {
    runId: "run-awaiting",
    kind: "pain",
    status: "awaiting",
    createdAt: "2026-01-03T00:00:00Z",
  },
  {
    runId: "run-completed",
    kind: "gamma",
    status: "completed",
    createdAt: "2026-01-04T00:00:00Z",
  },
  {
    runId: "run-failed",
    kind: "mvt",
    status: "failed",
    createdAt: "2026-01-05T00:00:00Z",
  },
];

describe("ActiveWorkflowRuns", () => {
  it("lists only non-terminal runs", () => {
    runsResult = { data: MIXED_RUNS, isLoading: false, isError: false };
    renderStrip();
    screen.getByText("Deck build");
    screen.getByText("Last30days");
    screen.getByText("Pain");
    expect(screen.queryByText("Gamma")).toBeNull();
    expect(screen.queryByText("Mvt")).toBeNull();
  });

  it("opens the interactive run pane when a run is clicked", () => {
    runsResult = { data: MIXED_RUNS, isLoading: false, isError: false };
    const { router } = renderStrip();
    fireEvent.click(screen.getByText("Pain"));
    expect(router.state.location.pathname).toBe("/workflows/run-awaiting");
  });

  it("renders nothing when every run is terminal", () => {
    runsResult = {
      data: MIXED_RUNS.filter(
        (r) => r.status === "completed" || r.status === "failed",
      ),
      isLoading: false,
      isError: false,
    };
    const { container } = renderStrip();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when run data is unavailable", () => {
    runsResult = { data: undefined, isLoading: true, isError: false };
    const { container } = renderStrip();
    expect(container.textContent).toBe("");
  });
});
