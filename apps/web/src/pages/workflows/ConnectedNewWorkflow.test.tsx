/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScheduledTrigger, WorkflowCatalogEntry } from "@workbench/shared";

const createMutateAsync = mock(async () => ({ id: "sched-new-1" }));

mock.module("../../hooks/use-schedules", () => ({
  useCreateSchedule: () => ({
    mutateAsync: createMutateAsync,
    isPending: false,
  }),
}));

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: null,
    activeTenantId: "ten-1",
    setActiveWorkbench: () => {},
  }),
}));

const startWorkflowState = { isPending: false };

mock.module("../../hooks/use-workflow", () => ({
  useStartWorkflow: () => ({
    mutateAsync: mock(async () => ({ runId: "run-1" })),
    isPending: startWorkflowState.isPending,
    variables: undefined,
  }),
}));

const { ConnectedNewWorkflow } = await import("./ConnectedNewWorkflow");

const catalogEntries: WorkflowCatalogEntry[] = [
  {
    kind: "last30days-research",
    label: "Last 30 Days Research",
    description: "Research a topic over the last 30 days",
    isFavorite: false,
    stepCount: 1,
    pauseCount: 0,
    steps: [],
    attachable: true,
    allowedScopes: ["personal", "tenant"],
    defaultScope: "personal",
    intakeFields: [],
  },
];

const catalogEntry = catalogEntries[0]!;

const schedules: ScheduledTrigger[] = [];

function renderPicker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConnectedNewWorkflow
        catalogEntries={catalogEntries}
        schedules={schedules}
        selectedKind={null}
        onSelectKind={() => {}}
        onCreated={() => {}}
        onRunStarted={() => {}}
        onCancel={() => {}}
      />
    </QueryClientProvider>,
  );
}

function renderCreate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConnectedNewWorkflow
        catalogEntries={[catalogEntry]}
        schedules={[]}
        selectedKind={catalogEntry.kind}
        onSelectKind={() => {}}
        onCreated={() => {}}
        onRunStarted={() => {}}
        onCancel={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  createMutateAsync.mockClear();
  startWorkflowState.isPending = false;
});

describe("ConnectedNewWorkflow kind picker", () => {
  it("renders the picker without a Schedulable badge on any item", () => {
    renderPicker();
    expect(screen.getByTestId("new-workflow-picker")).toBeTruthy();
    expect(screen.getByText("Last 30 Days Research")).toBeTruthy();
    expect(screen.queryByText("Schedulable")).toBeNull();
  });
});

describe("ConnectedNewWorkflow create form", () => {
  it("renders the workflow title and description as a single heading, not duplicated", () => {
    renderCreate();

    // The page header is the only heading-level rendering of the title; the
    // summary card's "Kind" row separately echoes the label as data, which
    // is expected. The former bug rendered a second <h3> title + description
    // block inside the form body (RunOnceFlow/ScheduleFlow) — assert that's
    // gone by checking there is exactly one heading with this text.
    expect(
      screen.getAllByRole("heading", { name: catalogEntry.label }),
    ).toHaveLength(1);
    expect(
      screen.getAllByText(catalogEntry.description as string),
    ).toHaveLength(1);
  });

  it("shows the mode selector and Run once flow immediately below the header", () => {
    renderCreate();

    expect(screen.getByTestId("run-mode-selector")).toBeTruthy();
    expect(
      screen.getByTestId(`run-once-editor-${catalogEntry.kind}`),
    ).toBeTruthy();
  });

  it("reflects the selected mode via aria-pressed on the toggle buttons", () => {
    renderCreate();

    const onceButton = screen.getByTestId("run-mode-once");
    const scheduleButton = screen.getByTestId("run-mode-schedule");

    expect(onceButton.getAttribute("aria-pressed")).toBe("true");
    expect(scheduleButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("disables the run-mode toggle buttons while a submit is in flight", () => {
    startWorkflowState.isPending = true;
    renderCreate();

    const onceButton = screen.getByTestId("run-mode-once");
    const scheduleButton = screen.getByTestId("run-mode-schedule");

    expect(onceButton.hasAttribute("disabled")).toBe(true);
    expect(scheduleButton.hasAttribute("disabled")).toBe(true);
  });

  it("leaves the run-mode toggle buttons enabled when no submit is in flight", () => {
    renderCreate();

    const onceButton = screen.getByTestId("run-mode-once");
    const scheduleButton = screen.getByTestId("run-mode-schedule");

    expect(onceButton.hasAttribute("disabled")).toBe(false);
    expect(scheduleButton.hasAttribute("disabled")).toBe(false);
  });
});
