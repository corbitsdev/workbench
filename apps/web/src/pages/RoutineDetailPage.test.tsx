/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
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
  ],
}));

let schedules: unknown[] = [];
const listMeSchedules = mock(async () => schedules);
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

const { RoutineDetailPage } = await import("./RoutineDetailPage");

function ChromeSlotProbe() {
  return <div data-testid="chrome-slot">{usePageChromeSlot()}</div>;
}

function renderDetail(id: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/routines/${id}`]}>
        <PageChromeProvider>
          <ChromeSlotProbe />
          <Routes>
            <Route path="/routines/:id" element={<RoutineDetailPage />} />
          </Routes>
        </PageChromeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function continueUntilPrimary(label: RegExp | string) {
  for (let i = 0; i < 6; i++) {
    const primary = screen.getByTestId("schedule-flow-primary");
    if (
      primary.textContent?.match(
        typeof label === "string" ? new RegExp(label, "i") : label,
      )
    ) {
      return primary;
    }
    fireEvent.click(primary);
  }
  return screen.getByTestId("schedule-flow-primary");
}

const schedA = {
  id: "sched-a",
  workflowKind: "last30days-research",
  name: "last30days-research",
  recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
  enabled: true,
  scope: "personal" as const,
  ownerMemberPrincipalId: "p1",
  triggerPayload: { topic: "AI agents" },
  createdAt: new Date().toISOString(),
  lastRunId: "run-a1",
  recentFires: [
    { runId: "run-a1", firedAt: new Date().toISOString(), status: "completed" },
  ],
  nextFireAt: null,
};

const schedB = {
  id: "sched-b",
  workflowKind: "last30days-research",
  name: "last30days-research 2",
  recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 17 * 60 },
  enabled: true,
  scope: "personal" as const,
  ownerMemberPrincipalId: "p1",
  triggerPayload: { topic: "Robotics" },
  createdAt: new Date().toISOString(),
  lastRunId: "run-b1",
  recentFires: [
    { runId: "run-b1", firedAt: new Date().toISOString(), status: "failed" },
    { runId: "run-b2", firedAt: new Date().toISOString(), status: "failed" },
  ],
  nextFireAt: null,
};

afterEach(() => {
  cleanup();
  updateMeSchedule.mockClear();
  schedules = [];
});

describe("RoutineDetailPage (CL-4277)", () => {
  it("shows a not-found state for an id that doesn't resolve", async () => {
    schedules = [schedA];
    renderDetail("does-not-exist");
    await waitFor(() => screen.getByTestId("routine-not-found"));
  });

  it("loads a schedule's own history and edits that specific schedule, not a sibling of the same kind", async () => {
    schedules = [schedA, schedB];
    renderDetail("sched-a");
    await waitFor(() => screen.getByTestId("run-history-sched-a"));
    expect(screen.queryByTestId("run-history-sched-b")).toBeNull();
    expect(
      within(screen.getByTestId("run-history-sched-a")).getAllByRole("link")
        .length,
    ).toBe(1);

    const saveBtn = continueUntilPrimary(/save changes/i);
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [id] = updateMeSchedule.mock.calls[0] as [string, unknown];
    expect(id).toBe("sched-a");
  });

  it("a deep link straight to the second same-kind schedule loads and edits that one", async () => {
    schedules = [schedA, schedB];
    renderDetail("sched-b");
    await waitFor(() => screen.getByTestId("run-history-sched-b"));
    expect(screen.queryByTestId("run-history-sched-a")).toBeNull();
    expect(
      within(screen.getByTestId("run-history-sched-b")).getAllByRole("link")
        .length,
    ).toBe(2);

    const saveBtn = continueUntilPrimary(/save changes/i);
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [id] = updateMeSchedule.mock.calls[0] as [string, unknown];
    expect(id).toBe("sched-b");
  });

  it("shows 'not yet fired' for a schedule with no recent fires", async () => {
    schedules = [
      {
        ...schedA,
        id: "sched-c",
        lastRunId: null,
        recentFires: [],
      },
    ];
    renderDetail("sched-c");
    await waitFor(() => screen.getByTestId("run-history-sched-c"));
    expect(
      within(screen.getByTestId("run-history-sched-c")).getByText(
        /Not yet fired/,
      ),
    ).toBeTruthy();
  });
});
