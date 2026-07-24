/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ScheduledTrigger, WorkflowCatalogEntry } from "@workbench/shared";

const updateMeSchedule = mock(
  async (id: string, patch: Record<string, unknown>) => ({
    id,
    ...patch,
  }),
);
const deleteMeSchedule = mock(async () => undefined);
const startApi = mock(async () => ({
  runId: "run-new-1",
  kind: "last30days-research",
  status: "running",
  createdAt: new Date().toISOString(),
}));

mock.module("../../lib/hub-api", () => ({
  listMeSchedules: mock(async () => []),
  createMeSchedule: mock(async () => ({})),
  updateMeSchedule,
  deleteMeSchedule,
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

// useStartWorkflow goes through the generic `api` helper; stub the whole hook
// module so we don't need a full hub HTTP stack.
const startMutateAsync = mock(
  async (vars: { kind: string; input: unknown }) => {
    const res = await startApi(vars);
    return res;
  },
);

mock.module("../../hooks/use-workflow", () => ({
  useStartWorkflow: () => ({
    mutateAsync: startMutateAsync,
    isPending: false,
    variables: undefined,
  }),
}));

const { ConnectedScheduleInspector } = await import(
  "./ConnectedScheduleInspector"
);

const catalogEntry: WorkflowCatalogEntry = {
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
  intakeFields: [
    {
      name: "topic",
      label: "Topic",
      inputHint: "text",
      required: true,
      order: 0,
    },
  ],
};

const schedule: ScheduledTrigger = {
  id: "sched-1",
  workflowKind: "last30days-research",
  name: "Weekly research",
  recurrence: { intervalMinutes: 10080, anchorMinuteUtc: 9 * 60 },
  enabled: true,
  scope: "personal",
  ownerMemberPrincipalId: "p1",
  triggerPayload: { topic: "AI agents" },
  createdAt: new Date().toISOString(),
  lastRunId: "run-old",
  recentFires: [
    {
      runId: "run-old",
      firedAt: "2026-01-10T09:00:00.000Z",
      status: "completed",
    },
  ],
  nextFireAt: "2099-01-12T09:00:00.000Z",
};

function renderInspector(
  props?: Partial<React.ComponentProps<typeof ConnectedScheduleInspector>>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onRemoved = mock(() => {});
  const onRunStarted = mock((_runId: string) => {});
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConnectedScheduleInspector
          schedule={schedule}
          catalogEntry={catalogEntry}
          onRemoved={onRemoved}
          onRunStarted={onRunStarted}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onRemoved, onRunStarted };
}

afterEach(() => {
  cleanup();
  updateMeSchedule.mockClear();
  deleteMeSchedule.mockClear();
  startApi.mockClear();
  startMutateAsync.mockClear();
});

describe("ConnectedScheduleInspector", () => {
  it("renders view mode with cadence, actions, and recent fires", async () => {
    renderInspector();
    expect(screen.getByTestId("connected-schedule-inspector")).toBeTruthy();
    expect(screen.getByText("Last 30 Days Research")).toBeTruthy();
    expect(screen.getByText("Weekly research")).toBeTruthy();
    expect(screen.getByTestId("schedule-edit")).toBeTruthy();
    expect(screen.getByTestId("schedule-run-now")).toBeTruthy();
    expect(screen.getByTestId("pause-resume-schedule")).toBeTruthy();
    expect(screen.getByTestId("remove-schedule")).toBeTruthy();
    expect(screen.getByTestId("schedule-run-history-sched-1")).toBeTruthy();
    expect(screen.getByText(/Once a week/i)).toBeTruthy();
  });

  it("pauses via useUpdateSchedule", async () => {
    renderInspector();
    fireEvent.click(screen.getByTestId("pause-resume-schedule"));
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [id, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { enabled: boolean },
    ];
    expect(id).toBe("sched-1");
    expect(patch.enabled).toBe(false);
  });

  it("removes the schedule and calls onRemoved", async () => {
    const { onRemoved } = renderInspector();
    fireEvent.click(screen.getByTestId("remove-schedule"));
    await waitFor(() => {
      expect(deleteMeSchedule).toHaveBeenCalledWith("sched-1");
    });
    await waitFor(() => {
      expect(onRemoved).toHaveBeenCalled();
    });
  });

  it("runs now with the schedule trigger payload and reports the run id", async () => {
    const { onRunStarted } = renderInspector();
    fireEvent.click(screen.getByTestId("schedule-run-now"));
    await waitFor(() => {
      expect(startMutateAsync).toHaveBeenCalled();
    });
    const vars = startMutateAsync.mock.calls[0]![0] as {
      kind: string;
      input: unknown;
    };
    expect(vars.kind).toBe("last30days-research");
    expect(vars.input).toEqual({ topic: "AI agents" });
    await waitFor(() => {
      expect(onRunStarted).toHaveBeenCalledWith("run-new-1");
    });
  });

  it("enters edit mode via ScheduleFlow and saves recurrence", async () => {
    renderInspector();
    fireEvent.click(screen.getByTestId("schedule-edit"));
    expect(
      screen.getByTestId("connected-schedule-inspector-edit"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("schedule-editor-last30days-research"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [id, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { recurrence: { intervalMinutes: number }; payload?: unknown },
    ];
    expect(id).toBe("sched-1");
    expect(patch.recurrence.intervalMinutes).toBe(10080);
    expect(patch.payload).toEqual({ topic: "AI agents" });

    await waitFor(() => {
      expect(screen.getByTestId("connected-schedule-inspector")).toBeTruthy();
    });
  });

  it("cancel returns to view mode without saving", async () => {
    renderInspector();
    fireEvent.click(screen.getByTestId("schedule-edit"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByTestId("connected-schedule-inspector")).toBeTruthy();
    expect(updateMeSchedule).not.toHaveBeenCalled();
  });

  it("shows Resume when the schedule is paused", () => {
    renderInspector({
      schedule: { ...schedule, enabled: false, nextFireAt: null },
    });
    expect(screen.getByTestId("pause-resume-schedule").textContent).toMatch(
      /Resume/i,
    );
  });

  it("renders scope as plain read-only metadata, not an input, in view mode", () => {
    renderInspector();
    const panel = screen.getByTestId("connected-schedule-inspector");
    expect(screen.getAllByText("Just me").length).toBeGreaterThan(0);
    // View mode is entirely read-only — nothing should render as an <input>
    // (that's reserved for the Edit flow), so Scope can't look editable.
    expect(panel.querySelectorAll("input").length).toBe(0);
  });

  it("edits the schedule name through an input under Edit and saves it", async () => {
    renderInspector();
    fireEvent.click(screen.getByTestId("schedule-edit"));

    const nameInput = screen.getByTestId(
      "schedule-name-input-last30days-research",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Weekly research");

    fireEvent.change(nameInput, { target: { value: "My custom label" } });
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));

    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [id, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { name?: string },
    ];
    expect(id).toBe("sched-1");
    expect(patch.name).toBe("My custom label");
  });

  it("clearing the name field resets it to the workflow kind default", async () => {
    renderInspector();
    fireEvent.click(screen.getByTestId("schedule-edit"));

    const nameInput = screen.getByTestId(
      "schedule-name-input-last30days-research",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));

    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { name?: string },
    ];
    expect(patch.name).toBe("last30days-research");
  });
});
