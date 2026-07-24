/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  PageChromeProvider,
  usePageChromeSlot,
  useSetPageChrome,
} from "../lib/page-chrome";

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

const getWorkflowsCatalog = mock(async () => ({
  entries: [
    {
      kind: "heartbeat",
      label: "Morning brief",
      description: "Daily brief",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [],
      attachable: true,
      allowedScopes: ["personal"] as ("personal" | "tenant")[],
      defaultScope: "personal" as const,
      intakeFields: [],
    },
    {
      kind: "last30days-research",
      label: "Last 30 Days Research",
      description: "Research topic",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [],
      attachable: true,
      allowedScopes: ["personal"] as ("personal" | "tenant")[],
      defaultScope: "personal" as const,
      intakeFields: [],
    },
  ],
}));

const listMeSchedules = mock(async () => [
  {
    id: "sched-1",
    workflowKind: "heartbeat",
    name: "Morning",
    recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 14 * 60 },
    enabled: true,
    scope: "personal" as const,
    ownerMemberPrincipalId: "p1",
    triggerPayload: {},
    createdAt: new Date().toISOString(),
    lastRunId: null,
    recentFires: [],
    nextFireAt: "2099-01-05T14:00:00.000Z",
  },
  {
    id: "sched-2",
    workflowKind: "last30days-research",
    name: "last30days-research",
    recurrence: { intervalMinutes: 10080, anchorMinuteUtc: 9 * 60 },
    enabled: false,
    scope: "tenant" as const,
    ownerMemberPrincipalId: "p1",
    triggerPayload: {},
    createdAt: new Date().toISOString(),
    lastRunId: null,
    recentFires: [],
    nextFireAt: null,
  },
]);

const createMeSchedule = mock(async () => ({
  id: "sched-new",
  workflowKind: "heartbeat",
  name: "Morning brief",
  recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 14 * 60 },
  enabled: true,
  scope: "personal" as const,
  ownerMemberPrincipalId: "p1",
  triggerPayload: {},
  createdAt: new Date().toISOString(),
  lastRunId: null,
  recentFires: [],
  nextFireAt: "2099-01-06T14:00:00.000Z",
}));

mock.module("../lib/hub-api", () => ({
  getWorkflowsCatalog,
  listMeSchedules,
  createMeSchedule,
  updateMeSchedule: mock(async () => ({})),
  deleteMeSchedule: mock(async () => undefined),
  patchMePreferences: mock(async () => ({ preferences: {} })),
}));

const runs = [
  {
    runId: "run-live-1",
    kind: "heartbeat",
    status: "running",
    createdAt: new Date(Date.now() - 62_000).toISOString(),
  },
  {
    runId: "run-await-1",
    kind: "last30days-research",
    status: "awaiting",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    runId: "run-done-1",
    kind: "heartbeat",
    status: "completed",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
  },
];

const startWorkflowMutateAsync = mock(async () => ({ runId: "run-new" }));

mock.module("../hooks/use-workflow", () => ({
  useWorkflowRuns: () => ({
    data: runs,
    isPending: false,
    isError: false,
    isLoading: false,
  }),
  useStartWorkflow: () => ({
    mutateAsync: startWorkflowMutateAsync,
    isPending: false,
  }),
}));

mock.module("./workflows/ConnectedScheduleInspector", () => ({
  ConnectedScheduleInspector: ({
    schedule,
  }: {
    schedule: { id: string; name: string };
  }) => (
    <div data-testid="schedule-inspector-connected">Schedule {schedule.id}</div>
  ),
}));

// Mirrors the real WorkflowRunPane's page-chrome contract (CL-4420: it
// publishes chrome via `useSetPageChrome(node, !embedded)` so an embedded
// pane never touches the host's chrome slot). This mock exists to keep this
// file's WorkflowsPage-level integration light — it does not itself prove the
// production fix, since it hardcodes the same `!embedded` gate rather than
// importing WorkflowRunPane.tsx's logic. That proof (the pane's own
// conditional actually reverting the host's chrome when the `enabled` gate is
// removed) lives in WorkflowRunPane.test.tsx's "does not clear a host page's
// chrome when embedded (CL-4420)" test, which renders the REAL component.
mock.module("../components/WorkflowRunPane", () => ({
  WorkflowRunPane: ({
    deploymentId,
    embedded,
  }: {
    deploymentId: string;
    embedded?: boolean;
  }) => {
    useSetPageChrome(
      <div data-testid="run-pane-chrome">Run chrome {deploymentId}</div>,
      !embedded,
    );
    return (
      <div
        data-testid="live-run-inspector-pane"
        data-embedded={embedded ? "true" : "false"}
      >
        Run {deploymentId}
      </div>
    );
  },
}));

const { WorkflowsPage } = await import("./WorkflowsPage");

function ChromeSlotProbe() {
  return <div data-testid="chrome-slot">{usePageChromeSlot()}</div>;
}

afterEach(() => {
  cleanup();
  activeTenantId = "ten-1";
  getWorkflowsCatalog.mockClear();
  listMeSchedules.mockClear();
  createMeSchedule.mockClear();
  startWorkflowMutateAsync.mockClear();
});

function renderWorkflowsPage(initialPath = "/workflows") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // ChromeSlotProbe is a sibling of the page under PageChromeProvider (same
  // pattern as RoutinesPage.test) so published chrome is visible to assertions.
  const router = createMemoryRouter(
    [
      {
        path: "/workflows",
        element: <WorkflowsPage />,
      },
      {
        path: "/workflows/:workflowId",
        element: <WorkflowsPage />,
      },
    ],
    { initialEntries: [initialPath] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <PageChromeProvider>
        <ChromeSlotProbe />
        <RouterProvider router={router} />
      </PageChromeProvider>
    </QueryClientProvider>,
  );
  return { router, ...view };
}

describe("WorkflowsPage", () => {
  it("renders Live and Scheduled sections from real data", async () => {
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    });
    expect(screen.getByText(/Live ·/)).toBeTruthy();
    expect(screen.getByText(/Scheduled ·/)).toBeTruthy();
    expect(screen.getAllByText("Morning brief").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getAllByText("Last 30 Days Research").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows New Workflow CTA and empty inspector until selection", async () => {
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-button")).toBeTruthy();
    });
    expect(screen.getByText("Select a workflow")).toBeTruthy();
  });

  it("lays out the New Workflow action as a horizontal row, not a stacked column", async () => {
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    });
    // This guarantee now comes from the shared Button `size="sm"` variant
    // (packages/ui/src/Button.tsx), not a per-call-site className override.
    const button = screen.getByTestId("new-workflow-button");
    expect(button.className).toContain("flex");
    expect(button.className).toContain("items-center");
  });

  it("always publishes the Workflows page-chrome title, across list/new/schedule/run states (CL-4420)", async () => {
    // Regression: the top-bar title used to disappear once a run's embedded
    // WorkflowRunPane cleared the shared chrome slot (see WorkflowRunPane's
    // useSetPageChrome(record ? runChrome : null, !embedded) and
    // page-chrome.test.tsx for the mechanism-level test). Assert the actual
    // chrome value WorkflowsPage publishes, not just rendered DOM text, since
    // the AppTopBar chrome slot is what a real regression would blank out.
    //
    // The `?run=` case below is the one that actually exercises the fix: the
    // mocked WorkflowRunPane (above) mirrors the real component's
    // `useSetPageChrome(node, !embedded)` call, and WorkflowsPage always
    // mounts it with `embedded`. Before the fix this branch published `null`
    // unconditionally and clobbered "Workflows" — see WorkflowRunPane.test.tsx
    // for the same assertion against the REAL component (the mock here only
    // proves the WorkflowsPage-level wiring, not the pane's own logic).
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    });
    await waitFor(() => {
      const slot = screen.getByTestId("chrome-slot");
      expect(slot.textContent).toContain("Workflows");
    });
    cleanup();

    renderWorkflowsPage("/workflows?new=1");
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-picker")).toBeTruthy();
    });
    await waitFor(() => {
      const slot = screen.getByTestId("chrome-slot");
      expect(slot.textContent).toContain("Workflows");
    });
    cleanup();

    renderWorkflowsPage("/workflows?schedule=sched-1");
    await waitFor(() => {
      expect(screen.getByTestId("schedule-inspector-connected")).toBeTruthy();
    });
    await waitFor(() => {
      const slot = screen.getByTestId("chrome-slot");
      expect(slot.textContent).toContain("Workflows");
    });
    cleanup();

    renderWorkflowsPage("/workflows?run=run-live-1");
    await waitFor(() => {
      expect(screen.getByTestId("live-run-inspector-pane")).toBeTruthy();
    });
    await waitFor(() => {
      const slot = screen.getByTestId("chrome-slot");
      expect(slot.textContent).toContain("Workflows");
    });
    expect(screen.queryByTestId("run-pane-chrome")).toBeNull();
  });

  it("selects a schedule from ?schedule= and shows schedule inspector", async () => {
    renderWorkflowsPage("/workflows?schedule=sched-1");
    await waitFor(() => {
      expect(screen.getByTestId("schedule-inspector-connected")).toBeTruthy();
    });
    expect(screen.getByText("Schedule sched-1")).toBeTruthy();
  });

  it("selects a live run from path and shows live inspector", async () => {
    renderWorkflowsPage("/workflows/run-live-1");
    await waitFor(() => {
      expect(screen.getByTestId("live-run-inspector")).toBeTruthy();
    });
    // List stays mounted — path opens inspector, not a full-page takeover.
    expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    const pane = screen.getByTestId("live-run-inspector-pane");
    expect(pane).toBeTruthy();
    expect(pane.getAttribute("data-embedded")).toBe("true");
    expect(screen.getByText("Run run-live-1")).toBeTruthy();
  });

  it("selects a live run from ?run= query the same way", async () => {
    renderWorkflowsPage("/workflows?run=run-live-1");
    await waitFor(() => {
      expect(screen.getByTestId("live-run-inspector")).toBeTruthy();
    });
    expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    expect(screen.getByText("Run run-live-1")).toBeTruthy();
  });

  it("filters to Needs you live rows", async () => {
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByText(/Live ·/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Needs you" }));
    await waitFor(() => {
      expect(screen.queryByText(/Scheduled ·/)).toBeNull();
    });
    expect(screen.getAllByText("Needs you").length).toBeGreaterThanOrEqual(1);
  });

  it("does not render the old catalog surface or Routines link", async () => {
    renderWorkflowsPage();
    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Workflows" })).toBeTruthy();
    });
    expect(screen.queryByTestId("workflow-catalog-surface")).toBeNull();
    expect(screen.queryByRole("link", { name: "Routines" })).toBeNull();
  });

  it("opens the kind picker via ?new=1 with already-on badges", async () => {
    renderWorkflowsPage("/workflows?new=1");
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-picker")).toBeTruthy();
    });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.getByText("Last 30 Days Research")).toBeTruthy();
    expect(screen.getByText(/Mine 1/)).toBeTruthy();
    expect(screen.getByText(/Everyone 1/)).toBeTruthy();
  });

  it("selects a kind and shows the create form defaulted to run-once", async () => {
    renderWorkflowsPage("/workflows?new=1");
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-picker")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Morning brief"));
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-create-heartbeat")).toBeTruthy();
    });
    expect(screen.getByTestId("run-once-primary")).toBeTruthy();
    expect(screen.getByText("Summary")).toBeTruthy();

    fireEvent.click(screen.getByTestId("run-mode-schedule"));
    await waitFor(() => {
      expect(screen.getByTestId("schedule-flow-primary")).toBeTruthy();
    });
  });

  it("runs a workflow once and navigates to the run", async () => {
    const { router } = renderWorkflowsPage("/workflows?new=1&kind=heartbeat");
    await waitFor(() => {
      expect(screen.getByTestId("run-once-primary")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("run-once-primary"));
    await waitFor(() => {
      expect(router.state.location.search).toContain("run=run-new");
    });
    expect(router.state.location.search).not.toContain("new=");
    expect(createMeSchedule).not.toHaveBeenCalled();
    expect(startWorkflowMutateAsync).toHaveBeenCalledWith({
      kind: "heartbeat",
      input: {},
    });
  });

  it("switches to schedule mode and creates a schedule", async () => {
    const { router } = renderWorkflowsPage("/workflows?new=1&kind=heartbeat");
    await waitFor(() => {
      expect(screen.getByTestId("new-workflow-create-heartbeat")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("run-mode-schedule"));
    await waitFor(() => {
      expect(screen.getByTestId("schedule-flow-primary")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    await waitFor(() => {
      expect(createMeSchedule).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(router.state.location.search).toContain("schedule=sched-new");
    });
    expect(router.state.location.search).not.toContain("new=");
  });
});
