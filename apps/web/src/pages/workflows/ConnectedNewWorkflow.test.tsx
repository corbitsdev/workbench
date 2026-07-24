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
        onCancel={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  createMutateAsync.mockClear();
});

describe("ConnectedNewWorkflow kind picker", () => {
  it("renders the picker without a Schedulable badge on any item", () => {
    renderPicker();
    expect(screen.getByTestId("new-workflow-picker")).toBeTruthy();
    expect(screen.getByText("Last 30 Days Research")).toBeTruthy();
    expect(screen.queryByText("Schedulable")).toBeNull();
  });
});
