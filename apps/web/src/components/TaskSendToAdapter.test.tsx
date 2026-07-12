/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@workbench/shared";

import { TaskSendToAdapter } from "./TaskSendToAdapter";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    createdByPrincipalId: "principal-1",
    title: "Follow up with Acme",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

function renderSend(task: Task) {
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
      React.createElement(TaskSendToAdapter, { task }),
    ),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("TaskSendToAdapter", () => {
  it("offers a send action for each adapter the task has no ref for", () => {
    renderSend(makeTask());
    screen.getByRole("button", { name: "Send to Attio" });
    screen.getByRole("button", { name: "Send to Linear" });
  });

  it("omits the action for an adapter the task is already linked to", () => {
    renderSend(
      makeTask({
        externalRefs: [
          { adapterId: "attio", externalId: "ext-1", syncState: "synced" },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: "Send to Attio" })).toBeNull();
    screen.getByRole("button", { name: "Send to Linear" });
    screen.getByText("Attio");
  });

  it("sends the task to the adapter behind a confirm click", async () => {
    let pushed: unknown = null;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.includes("/me/tasks/task-1/push")) {
        pushed = JSON.parse((init?.body as string) ?? "{}");
        return Promise.resolve(jsonResponse({ status: "synced" }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderSend(makeTask());

    const button = screen.getByRole("button", { name: "Send to Attio" });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: /confirm send/i }));

    await waitFor(() => expect(pushed).toEqual({ adapterId: "attio" }));
  });

  it("shows a plain-language inline error to the actor on failure", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/me/tasks/task-1/push")) {
        return Promise.resolve(
          jsonResponse({ error: "downstream write failed" }, 500),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderSend(makeTask());

    await user.click(screen.getByRole("button", { name: "Send to Attio" }));
    await user.click(screen.getByRole("button", { name: /confirm send/i }));

    await waitFor(() =>
      screen.getByText("Could not send this task to Attio. Try again."),
    );
  });
});
