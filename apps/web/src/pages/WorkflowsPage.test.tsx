/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

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

describe("WorkflowsPage", () => {
  it("shows a loading state", () => {
    runsResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: () => {},
    };
    render(React.createElement(WorkflowsPage));
    expect(screen.getByText(/loading runs/i)).toBeDefined();
  });

  it("shows an empty state when there are no runs", () => {
    runsResult = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    render(React.createElement(WorkflowsPage));
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
    render(React.createElement(WorkflowsPage));
    expect(lastRunsTenantId).toBe("ten-42");
    fireEvent.click(screen.getByText("Deck build", { selector: "span" }));
    expect(lastPaneTenantId).toBe("ten-42");
  });

  it("lists runs and opens the run pane on select", () => {
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
    render(React.createElement(WorkflowsPage));
    screen.getByText("Deck build", { selector: "span" });
    expect(screen.queryByTestId("run-pane")).toBeNull();
    fireEvent.click(screen.getByText("Deck build", { selector: "span" }));
    expect(screen.getByTestId("run-pane").textContent).toBe("run-1");
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
    render(React.createElement(WorkflowsPage));

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
    render(React.createElement(WorkflowsPage));

    screen.getByText("Deck build", { selector: "span" });
    screen.getByText("Last30days", { selector: "span" });

    fireEvent.change(screen.getByLabelText("Filter by status"), {
      target: { value: "failed" },
    });

    expect(screen.queryByText("Deck build", { selector: "span" })).toBeNull();
    screen.getByText("Last30days", { selector: "span" });
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
    render(React.createElement(WorkflowsPage));

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
    render(React.createElement(WorkflowsPage));

    expect(screen.queryByTestId("stub-start")).toBeNull();
    fireEvent.click(screen.getByText(/new run/i));
    expect(lastCatalogProps?.open).toBe(true);
    expect(lastCatalogProps?.tenantId).toBe("ten-7");

    fireEvent.click(screen.getByTestId("stub-start"));
    // The new run's detail opens, scoped to the active tenant.
    expect(screen.getByTestId("run-pane").textContent).toBe("run-new");
    expect(lastPaneTenantId).toBe("ten-7");
  });
});
