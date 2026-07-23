/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

let activeTenantId: string | null = "ten-1";

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

// Stub the catalog surface: capture its props so tests can assert the page
// wires the tenant and the started-run navigation into it.
let lastCatalogSurfaceProps: {
  tenantId: string | null;
  onWorkflowStarted: (runId: string) => void;
} | null = null;
mock.module("../components/ActiveWorkflowRuns", () => ({
  ActiveWorkflowRuns: () => null,
}));

mock.module("../components/WorkflowCatalog", () => ({
  WorkflowCatalog: (props: {
    tenantId: string | null;
    onWorkflowStarted: (runId: string) => void;
  }) => {
    lastCatalogSurfaceProps = props;
    return React.createElement(
      "div",
      { "data-testid": "workflow-catalog-surface" },
      "catalog surface",
    );
  },
}));

const { WorkflowsPage } = require("./WorkflowsPage");

afterEach(() => {
  cleanup();
  activeTenantId = "ten-1";
  lastPaneTenantId = undefined;
  lastCatalogSurfaceProps = null;
});

function renderWorkflowsPage(initialPath = "/workflows") {
  const router = createMemoryRouter(
    [
      { path: "/workflows", element: React.createElement(WorkflowsPage) },
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
  it("renders the catalog surface wired to the active tenant", () => {
    activeTenantId = "ten-42";
    renderWorkflowsPage();
    screen.getByTestId("workflow-catalog-surface");
    expect(lastCatalogSurfaceProps?.tenantId).toBe("ten-42");
  });

  it("does not render run history, filters, or a New-run button", () => {
    renderWorkflowsPage();
    expect(screen.queryByLabelText("Search runs")).toBeNull();
    expect(screen.queryByRole("button", { name: /new run/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Failed" })).toBeNull();
  });

  it("points to Routines instead of embedding its own schedules list", () => {
    renderWorkflowsPage();
    const link = screen.getByRole("link", { name: "Routines" });
    expect(link.getAttribute("href")).toBe("/routines");
  });

  it("navigates to the interactive run detail when a run is started", () => {
    const { router } = renderWorkflowsPage();
    lastCatalogSurfaceProps?.onWorkflowStarted("run-new");
    expect(router.state.location.pathname).toBe("/workflows/run-new");
  });

  it("opens the run pane on a /workflows/:workflowId deep link, scoped to the tenant", () => {
    activeTenantId = "ten-7";
    renderWorkflowsPage("/workflows/run-1");
    expect(screen.getByTestId("run-pane").textContent).toBe("run-1");
    expect(lastPaneTenantId).toBe("ten-7");
    // The catalog is not mounted while a run is open.
    expect(screen.queryByTestId("workflow-catalog-surface")).toBeNull();
  });

  it("returns to the catalog when the run pane is closed", async () => {
    const { router } = renderWorkflowsPage("/workflows/run-1");
    // WorkflowRunPane is stubbed, so drive the close by navigating as it would.
    await router.navigate("/workflows");
    await screen.findByTestId("workflow-catalog-surface");
  });
});
