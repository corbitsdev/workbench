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
  refetch: () => void;
} = { data: [], isLoading: false, isError: false, refetch: () => {} };

let lastRunsTenantId: string | null | undefined;
let activeTenantId: string | null = "ten-1";

mock.module("../hooks/use-workflow", () => ({
  useWorkflowRuns: (tenantId?: string | null) => {
    lastRunsTenantId = tenantId;
    return runsResult;
  },
}));

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: null,
    activeTenantId,
    setActiveWorkbench: () => {},
  }),
}));

let lastPaneTenantId: string | null | undefined;
mock.module("../components/WorkflowRunPane", () => ({
  WorkflowRunPane: (props: {
    deploymentId: string;
    tenantId?: string | null;
  }) => {
    lastPaneTenantId = props.tenantId;
    return React.createElement(
      "div",
      { "data-testid": "run-pane" },
      props.deploymentId,
    );
  },
}));

mock.module("../components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// Stub the catalog modal: when open, expose a button that simulates a user
// choosing a kind and the start mutation resolving with a new runId.
let lastCatalogProps: {
  open: boolean;
  tenantId: string | null;
  onWorkflowStarted: (runId: string) => void;
} | null = null;
mock.module("../components/layout/UnifiedCatalogModal", () => ({
  UnifiedCatalogModal: (props: {
    open: boolean;
    tenantId: string | null;
    onWorkflowStarted: (runId: string) => void;
  }) => {
    lastCatalogProps = props;
    if (!props.open) return null;
    return React.createElement(
      "button",
      {
        "data-testid": "stub-start",
        onClick: () => props.onWorkflowStarted("run-new"),
      },
      "start kind",
    );
  },
}));

const { WorkflowsPage } = require("./WorkflowsPage");

afterEach(() => {
  cleanup();
  localStorage.clear();
  activeTenantId = "ten-1";
  lastRunsTenantId = undefined;
  lastPaneTenantId = undefined;
  lastCatalogProps = null;
});

function renderWorkflowsPage(initialPath = "/workflows") {
  const router = createMemoryRouter(
    [
      {
        path: "/workflows",
        element: React.createElement(WorkflowsPage),
      },
      {
        path: "/workflows/:workflowId",
        element: React.createElement(WorkflowsPage),
      },
    ],
    { initialEntries: [initialPath] },
  );
  const view = render(React.createElement(RouterProvider, { router }));
  return { router, ...view };
}

describe("WorkflowsPage", () => {
  it("shows a loading state", () => {
    runsResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();
    expect(screen.getByText(/loading runs/i)).toBeDefined();
  });

  it("shows an empty state when there are no runs", () => {
    runsResult = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();
    expect(screen.getByText(/no workflow runs yet/i)).toBeDefined();
  });

  it("scopes the run list and run pane to the active workbench tenant", () => {
    activeTenantId = "ten-42";
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage("/workflows/run-1");
    expect(lastRunsTenantId).toBe("ten-42");
    expect(lastPaneTenantId).toBe("ten-42");
  });

  it("navigates to /workflows/:workflowId when a run is selected", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderWorkflowsPage();
    fireEvent.click(screen.getByText("Deck build", { selector: "span" }));
    expect(router.state.location.pathname).toBe("/workflows/run-1");
  });

  it("opens run pane from /workflows/:workflowId deep link", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage("/workflows/run-1");
    expect(screen.getByTestId("run-pane").textContent).toBe("run-1");
  });

  it("renders the empty state (not the run pane) when deep-linking to an unknown run id", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage("/workflows/does-not-exist");
    expect(screen.queryByTestId("run-pane")).toBeNull();
    screen.getByText(/select a run to view its details/i);
  });

  it("drops the URL back to /workflows when the currently-selected run is archived", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderWorkflowsPage("/workflows/run-1");
    expect(router.state.location.pathname).toBe("/workflows/run-1");

    fireEvent.click(screen.getByLabelText("Archive deck-build run"));
    expect(router.state.location.pathname).toBe("/workflows");
  });

  it("archives a run (hidden by default) and reveals it via Show archived", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          runId: "run-2",
          kind: "last30days",
          status: "completed",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();

    // Archive the deck-build run via its row action.
    fireEvent.click(screen.getByLabelText("Archive deck-build run"));

    // It is now hidden from the default list; the other run stays.
    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });

    // Reveal archived runs, then the archived run is shown again.
    fireEvent.click(screen.getByText(/show 1 archived/i));
    screen.getByText("Deck build", { selector: "span" });
  });

  it("filters the run list by status", () => {
    runsResult = {
      data: [
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
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();

    screen.getByText("Deck build", { selector: "span" });
    screen.getByText("Last30days", { selector: "span" });

    fireEvent.click(screen.getByRole("button", { name: "Failed" }));

    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });
  });

  it("resets filters from the toolbar control", () => {
    runsResult = {
      data: [
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
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();

    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    screen.getByText("Deck build", { selector: "span" });
  });

  it("searches the run list by workflow kind", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          runId: "run-2",
          kind: "last30days",
          status: "completed",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();

    fireEvent.change(screen.getByLabelText("Search runs"), {
      target: { value: "last30" },
    });

    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });
  });

  it("opens the catalog on New run, and starting a run selects it", () => {
    activeTenantId = "ten-7";
    runsResult = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderWorkflowsPage();

    expect(screen.queryByTestId("stub-start")).toBeNull();
    fireEvent.click(screen.getByText(/new run/i));
    expect(lastCatalogProps?.open).toBe(true);
    expect(lastCatalogProps?.tenantId).toBe("ten-7");

    fireEvent.click(screen.getByTestId("stub-start"));
    expect(router.state.location.pathname).toBe("/workflows/run-new");
  });
});
