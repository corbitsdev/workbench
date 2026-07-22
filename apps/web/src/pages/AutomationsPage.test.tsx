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
  ],
}));

const listMeSchedules = mock(async () => [
  {
    id: "sched-1",
    workflowKind: "heartbeat",
    hourUtc: 14,
    enabled: true,
    scope: "personal" as const,
    ownerMemberPrincipalId: "p1",
    triggerPayload: { reason: "scheduled-heartbeat" },
    createdAt: new Date().toISOString(),
    lastFiredDayUtc: null,
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

const { AutomationsPage } = await import("./AutomationsPage");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutomationsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  createMeSchedule.mockClear();
  updateMeSchedule.mockClear();
});

describe("AutomationsPage (CL-3862)", () => {
  it("lists schedulable workflows with Morning brief product name and status", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("automations-page")).toBeTruthy();
      expect(screen.getByTestId("automation-row-heartbeat")).toBeTruthy();
      expect(
        screen.getByTestId("automation-row-last30days-research"),
      ).toBeTruthy();
    });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.queryByText("Manual")).toBeNull();
    expect(screen.getByText(/Scheduled/)).toBeTruthy();
    expect(screen.getByText("Not scheduled")).toBeTruthy();
  });

  it("creates a research schedule with form payload", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("schedule-last30days-research"));
    fireEvent.click(screen.getByTestId("schedule-last30days-research"));
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

  it("hour-only edit does not send empty payload for heartbeat", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("edit-schedule-heartbeat"));
    fireEvent.click(screen.getByTestId("edit-schedule-heartbeat"));
    await waitFor(() => screen.getByTestId("schedule-editor-heartbeat"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { hourUtc?: number; payload?: unknown },
    ];
    expect(patch.hourUtc).toBeDefined();
    expect(patch.payload).toBeUndefined();
  });
});
