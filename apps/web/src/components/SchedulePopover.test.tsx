/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SchedulePopover } from "./SchedulePopover";
import { localHourToUtc } from "../lib/schedule-time";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const existingSchedule = {
  id: "sch_1",
  workflowKind: "morning-brief",
  hourUtc: 13,
  enabled: true,
  triggerPayload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  lastFiredDayUtc: null,
  nextFireAt: "2026-01-02T13:00:00.000Z",
};

function makeFetch(
  schedules: unknown[],
  onMutate?: (url: string, init: RequestInit) => void,
) {
  return mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/me/schedules")) {
      if (method === "GET")
        return Promise.resolve(jsonResponse({ items: schedules }));
      onMutate?.(url, init as RequestInit);
      return Promise.resolve(jsonResponse(existingSchedule, 201));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderPopover() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SchedulePopover, {
        kind: "morning-brief",
        label: "Morning Brief",
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("SchedulePopover", () => {
  it("creates a schedule via POST with the workflow kind and picked UTC hour", async () => {
    let body: unknown = null;
    globalThis.fetch = makeFetch([], (_url, init) => {
      if (init.method === "POST") body = JSON.parse(init.body as string);
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Schedule" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      kind: "morning-brief",
      hourUtc: localHourToUtc(8),
    });
  });

  it("surfaces the existing schedule and pauses it via PATCH", async () => {
    let patch: { url: string; body: unknown } | null = null;
    globalThis.fetch = makeFetch([existingSchedule], (url, init) => {
      if (init.method === "PATCH")
        patch = { url, body: JSON.parse(init.body as string) };
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPopover();

    // Trigger reflects the scheduled state once the list loads.
    const trigger = await screen.findByRole("button", { name: /Scheduled/ });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    // The create action is replaced by pause/resume for an existing schedule.
    expect(
      within(dialog).queryByRole("button", { name: "Schedule" }),
    ).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(patch).not.toBeNull());
    expect(patch!.url).toContain("/me/schedules/sch_1");
    expect(patch!.body).toEqual({ enabled: false });
  });
});
