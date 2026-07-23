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
import { MemoryRouter, useLocation } from "react-router";
import { PageChromeProvider, usePageChromeSlot } from "../lib/page-chrome";

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
      intakeFields: [
        {
          name: "topic",
          label: "Topic",
          inputHint: "text" as const,
          required: true,
          order: 0,
        },
      ],
    },
    {
      kind: "manual-only",
      label: "Manual",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [],
      attachable: false,
      allowedScopes: ["personal"] as ("personal" | "tenant")[],
      defaultScope: "personal" as const,
      intakeFields: [],
    },
    {
      kind: "gamma",
      label: "Gamma Presentation Creator",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [],
      attachable: true,
      allowedScopes: ["personal", "tenant"] as ("personal" | "tenant")[],
      defaultScope: "personal" as const,
      intakeFields: [],
    },
  ],
}));

const listMeSchedules = mock(async () => [
  {
    id: "sched-1",
    workflowKind: "heartbeat",
    name: "heartbeat",
    recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 14 * 60 },
    enabled: true,
    scope: "personal" as const,
    ownerMemberPrincipalId: "p1",
    triggerPayload: { reason: "scheduled-heartbeat" },
    createdAt: new Date().toISOString(),
    lastRunId: null,
    recentFires: [],
    nextFireAt: null,
  },
]);

const createMeSchedule = mock(async (body: unknown) => body);
const updateMeSchedule = mock(async (_id: string, patch: unknown) => patch);
const deleteMeSchedule = mock(async () => undefined);

mock.module("../lib/hub-api", () => ({
  getWorkflowsCatalog,
  listMeSchedules,
  createMeSchedule,
  updateMeSchedule,
  deleteMeSchedule,
}));

const { RoutinesPage } = await import("./RoutinesPage");

function ChromeSlotProbe() {
  return <div data-testid="chrome-slot">{usePageChromeSlot()}</div>;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-pathname">{location.pathname}</div>;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/routines"]}>
        <PageChromeProvider>
          <ChromeSlotProbe />
          <LocationProbe />
          <RoutinesPage />
        </PageChromeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the "+ New Routine" picker and pick a workflow kind. */
function startNewRoutine(kind: string) {
  fireEvent.click(screen.getByTestId("new-routine-button"));
  fireEvent.click(screen.getByTestId(`routine-picker-option-${kind}`));
}

afterEach(() => {
  cleanup();
  createMeSchedule.mockClear();
  updateMeSchedule.mockClear();
});

describe("RoutinesPage (CL-4277 schedule-driven rows, list + detail)", () => {
  it("lists only actual schedules, not every catalog kind", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("routine-row-sched-1")).toBeTruthy();
    });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.queryByText("Manual")).toBeNull();
    expect(screen.getByText(/Scheduled/)).toBeTruthy();
    // No placeholder rows for unscheduled kinds like the research workflow.
    expect(screen.queryByTestId("routine-row-last30days-research")).toBeNull();
    expect(screen.queryByText("Not scheduled")).toBeNull();
  });

  it("clicking a schedule row navigates to its own detail page", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("routine-row-sched-1"));
    fireEvent.click(screen.getByTestId("routine-row-sched-1"));
    await waitFor(() => {
      expect(screen.getByTestId("location-pathname").textContent).toBe(
        "/routines/sched-1",
      );
    });
  });

  it("renders two schedules of the same kind as distinct rows, each linking to its own id", async () => {
    listMeSchedules.mockImplementationOnce(async () => [
      {
        id: "sched-a",
        workflowKind: "last30days-research",
        name: "last30days-research",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
        enabled: true,
        scope: "personal" as const,
        ownerMemberPrincipalId: "p1",
        triggerPayload: { topic: "AI agents" },
        createdAt: new Date().toISOString(),
        lastRunId: null,
        recentFires: [],
        nextFireAt: null,
      },
      {
        id: "sched-b",
        workflowKind: "last30days-research",
        name: "last30days-research 2",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 17 * 60 },
        enabled: true,
        scope: "personal" as const,
        ownerMemberPrincipalId: "p1",
        triggerPayload: { topic: "Robotics" },
        createdAt: new Date().toISOString(),
        lastRunId: null,
        recentFires: [],
        nextFireAt: null,
      },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("routine-row-sched-a")).toBeTruthy();
      expect(screen.getByTestId("routine-row-sched-b")).toBeTruthy();
    });
    expect(screen.getByText("last30days-research 2")).toBeTruthy();

    fireEvent.click(screen.getByTestId("routine-row-sched-a"));
    await waitFor(() => {
      expect(screen.getByTestId("location-pathname").textContent).toBe(
        "/routines/sched-a",
      );
    });

    fireEvent.click(screen.getByTestId("routine-row-sched-b"));
    await waitFor(() => {
      expect(screen.getByTestId("location-pathname").textContent).toBe(
        "/routines/sched-b",
      );
    });
  });

  it("creates a research schedule with form payload via New Routine → picker → flow", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("new-routine-button"));
    startNewRoutine("last30days-research");
    await waitFor(() =>
      screen.getByTestId("schedule-editor-last30days-research"),
    );
    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "AI agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => {
      expect(createMeSchedule).toHaveBeenCalled();
    });
    const body = createMeSchedule.mock.calls[0]?.[0] as {
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(body.kind).toBe("last30days-research");
    expect(body.payload).toEqual({ topic: "AI agents" });
  });

  it("creates a tenant-scoped schedule when the kind allows Everyone", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("new-routine-button"));
    startNewRoutine("gamma");
    await waitFor(() => screen.getByTestId("schedule-editor-gamma"));
    fireEvent.click(screen.getByRole("radio", { name: /everyone/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => {
      expect(createMeSchedule).toHaveBeenCalled();
    });
    const body = createMeSchedule.mock.calls[0]?.[0] as {
      kind: string;
      scope: string;
    };
    expect(body.kind).toBe("gamma");
    expect(body.scope).toBe("tenant");
  });

  it("does not offer a scope step for a personal-only kind", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("new-routine-button"));
    startNewRoutine("last30days-research");
    await waitFor(() =>
      screen.getByTestId("schedule-editor-last30days-research"),
    );
    expect(screen.queryByText(/Who is this for/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "AI agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => {
      expect(createMeSchedule).toHaveBeenCalled();
    });
    const body = createMeSchedule.mock.calls[0]?.[0] as { scope: string };
    expect(body.scope).toBe("personal");
  });

  it("picking a kind that already has a schedule creates an additional one", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("routine-row-sched-1"));
    startNewRoutine("heartbeat");
    await waitFor(() => screen.getByTestId("schedule-editor-heartbeat"));
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => {
      expect(createMeSchedule).toHaveBeenCalled();
    });
    const body = createMeSchedule.mock.calls[0]?.[0] as { kind: string };
    expect(body.kind).toBe("heartbeat");
  });
});
