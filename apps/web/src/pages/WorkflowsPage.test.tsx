/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

// The run list, search, and filters now live in the hover/focus-to-expand
// overlay. Latch it open via the rail's expand toggle so those controls are
// present and interactive before a test drives them.
function expandRail() {
  fireEvent.click(screen.getByRole("button", { name: /expand run list/i }));
}

// The no-selection landing dashboard renders the same kind labels as the rail
// (active cards + recents), so rail-scoped assertions must query within the
// rail overlay to stay unambiguous.
function rail() {
  const el = document.getElementById("workflow-rail-overlay");
  if (!el) throw new Error("rail overlay not found");
  return within(el);
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
    expandRail();
    fireEvent.click(rail().getByText("Deck build", { selector: "span" }));
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

  it("renders the dashboard with a not-available note (not the run pane) when deep-linking to an unknown run id", () => {
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
    screen.getByText(/that run is no longer available/i);
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

    expandRail();
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
    expandRail();

    // Archive the deck-build run via its row action.
    fireEvent.click(screen.getByLabelText("Archive deck-build run"));

    // It is now hidden from the default rail list; the other run stays.
    expect(rail().queryByText("Deck build", { selector: "span" })).toBeNull();
    rail().getByText("Last30days", { selector: "span" });

    // Reveal archived runs, then the archived run is shown again.
    fireEvent.click(screen.getByText(/show 1 archived/i));
    rail().getByText("Deck build", { selector: "span" });
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
    expandRail();

    rail().getByText("Deck build", { selector: "span" });
    rail().getByText("Last30days", { selector: "span" });

    fireEvent.click(screen.getByRole("button", { name: "Failed" }));

    expect(rail().queryByText("Deck build", { selector: "span" })).toBeNull();
    rail().getByText("Last30days", { selector: "span" });
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
    expandRail();

    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(rail().queryByText("Deck build", { selector: "span" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    rail().getByText("Deck build", { selector: "span" });
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
    expandRail();

    fireEvent.change(screen.getByLabelText("Search runs"), {
      target: { value: "last30" },
    });

    expect(rail().queryByText("Deck build", { selector: "span" })).toBeNull();
    rail().getByText("Last30days", { selector: "span" });
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
    // With zero runs the rail and the dashboard empty-state each expose a
    // New-run button; either opens the catalog.
    fireEvent.click(screen.getAllByRole("button", { name: /new run/i })[0]);
    expect(lastCatalogProps?.open).toBe(true);
    expect(lastCatalogProps?.tenantId).toBe("ten-7");

    fireEvent.click(screen.getByTestId("stub-start"));
    expect(router.state.location.pathname).toBe("/workflows/run-new");
  });

  it("renders stat counts from the runs on the landing dashboard", () => {
    runsResult = {
      data: [
        {
          runId: "run-1",
          kind: "deck-build",
          status: "running",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          runId: "run-2",
          kind: "last30days",
          status: "awaiting",
          createdAt: "2026-01-02T00:00:00Z",
        },
        {
          runId: "run-3",
          kind: "deck-build",
          status: "completed",
          createdAt: "2026-01-03T00:00:00Z",
        },
        {
          runId: "run-4",
          kind: "last30days",
          status: "failed",
          createdAt: "2026-01-04T00:00:00Z",
        },
        {
          runId: "run-5",
          kind: "deck-build",
          status: "failed",
          createdAt: "2026-01-05T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();
    screen.getByLabelText("Show 1 running runs");
    screen.getByLabelText("Show 1 awaiting runs");
    screen.getByLabelText("Show 1 completed runs");
    screen.getByLabelText("Show 2 failed runs");
  });

  it("clicking a stat tile applies the status filter and pins the rail", () => {
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
    const failedTile = screen.getByLabelText("Show 1 failed runs");
    expect(failedTile.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(failedTile);

    expect(
      screen.getByLabelText("Show 1 failed runs").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(localStorage.getItem("workflow-rail-pinned")).toBe("1");
  });

  it("clicking an active workflow card navigates to that run", () => {
    runsResult = {
      data: [
        {
          runId: "run-active",
          kind: "deck-build",
          status: "awaiting",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    const { router } = renderWorkflowsPage();
    fireEvent.click(screen.getByText("Needs you"));
    expect(router.state.location.pathname).toBe("/workflows/run-active");
  });

  it("renders the workflows launcher sidebar (not a second run list) + a view-all-runs link", () => {
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
    renderWorkflowsPage();
    // The rail owns the run list; the dashboard sidebar is a kind launcher.
    screen.getByText("Your workflows");
    screen.getByRole("button", { name: "View all runs" });
  });

  it("pivots to a New-run empty state when there are zero runs", () => {
    runsResult = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderWorkflowsPage();
    screen.getByText(/no workflows yet/i);
    screen.getByText(/start your first workflow/i);
    expect(
      screen.getAllByRole("button", { name: /new run/i }).length,
    ).toBeGreaterThan(1);
  });

  it("favoriting a kind persists to localStorage and toggles aria-pressed", () => {
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
    renderWorkflowsPage();
    const star = screen.getByLabelText("Favorite Deck build");
    expect(star.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(star);

    expect(localStorage.getItem("workflow-favorite-kinds")).toBe(
      JSON.stringify(["deck-build"]),
    );
    expect(
      screen.getAllByLabelText("Remove from favorites").length,
    ).toBeGreaterThan(0);
  });
});
