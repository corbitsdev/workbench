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
import { MemoryRouter } from "react-router";

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

const baseHeartbeatSchedule = {
  id: "sched-1",
  workflowKind: "heartbeat",
  recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 14 * 60 },
  enabled: true,
  scope: "personal" as const,
  ownerMemberPrincipalId: "p1",
  triggerPayload: { reason: "scheduled-heartbeat" },
  createdAt: new Date().toISOString(),
  lastRunId: null as string | null,
  recentFires: [] as { runId: string; firedAt: string; status: string }[],
  nextFireAt: null as string | null,
};

let heartbeatSchedule = baseHeartbeatSchedule;

const listMeSchedules = mock(async () => [heartbeatSchedule]);

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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RoutinesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Advance ScheduleFlow past open (+ optional intermediate) to the last step. */
function continueUntilPrimary(label: RegExp | string) {
  for (let i = 0; i < 6; i++) {
    const primary = screen.getByTestId("schedule-flow-primary");
    if (primary.textContent?.match(typeof label === "string" ? new RegExp(label, "i") : label)) {
      return primary;
    }
    fireEvent.click(primary);
  }
  return screen.getByTestId("schedule-flow-primary");
}

afterEach(() => {
  cleanup();
  createMeSchedule.mockClear();
  updateMeSchedule.mockClear();
  heartbeatSchedule = baseHeartbeatSchedule;
});

describe("RoutinesPage (CL-3862 + CL-4263 flow)", () => {
  it("lists schedulable workflows with Morning brief product name and status", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("routines-page")).toBeTruthy();
      expect(screen.getByTestId("routine-row-heartbeat")).toBeTruthy();
      expect(
        screen.getByTestId("routine-row-last30days-research"),
      ).toBeTruthy();
    });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.queryByText("Manual")).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getAllByText("Not scheduled").length).toBeGreaterThan(0);
  });

  it("expands a row to show the editor and collapses it again without losing the row", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("schedule-last30days-research"));
    expect(
      screen.queryByTestId("schedule-editor-last30days-research"),
    ).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand Last 30 Days Research"));
    await waitFor(() =>
      screen.getByTestId("schedule-editor-last30days-research"),
    );

    fireEvent.click(screen.getByLabelText("Collapse Last 30 Days Research"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("schedule-editor-last30days-research"),
      ).toBeNull();
    });
    expect(screen.getByTestId("routine-row-last30days-research")).toBeTruthy();
  });

  it("shows an honest empty run-history state for a schedule that has never fired", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("edit-schedule-heartbeat"));
    fireEvent.click(screen.getByTestId("edit-schedule-heartbeat"));
    await waitFor(() => screen.getByTestId("run-history-heartbeat"));
    expect(screen.getByText(/hasn.t triggered this routine yet/)).toBeTruthy();
  });

  it("surfaces recent fires and links to the run when one exists", async () => {
    heartbeatSchedule = {
      ...baseHeartbeatSchedule,
      lastRunId: "run-123",
      recentFires: [
        {
          runId: "run-123",
          firedAt: "2026-07-20T14:00:00.000Z",
          status: "completed",
        },
      ],
    };
    renderPage();
    await waitFor(() => screen.getByTestId("edit-schedule-heartbeat"));
    fireEvent.click(screen.getByTestId("edit-schedule-heartbeat"));
    await waitFor(() => screen.getByTestId("run-history-heartbeat"));
    expect(screen.getByText("Completed")).toBeTruthy();
    const runLink = screen.getByRole("link", { name: /Jul/ });
    expect(runLink.getAttribute("href")).toContain("run-123");
  });

  it("creates a research schedule with form payload via multi-step flow", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("schedule-last30days-research"));
    fireEvent.click(screen.getByTestId("schedule-last30days-research"));
    await waitFor(() =>
      screen.getByTestId("schedule-editor-last30days-research"),
    );
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // recurrence → inputs
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
    await waitFor(() => screen.getByTestId("schedule-gamma"));
    fireEvent.click(screen.getByTestId("schedule-gamma"));
    await waitFor(() => screen.getByTestId("schedule-editor-gamma"));
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // recurrence → availability
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
    await waitFor(() => screen.getByTestId("schedule-last30days-research"));
    fireEvent.click(screen.getByTestId("schedule-last30days-research"));
    await waitFor(() =>
      screen.getByTestId("schedule-editor-last30days-research"),
    );
    expect(screen.queryByTestId("schedule-flow-step-availability")).toBeNull();
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
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

  it("recurrence-only edit does not send empty payload for heartbeat", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("edit-schedule-heartbeat"));
    fireEvent.click(screen.getByTestId("edit-schedule-heartbeat"));
    await waitFor(() => screen.getByTestId("schedule-editor-heartbeat"));
    const saveBtn = continueUntilPrimary(/save changes/i);
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(updateMeSchedule).toHaveBeenCalled();
    });
    const [, patch] = updateMeSchedule.mock.calls[0] as [
      string,
      { recurrence?: unknown; payload?: unknown },
    ];
    expect(patch.recurrence).toBeDefined();
    expect(patch.payload).toBeUndefined();
  });
});
