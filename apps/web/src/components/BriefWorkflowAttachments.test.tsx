/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { BriefWorkflowAttachments } from "./BriefWorkflowAttachments";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const catalog = {
  entries: [
    {
      kind: "heartbeat",
      label: "Company Heartbeat",
      isFavorite: false,
      stepCount: 4,
      pauseCount: 0,
      steps: [],
    },
    {
      kind: "last30days-research",
      label: "Last 30 Days",
      isFavorite: false,
      stepCount: 3,
      pauseCount: 0,
      steps: [],
    },
  ],
};

const preferenceSettings = [
  {
    key: "briefHourUtc",
    type: "hourUtc",
    default: 13,
    label: "Morning brief time",
    description: "",
    category: "Automations",
    value: 13,
  },
];

function makeFetch(
  initialSchedules: Record<string, unknown>[],
  onCreate?: (body: unknown) => void,
) {
  let schedules = [...initialSchedules];
  return mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/me/schedules")) {
      if (method === "GET")
        return Promise.resolve(jsonResponse({ items: schedules }));
      if (method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        onCreate?.(body);
        const created = {
          id: `sch_${schedules.length + 1}`,
          workflowKind: body.kind,
          hourUtc: body.hourUtc,
          enabled: true,
          triggerPayload: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        schedules = [...schedules, created];
        return Promise.resolve(jsonResponse(created, 201));
      }
    }
    if (url.includes("/workflows")) {
      return Promise.resolve(jsonResponse(catalog));
    }
    if (url.includes("/preferences/settings")) {
      return Promise.resolve(jsonResponse({ settings: preferenceSettings }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderAttachments() {
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
      React.createElement(BriefWorkflowAttachments, { tenantId: "tenant-1" }),
    ),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("BriefWorkflowAttachments", () => {
  it("shows the empty state and excludes heartbeat from the attach picker", async () => {
    globalThis.fetch = makeFetch([]) as unknown as typeof fetch;
    renderAttachments();
    await waitFor(() =>
      screen.getByText("No workflows attached to your brief yet."),
    );
    expect(screen.queryByText("Company Heartbeat")).toBeNull();
    expect(screen.getByText("Last 30 Days")).toBeDefined();
  });

  it("attaches a workflow at the member's brief hour via POST", async () => {
    let created: unknown = null;
    globalThis.fetch = makeFetch([], (body) => {
      created = body;
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderAttachments();

    await screen.findByText("Last 30 Days");
    await user.selectOptions(
      screen.getByLabelText("Choose a workflow to attach"),
      "last30days-research",
    );
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toEqual({ kind: "last30days-research", hourUtc: 13 });
  });

  it("lists an already-attached workflow and omits it from the picker", async () => {
    globalThis.fetch = makeFetch([
      {
        id: "sch_1",
        workflowKind: "last30days-research",
        hourUtc: 13,
        enabled: true,
        triggerPayload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]) as unknown as typeof fetch;
    renderAttachments();

    await waitFor(() => screen.getByText("Last 30 Days"));
    expect(screen.queryByLabelText("Choose a workflow to attach")).toBeNull();
  });
});
