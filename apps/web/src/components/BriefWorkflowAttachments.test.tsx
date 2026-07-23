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
      attachable: true,
      allowedScopes: ["personal"] as const,
      defaultScope: "personal" as const,
    },
    {
      kind: "last30days-research",
      label: "Last 30 Days",
      isFavorite: false,
      stepCount: 3,
      pauseCount: 0,
      steps: [],
      attachable: true,
      allowedScopes: ["personal", "tenant"] as const,
      defaultScope: "personal" as const,
      intakeFields: [
        { kind: "text", name: "topic", label: "Topic", required: true },
        { kind: "textarea", name: "focus", label: "Focus (optional)" },
      ],
    },
    {
      kind: "gamma-presentation-creator",
      label: "Gamma Deck",
      isFavorite: false,
      stepCount: 5,
      pauseCount: 3,
      steps: [],
      attachable: false,
      allowedScopes: ["personal"] as const,
      defaultScope: "personal" as const,
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
    category: "Routines",
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
          scope: "personal",
          ownerMemberPrincipalId: "member-1",
          triggerPayload: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          lastFiredDayUtc: null,
          lastRunId: null,
          recentFires: [],
          nextFireAt: "2026-01-02T13:00:00.000Z",
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

  it("hides a non-attachable workflow from the picker", async () => {
    globalThis.fetch = makeFetch([]) as unknown as typeof fetch;
    renderAttachments();
    await screen.findByText("Last 30 Days");
    expect(screen.queryByText("Gamma Deck")).toBeNull();
  });

  it("collects intake and sends it as the payload when attaching", async () => {
    let created: Record<string, unknown> | null = null;
    globalThis.fetch = makeFetch([], (body) => {
      created = body as Record<string, unknown>;
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderAttachments();

    await screen.findByText("Last 30 Days");
    await user.selectOptions(
      screen.getByLabelText("Choose a workflow to attach"),
      "last30days-research",
    );

    // Required topic empty → attach is blocked.
    expect(
      (screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const topic = screen.getByRole("textbox", { name: "Topic" });
    await user.type(topic, "AI agents for GTM");
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() =>
      expect(created).toEqual({
        kind: "last30days-research",
        hourUtc: 13,
        payload: { topic: "AI agents for GTM" },
      }),
    );
  });

  it("lists an already-attached workflow and omits it from the picker", async () => {
    globalThis.fetch = makeFetch([
      {
        id: "sch_1",
        workflowKind: "last30days-research",
        hourUtc: 13,
        enabled: true,
        scope: "personal",
        ownerMemberPrincipalId: "member-1",
        triggerPayload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        lastFiredDayUtc: null,
        lastRunId: null,
        recentFires: [],
        nextFireAt: "2026-01-02T13:00:00.000Z",
      },
    ]) as unknown as typeof fetch;
    renderAttachments();

    await waitFor(() => screen.getByText("Last 30 Days"));
    expect(screen.queryByLabelText("Choose a workflow to attach")).toBeNull();
  });
});
