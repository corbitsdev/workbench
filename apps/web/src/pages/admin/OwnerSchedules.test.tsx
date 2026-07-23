/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const getOwnerSchedules = mock(
  async () => [] as Array<Record<string, unknown>>,
);
const updateOwnerSchedule = mock(
  async (
    _id: string,
    _body: {
      enabled?: boolean;
      recurrence?: { intervalMinutes: number; anchorMinuteUtc: number };
    },
  ) => ({}),
);

mock.module("../../lib/hub-api", () => ({
  getOwnerSchedules,
  updateOwnerSchedule,
}));

const { OwnerSchedules } = await import("./OwnerSchedules");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(OwnerSchedules),
    ),
  );
}

describe("OwnerSchedules", () => {
  beforeEach(() => {
    getOwnerSchedules.mockReset();
    updateOwnerSchedule.mockReset();
    getOwnerSchedules.mockResolvedValue([]);
    updateOwnerSchedule.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("explains Everyone semantics and empty state", async () => {
    getOwnerSchedules.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Everyone");
    });
    expect(document.body.textContent).toContain("No Everyone schedules yet");
  });

  it("lists a tenant schedule with pause control", async () => {
    getOwnerSchedules.mockResolvedValue([
      {
        id: "sch_1",
        workflowKind: "deck",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 14 * 60 },
        enabled: true,
        scope: "tenant",
        lastRunId: null,
        nextFireAt: "2026-07-22T14:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
        recentFires: [],
      },
    ]);
    renderPage();
    await waitFor(() => {
      expect(document.body.textContent).toContain("deck");
    });
    expect(document.body.textContent).toContain("Pause");
  });
});
